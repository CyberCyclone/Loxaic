import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { v4 as uuid } from "uuid";
import { db, eq, inArray } from "@loxaic/db";
import { conversations, messages, runReviews, usageRecords, user, userPrefs } from "@loxaic/db/schema";
import { SUBAGENT_TOOL_NAME, parseProgressNote, type ContentBlock } from "@loxaic/types";
import type { ChatMessage, StreamOptions } from "../../../inference/provider.ts";
import { REVIEW_OUTPUT_CONTRACT } from "../review-marker.ts";

/**
 * What a progress review leaves a run that only thinks, through the real tool
 * loop against the mock model (its "think it over" prompt: every reply is
 * thinking and not a word).
 *
 * Two things a real model did that nothing here could show before. A reply a
 * review cut short is a cancelled row, which no replay sends, so the run's
 * next request held none of its work and it started again from nothing. And
 * the request made after "answer now" was watched by nobody: it thought for
 * 43 minutes and never wrote a word.
 */
process.env.MOCK_INFERENCE = "true";

/** Every request of a run (never a review's): its messages, JSON-encoded one
 * by one at call time, and what it was sent with. */
const requests: { messages: string[]; toolChoice?: string; thinking: string }[] = [];
/** Makes the model one that cannot be told to think less. */
const seam = vi.hoisted(() => ({ noThinkingLevels: false }));

vi.mock("../../../inference/provider.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../inference/provider.ts")>();
  return {
    ...actual,
    streamCompletion: (model: string, msgs: ChatMessage[], options: StreamOptions = {}) => {
      const first = msgs.at(0);
      if (!(first?.role === "system" && first.content.endsWith(REVIEW_OUTPUT_CONTRACT))) {
        requests.push({
          messages: msgs.map((m) => JSON.stringify(m)),
          toolChoice: options.toolChoice,
          thinking: JSON.stringify(options.thinking ?? {}),
        });
      }
      return actual.streamCompletion(model, msgs, options);
    },
  };
});

vi.mock("../../../inference/models.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../inference/models.ts")>();
  return {
    ...actual,
    modelRunInfo: async (ref: string) => {
      const info = await actual.modelRunInfo(ref);
      return info && seam.noThinkingLevels ? { ...info, thinking: null } : info;
    },
  };
});

const { getStreamBroker, initStreamBroker } = await import("../../index.ts");
const { getRunByConversation } = await import("../../registry.ts");
const { startAgentRun } = await import("../agentRun.ts");
const { loadHistory } = await import("../engine.ts");
const { CARRIED_REPLY_CHARS, ANSWER_UNWRITTEN_REASON } = await import("../progress-review.ts");
const { __resetMockScenariosForTest } = await import("../../../inference/mock-scenarios.ts");
const { __resetSchedulerForTest, resetSlotProbe } = await import("../../../inference/scheduler.ts");

const MODEL = "llama-3.1-8b-instruct";
/** The mock's other model: a 32K window, where the first has 4K — room for a
 * note that carries the whole `CARRIED_REPLY_CHARS`. Thinking is on or off. */
const ROOMY_MODEL = "qwen2.5-14b-instruct";
const ROOMY_THINKING_ON = JSON.stringify({ chat_template_kwargs: { enable_thinking: true } });
const DEADLINE_MS = 30_000;
const THINKING_OFF = JSON.stringify({ reasoning_effort: "none", chat_template_kwargs: { enable_thinking: false } });
const THINKING_MEDIUM = JSON.stringify({ reasoning_effort: "medium" });
const INTERRUPTED = "Your reply was interrupted. Its thinking ended with:";

function todoStep(text: string) {
  return { tool: "todo_write", args: { todos: [{ id: "1", text, status: "in_progress" }] } };
}
const steps = (n: number) => Array.from({ length: n }, (_, i) => todoStep(`Step ${String(i + 1)}`));

describe("a run that only thinks", () => {
  const userId = `test-answer-turn-${uuid()}`;
  const convIds: string[] = [];
  let dir: string;

  beforeAll(async () => {
    await initStreamBroker();
    await db.insert(user).values({
      id: userId,
      name: "Test Answer Turn",
      email: `${userId}@example.test`,
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    dir = mkdtempSync(path.join(tmpdir(), "answer-turn-"));
  });

  afterAll(async () => {
    const children = convIds.length
      ? await db.query.conversations.findMany({ where: inArray(conversations.parentConversationId, convIds), columns: { id: true } })
      : [];
    for (const id of [...convIds, ...children.map((c) => c.id)]) {
      await db.delete(messages).where(eq(messages.conversationId, id));
      await db.delete(usageRecords).where(eq(usageRecords.conversationId, id));
      await db.delete(runReviews).where(eq(runReviews.conversationId, id));
      await db.delete(conversations).where(eq(conversations.id, id));
    }
    await db.delete(userPrefs).where(eq(userPrefs.userId, userId));
    await db.delete(user).where(eq(user.id, userId));
    delete process.env.MOCK_SCENARIOS_FILE;
    __resetMockScenariosForTest();
    rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    requests.length = 0;
    seam.noThinkingLevels = false;
    // Reviewed every three steps, in the run's own slot, unless a case says
    // otherwise; and an answering reply may think for 2,000 characters, about
    // half a second of the mock's.
    await setPrefs({});
    process.env.ANSWER_THINKING_CHARS = "2000";
  });

  afterEach(async () => {
    for (const id of convIds) {
      const run = getRunByConversation(id);
      if (run) {
        run.abort.abort();
        await waitFor("a leftover run to end", () => getRunByConversation(id) === undefined);
      }
    }
    delete process.env.ANSWER_THINKING_CHARS;
    delete process.env.INFERENCE_MAX_CONCURRENT_RUNS;
    delete process.env.PROGRESS_CHECK_MS;
    resetSlotProbe();
    __resetSchedulerForTest();
  });

  async function setPrefs(values: Partial<typeof userPrefs.$inferInsert>): Promise<void> {
    const set = { progressReview: true, progressCheckMs: 8 * 60 * 60 * 1000, progressCheckSteps: 3, progressReviewPrompt: null, ...values };
    await db
      .insert(userPrefs)
      .values({ userId, ...set, updatedAt: new Date() })
      .onConflictDoUpdate({ target: userPrefs.userId, set });
  }

  async function newConversation(): Promise<string> {
    const [conv] = await db.insert(conversations).values({ ownerId: userId, title: "answer turn test", kind: "agent" }).returning();
    convIds.push(conv.id);
    return conv.id;
  }

  async function waitFor(label: string, check: () => boolean | Promise<boolean>, timeoutMs = DEADLINE_MS): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (await check()) return;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  function useScenarios(list: { match: string; steps: unknown[]; finalText: string }[]): void {
    const file = path.join(dir, `${uuid()}.json`);
    writeFileSync(file, JSON.stringify(list));
    process.env.MOCK_SCENARIOS_FILE = file;
    __resetMockScenariosForTest();
  }

  async function start(content: string, convId: string, model = MODEL): Promise<string> {
    const { streamId } = await startAgentRun({ userId, content, model, mode: "auto", conversationId: convId });
    await waitFor("the run to register", () => getRunByConversation(convId) !== undefined);
    return streamId;
  }

  async function run(content: string, convId: string, timeoutMs = DEADLINE_MS, model = MODEL): Promise<string> {
    const streamId = await start(content, convId, model);
    await waitFor("the run to end", () => getRunByConversation(convId) === undefined, timeoutMs);
    return streamId;
  }

  async function rowsOf(convId: string) {
    return db.query.messages.findMany({
      where: eq(messages.conversationId, convId),
      orderBy: (m, { asc }) => [asc(m.lamport), asc(m.createdAt)],
    });
  }

  const textOf = (content: unknown) => (content as ContentBlock[]).map((b) => (b.kind === "text" ? b.text : "")).join("");
  const thinkingOf = (content: unknown) => (content as ContentBlock[]).map((b) => (b.kind === "thinking" ? b.text : "")).join("");

  async function notesOf(convId: string) {
    return (await rowsOf(convId))
      .filter((r) => r.authorType === "user")
      .map((r) => ({ row: r, text: textOf(r.content), note: parseProgressNote(textOf(r.content)) }))
      .filter((n) => n.note !== null);
  }

  const statusOf = async (streamId: string) => (await getStreamBroker().getMeta(streamId))?.status;
  /** The requests told to answer: sent with `tool_choice: "none"`. */
  const answering = () => requests.filter((r) => r.toolChoice === "none");

  it(
    "hands a cut reply's thinking to the next request, replays it byte for byte, and gets an answer with thinking off",
    async () => {
      process.env.INFERENCE_MAX_CONCURRENT_RUNS = "2";
      resetSlotProbe();
      // A review is due after two seconds of work and takes two: each one
      // starts and decides inside a reply that is still thinking.
      await setPrefs({ progressCheckMs: null, progressCheckSteps: 500 });
      process.env.PROGRESS_CHECK_MS = "2000";
      const convId = await newConversation();
      const streamId = await run("think it over, review-stuck review-brief", convId, 75_000, ROOMY_MODEL);

      expect(await statusOf(streamId)).toBe("complete");
      const rows = await rowsOf(convId);
      const notes = await notesOf(convId);
      // Steered, told to answer, and asked once more when the answer was
      // only more thinking.
      expect(notes.map((n) => n.note?.action)).toEqual(["steer", "answer", "answer"]);
      expect(notes[2].note?.reason).toBe(ANSWER_UNWRITTEN_REASON);

      // Each note follows the reply it cut, and carries the end of that
      // reply's thinking: the row itself is cancelled and never sent again.
      for (const { row, note } of notes) {
        const cut = rows.filter((r) => r.lamport < row.lamport).at(-1);
        expect(cut).toMatchObject({ authorType: "assistant", status: "cancelled" });
        const thought = thinkingOf(cut?.content).trim();
        expect(thought.length).toBeGreaterThan(0);
        const tail = thought.length > CARRIED_REPLY_CHARS ? `[…] ${thought.slice(-CARRIED_REPLY_CHARS).trimStart()}` : thought;
        expect(note?.carried).toBe(`${INTERRUPTED}\n${tail}`);
        // The reason a reader is shown is still one short line.
        expect(note?.reason).not.toContain("Thought");
        expect(note?.reason.length).toBeLessThan(600);
      }
      // The first two were cut by a review, far into a long reply: only its
      // end is carried. The third by the answer turn's own budget.
      const cuts = rows.filter((r) => r.status === "cancelled");
      expect(cuts).toHaveLength(3);
      expect(thinkingOf(cuts.at(0)?.content).length).toBeGreaterThan(CARRIED_REPLY_CHARS);
      expect(thinkingOf(cuts.at(2)?.content).length).toBeLessThan(4_000);

      // Four requests: the two cut by reviews, the answer at the run's own
      // thinking level, and one last with thinking off.
      expect(requests.map((r) => [r.toolChoice, r.thinking])).toEqual([
        [undefined, ROOMY_THINKING_ON],
        [undefined, ROOMY_THINKING_ON],
        ["none", ROOMY_THINKING_ON],
        ["none", THINKING_OFF],
      ]);
      // Each request holds what the reply before it had got to...
      requests.slice(1).forEach((request, i) => {
        expect(request.messages.at(-1)).toBe(JSON.stringify({ role: "user", content: notes[i].text }));
        expect(request.messages.at(-1)).toContain("Thought ");
      });
      // ...and extends the one before, message for message.
      for (let i = 1; i < requests.length; i++) {
        expect(requests[i].messages.slice(0, requests[i - 1].messages.length)).toEqual(requests[i - 1].messages);
      }
      // A later turn replays the same bytes: the notes are rows, tail and all.
      const replay = (await loadHistory(convId)).messages.map((m) => JSON.stringify(m));
      const last = requests[3].messages;
      expect(JSON.parse(last[0])).toMatchObject({ role: "system" });
      expect(replay.slice(0, last.length - 1)).toEqual(last.slice(1));

      // The last request answered, and the run ended on its words.
      expect(rows.at(-1)).toMatchObject({ authorType: "assistant", status: "complete" });
      expect(textOf(rows.at(-1)?.content)).toContain("Answering now without tools");
      expect(JSON.parse(replay.at(-1) ?? "{}")).toMatchObject({ role: "assistant" });
    },
    90_000,
  );

  it("ends a run on a note when its model cannot be told to think less", async () => {
    seam.noThinkingLevels = true;
    useScenarios([{ match: "review-stuck", steps: steps(12), finalText: "[Mock] never reached.\n" }]);
    const convId = await newConversation();
    const streamId = await run("review-stuck: think it over", convId);

    // Told to answer after step six; the answer was thinking alone, and there
    // is no lower level to ask at: one answering request, then the end.
    expect(answering()).toHaveLength(1);
    expect(await statusOf(streamId)).toBe("complete");
    const rows = await rowsOf(convId);
    const notes = await notesOf(convId);
    expect(notes.map((n) => n.note?.action)).toEqual(["steer", "answer", "ended"]);
    const closing = notes[2];
    // Nobody wrote it, it gives the reviewer's reason, and it keeps the end
    // of the thinking the run did instead of answering.
    expect(closing.row).toMatchObject({ authorUserId: null, origin: "server", status: "complete" });
    expect(closing.note?.reason).toBe(notes[1].note?.reason);
    expect(closing.note?.reason).toContain("says stuck");
    expect(closing.note?.carried).toContain(INTERRUPTED);
    expect(closing.text).toContain("was asked for its final answer, did not write one, and was ended here");
    // It is the last row and the thread's leaf, after the reply that was cut.
    expect(rows.at(-1)?.id).toBe(closing.row.id);
    expect(rows.at(-2)).toMatchObject({ authorType: "assistant", status: "cancelled" });
    const conv = await db.query.conversations.findFirst({ where: eq(conversations.id, convId) });
    expect(conv?.activeLeafId).toBe(closing.row.id);
  });

  it("ends a run on a note when the request with thinking off only thinks too", async () => {
    useScenarios([{ match: "review-stuck", steps: steps(12), finalText: "[Mock] never reached.\n" }]);
    const convId = await newConversation();
    const streamId = await run("review-stuck: think it over whatever you are told", convId);

    // Exactly one more request after the answer was cut, with thinking off.
    expect(answering().map((r) => r.thinking)).toEqual([THINKING_MEDIUM, THINKING_OFF]);
    expect(await statusOf(streamId)).toBe("complete");
    const notes = await notesOf(convId);
    expect(notes.map((n) => n.note?.action)).toEqual(["steer", "answer", "answer", "ended"]);
    expect(notes[2].note?.reason).toBe(ANSWER_UNWRITTEN_REASON);
    expect(notes[3].note?.reason).toContain("says stuck");
    expect(notes[3].note?.carried).toContain(INTERRUPTED);
    const rows = await rowsOf(convId);
    expect(rows.at(-1)?.id).toBe(notes[3].row.id);
    expect(rows.filter((r) => r.authorType === "assistant" && r.status === "cancelled")).toHaveLength(2);
    // The six steps before it are untouched.
    expect(rows.filter((r) => r.authorType === "tool")).toHaveLength(6);
  });

  it("ends a run on a note when its answer, asked for twice, is empty both times", async () => {
    useScenarios([{ match: "review-stuck", steps: steps(12), finalText: "[Mock] never reached.\n" }]);
    const convId = await newConversation();
    const streamId = await run("review-stuck: say nothing", convId);

    expect(answering().map((r) => r.thinking)).toEqual([THINKING_MEDIUM, THINKING_OFF]);
    expect(await statusOf(streamId)).toBe("complete");
    const notes = await notesOf(convId);
    expect(notes.map((n) => n.note?.action)).toEqual(["steer", "answer", "answer", "ended"]);
    // Nothing was written or thought, so nothing is carried.
    expect(notes[2].note?.carried).toBeUndefined();
    expect(notes[3].note?.carried).toBeUndefined();
    const rows = await rowsOf(convId);
    expect(rows.at(-1)?.id).toBe(notes[3].row.id);
    // Neither empty reply was cut: each ended by itself.
    expect(rows.filter((r) => r.status === "cancelled")).toEqual([]);
  });

  it("ends a run on a note when its answer, asked for twice, is only a tool call written out as text", async () => {
    useScenarios([{ match: "review-stuck", steps: steps(12), finalText: "[Mock] never reached.\n" }]);
    const convId = await newConversation();
    const streamId = await run("review-stuck: write the call out as text", convId);

    // The first answer was a call spelled out, so it was asked once more with
    // thinking off; that one was the same, and the run ended saying so.
    expect(answering().map((r) => r.thinking)).toEqual([THINKING_MEDIUM, THINKING_OFF]);
    expect(await statusOf(streamId)).toBe("complete");
    const rows = await rowsOf(convId);
    const notes = await notesOf(convId);
    expect(notes.map((n) => n.note?.action)).toEqual(["steer", "answer", "answer", "ended"]);
    expect(notes[2].note?.reason).toBe(ANSWER_UNWRITTEN_REASON);
    expect(rows.at(-1)?.id).toBe(notes[3].row.id);
    // Each spelled-out call stays in the thread as a reply that was cut off,
    // never as the run's answer: no complete reply holds the markup.
    const spelled = rows.filter((r) => r.authorType === "assistant" && textOf(r.content).includes("<tool_call>"));
    expect(spelled).toHaveLength(2);
    expect(spelled.every((r) => r.status === "cancelled")).toBe(true);
    const events = (await getStreamBroker().readFrom(streamId, 0)).map((r) => r.event);
    for (const row of spelled) {
      expect(events.filter((e) => e.kind === "message.end" && e.message_id === row.id)).toMatchObject([{ status: "cancelled" }]);
    }
    // What it wrote is carried in the notes, so the last request and the next
    // turn both know of it...
    expect(notes[2].note?.carried).toContain("Your reply was interrupted. It had written:\n<tool_call>");
    expect(notes[3].note?.carried).toContain("<function=bash>");
    // ...and the prompt replays as it was sent: a cancelled row is never sent.
    const replay = (await loadHistory(convId)).messages.map((m) => JSON.stringify(m));
    const last = requests.at(-1)?.messages ?? [];
    expect(replay.slice(0, last.length - 1)).toEqual(last.slice(1));
    expect(replay.some((m) => (JSON.parse(m) as { role: string; content?: unknown }).role === "assistant" && m.includes("<tool_call>"))).toBe(false);
  });

  it("keeps an answer in words from the last request, after a first that was only a tool call", async () => {
    useScenarios([{ match: "review-stuck", steps: steps(12), finalText: "[Mock] never reached.\n" }]);
    const convId = await newConversation();
    const streamId = await run("review-stuck: write the call out as text once", convId);

    expect(answering().map((r) => r.thinking)).toEqual([THINKING_MEDIUM, THINKING_OFF]);
    expect(await statusOf(streamId)).toBe("complete");
    expect((await notesOf(convId)).map((n) => n.note?.action)).toEqual(["steer", "answer", "answer"]);
    const rows = await rowsOf(convId);
    expect(rows.at(-1)).toMatchObject({ authorType: "assistant", status: "complete" });
    expect(textOf(rows.at(-1)?.content)).toContain("Answering now without tools");
    expect(rows.filter((r) => r.status === "cancelled")).toHaveLength(1);
  });

  it("gives a parent a report from a sub-agent that never answers", async () => {
    useScenarios([
      {
        match: "parent hands off",
        steps: [{ tool: SUBAGENT_TOOL_NAME, args: { description: "Dig", prompt: "child review-stuck: think it over whatever you are told" } }],
        finalText: "[Mock] parent finished.\n",
      },
      { match: "child review-stuck", steps: steps(9), finalText: "[Mock] child never reached this.\n" },
    ]);
    const convId = await newConversation();
    const streamId = await run("parent hands off", convId);

    const [child] = await db.query.conversations.findMany({ where: eq(conversations.parentConversationId, convId) });
    // A sub-agent is told to answer at its first stuck verdict; it thought,
    // was asked once more with thinking off, thought again, and was ended.
    const notes = await notesOf(child.id);
    expect(notes.map((n) => n.note?.action)).toEqual(["answer", "answer", "ended"]);
    expect((await rowsOf(child.id)).at(-1)?.id).toBe(notes[2].row.id);

    // The parent did not hang and was not handed nothing: its call's result
    // says the child never answered, why it was ended and where it had got to,
    // and is marked failed.
    expect(await statusOf(streamId)).toBe("complete");
    const parentRows = await rowsOf(convId);
    const results = parentRows
      .flatMap((r) => r.content as ContentBlock[])
      .filter((b): b is Extract<ContentBlock, { kind: "tool_result" }> => b.kind === "tool_result");
    expect(results).toHaveLength(1);
    expect(results[0].ok).toBe(false);
    expect(results[0].output).toContain("never wrote one");
    expect(results[0].output).toContain(notes[2].note?.reason);
    expect(results[0].output).toContain(INTERRUPTED);
    expect(results[0].output).toContain("Thought ");
    expect(textOf(parentRows.filter((r) => r.authorType === "assistant").at(-1)?.content)).toContain("parent finished");
  });

  it("ends cancelled when stopped while the answer is still thinking, and leaves no closing note", async () => {
    // Room to stop in: the default budget is seven seconds of the mock's thinking.
    delete process.env.ANSWER_THINKING_CHARS;
    useScenarios([{ match: "review-stuck", steps: steps(12), finalText: "[Mock] never reached.\n" }]);
    const convId = await newConversation();
    const streamId = await start("review-stuck: think it over", convId);
    await waitFor("the answering request", () => answering().length === 1);
    await new Promise((r) => setTimeout(r, 300));
    getRunByConversation(convId)?.abort.abort();
    await waitFor("the run to end", () => getRunByConversation(convId) === undefined);

    expect(await statusOf(streamId)).toBe("cancelled");
    expect((await notesOf(convId)).map((n) => n.note?.action)).toEqual(["steer", "answer"]);
    expect(answering()).toHaveLength(1);
    const last = (await rowsOf(convId)).at(-1);
    expect(last).toMatchObject({ authorType: "assistant", status: "cancelled" });
    expect(thinkingOf(last?.content)).toContain("Thought ");
  });

  it("ends cancelled when stopped during the last request, and leaves no closing note", async () => {
    process.env.ANSWER_THINKING_CHARS = "8000";
    useScenarios([{ match: "review-stuck", steps: steps(12), finalText: "[Mock] never reached.\n" }]);
    const convId = await newConversation();
    const streamId = await start("review-stuck: think it over whatever you are told", convId);
    await waitFor("the last request", () => answering().length === 2);
    await new Promise((r) => setTimeout(r, 300));
    getRunByConversation(convId)?.abort.abort();
    await waitFor("the run to end", () => getRunByConversation(convId) === undefined);

    expect(await statusOf(streamId)).toBe("cancelled");
    expect((await notesOf(convId)).map((n) => n.note?.action)).toEqual(["steer", "answer", "answer"]);
    expect(answering()).toHaveLength(2);
    expect((await rowsOf(convId)).at(-1)).toMatchObject({ authorType: "assistant", status: "cancelled" });
  });
});
