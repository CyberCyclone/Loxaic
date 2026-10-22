import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { v4 as uuid } from "uuid";
import { and, db, eq, inArray, isNull } from "@loxaic/db";
import { commandRules, conversationShares, conversations, messages, sandboxes, usageRecords, user } from "@loxaic/db/schema";
import type { ContentBlock, ServerMessage, StreamEventKind, ToolPermission } from "@loxaic/types";
import type { ChatMessage, StreamOptions } from "../../inference/provider.ts";

process.env.MOCK_INFERENCE = "true";

/** Every request the loop made, in order, with what it sent. */
const requests: { messages: ChatMessage[]; options: StreamOptions }[] = [];
vi.mock("../../inference/provider.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../inference/provider.ts")>();
  return {
    ...actual,
    streamCompletion: (model: string, msgs: ChatMessage[], options: StreamOptions) => {
      requests.push({ messages: structuredClone(msgs), options: { ...options, signal: undefined } });
      return actual.streamCompletion(model, msgs, options);
    },
  };
});

// Where a case says so, the workspace contains its commands (#311): host mode
// never does, and every other case wants the real answer.
const isolation = vi.hoisted(() => ({ forced: false }));
vi.mock("../isolation.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../isolation.ts")>();
  return {
    ...actual,
    isolationFor: (id: string) =>
      isolation.forced ? Promise.resolve({ isolated: true, roots: ["/workspace"] }) : actual.isolationFor(id),
  };
});

const { initStreamBroker, getStreamBroker } = await import("../../streams/index.ts");
const { getRun, getRunByConversation } = await import("../../streams/registry.ts");
const { startAgentRun } = await import("../../streams/runs/agentRun.ts");
const { __resetMockScenariosForTest } = await import("../../inference/mock-scenarios.ts");
const { PERMISSION_CHECK_MARKER, PERMISSION_CHECK_PLACEHOLDER } = await import("../check.ts");
const { destroyConversationSandboxes } = await import("../../agent/sandbox-manager.ts");
const { changeRunMode } = await import("../../ws/run-actions.ts");
const { createDelivery } = await import("../../ws/delivery.ts");

/**
 * Per-command bash permissions and the auto-mode permission check, through the
 * real tool loop on the mock model, in a host-mode sandbox — which contains
 * nothing, so auto mode is exactly where the check applies. Each case scripts
 * the model's tool calls with a scenario, answers any approval as a person
 * would, and reads the outcome off the stored rows and the stream.
 */
const MODEL = "llama-3.1-8b-instruct";
type ToolResultBlock = Extract<ContentBlock, { kind: "tool_result" }>;

const ownerId = `test-perm-owner-${uuid()}`;
const editorId = `test-perm-editor-${uuid()}`;
const viewerId = `test-perm-viewer-${uuid()}`;
const strangerId = `test-perm-stranger-${uuid()}`;
const convIds: string[] = [];
let dir = "";

beforeAll(async () => {
  await initStreamBroker();
  dir = mkdtempSync(path.join(tmpdir(), "loxaic-permissions-"));
  for (const id of [ownerId, editorId, viewerId, strangerId]) {
    await db.insert(user).values({
      id,
      name: "Permissions test",
      email: `${id}@example.test`,
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }
});

beforeEach(() => {
  isolation.forced = false;
  process.env.SANDBOX_MODE = "host";
  process.env.SANDBOX_HOST_ROOT = path.join(dir, "sandboxes");
  requests.length = 0;
});

afterEach(async () => {
  Reflect.deleteProperty(process.env, "PERMISSION_CHECK_TIMEOUT_MS");
  // Each case opens conversations of its own, and a user may run only so
  // many sandboxes at once.
  for (const id of convIds) await destroyConversationSandboxes(id).catch(() => undefined);
  await db.delete(commandRules).where(inArray(commandRules.userId, [ownerId, editorId]));
});

afterAll(async () => {
  Reflect.deleteProperty(process.env, "MOCK_SCENARIOS_FILE");
  Reflect.deleteProperty(process.env, "SANDBOX_MODE");
  Reflect.deleteProperty(process.env, "SANDBOX_HOST_ROOT");
  __resetMockScenariosForTest();
  for (const id of convIds) {
    await db.delete(messages).where(eq(messages.conversationId, id));
    await db.delete(usageRecords).where(eq(usageRecords.conversationId, id));
  }
  await db.delete(sandboxes).where(eq(sandboxes.ownerId, ownerId));
  if (convIds.length) await db.delete(conversationShares).where(inArray(conversationShares.conversationId, convIds));
  if (convIds.length) await db.delete(conversations).where(inArray(conversations.id, convIds));
  for (const id of [ownerId, editorId, viewerId, strangerId]) {
    await db.delete(usageRecords).where(eq(usageRecords.userId, id));
    await db.delete(user).where(eq(user.id, id));
  }
  rmSync(dir, { recursive: true, force: true });
});

function useScenario(match: string, steps: { tool: string; args: Record<string, unknown> }[]): void {
  const file = path.join(dir, `${uuid()}.json`);
  writeFileSync(file, JSON.stringify([{ match, steps, finalText: "[Mock] Scenario done." }]));
  process.env.MOCK_SCENARIOS_FILE = file;
  __resetMockScenariosForTest();
}

async function newConversation(): Promise<string> {
  const [conv] = await db.insert(conversations).values({ ownerId, title: "permissions test", kind: "agent" }).returning();
  convIds.push(conv.id);
  return conv.id;
}

async function waitFor<T>(label: string, fn: () => T | null | Promise<T | null>, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value !== null) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

interface Turn {
  /** The approval the run asked for, as emitted, or null when it asked nothing. */
  request: Record<string, unknown> | null;
  results: (ToolResultBlock & { permission?: ToolPermission })[];
}

/**
 * One agent turn running `command` through bash (or a file write), answering
 * the first approval with `answer` when one is asked for.
 */
async function turn(
  convId: string,
  mode: "manual" | "auto" | "planning",
  step: { tool: string; args: Record<string, unknown> },
  answer: { approve: boolean; by?: string; always?: boolean } | null = { approve: false },
): Promise<Turn> {
  const match = `perm-${uuid().slice(0, 8)}`;
  useScenario(match, [step]);
  const { streamId } = await startAgentRun({ userId: ownerId, content: `please ${match}`, model: MODEL, mode, conversationId: convId });
  let request: Record<string, unknown> | null = null;
  await waitFor("the run to ask or end", async () => {
    const run = getRun(streamId);
    if (!run) return true;
    const pending = run.approvals.entries().next();
    if (pending.done) return null;
    const records = await getStreamBroker().readFrom(streamId, 0);
    request = (records.map((r) => r.event).find((e) => e.kind === "approval.request") ?? null) as Record<string, unknown> | null;
    if (answer) pending.value[1](answer.approve, { userId: answer.by ?? ownerId, always: answer.always ?? false });
    return true;
  });
  await waitFor("the run to end", () => (getRunByConversation(convId) ? null : true));
  const rows = await db.query.messages.findMany({
    where: eq(messages.conversationId, convId),
    orderBy: (m, { asc }) => [asc(m.lamport), asc(m.createdAt)],
  });
  const blocks = rows.flatMap((r) => r.content as ContentBlock[]);
  // Only this step's tool: planning mode ends every turn in a plan too.
  const ids = new Set(
    blocks.filter((b) => b.kind === "tool_call" && b.tool === step.tool).map((b) => (b as { call_id: string }).call_id),
  );
  return { request, results: blocks.filter((b): b is ToolResultBlock => b.kind === "tool_result" && ids.has(b.call_id)) };
}

const bash = (command: string) => ({ tool: "bash", args: { command } });

describe("bash permissions in the tool loop", () => {
  it("runs a read-only command unasked in manual mode, and says why", async () => {
    const t = await turn(await newConversation(), "manual", bash("ls -la && git --version"), null);
    expect(t.request).toBeNull();
    expect(t.results.at(-1)).toMatchObject({ ok: true, permission: { by: "readonly" } });
  }, 30_000);

  it("asks about a write with the rule it would record; Allow always records it, and the next run runs", async () => {
    const convId = await newConversation();
    const first = await turn(convId, "manual", bash("touch made.txt"), { approve: true, always: true });
    expect(first.request).toMatchObject({ kind: "approval.request", tool: "bash", rules: ["touch *"] });
    expect(first.results.at(-1)?.ok).toBe(true);
    const stored = await db.query.commandRules.findMany({ where: eq(commandRules.userId, ownerId) });
    expect(stored.map((r) => [r.pattern, r.action, r.source])).toEqual([["touch *", "allow", "prompt"]]);

    const second = await turn(convId, "manual", bash("touch other.txt"), null);
    expect(second.request).toBeNull();
    expect(second.results.at(-1)).toMatchObject({ ok: true, permission: { by: "rule", rule: "touch *" } });
  }, 30_000);

  it("records nothing for an editor's Allow always", async () => {
    await turn(await newConversation(), "manual", bash("touch e.txt"), { approve: true, by: editorId, always: true });
    expect(await db.query.commandRules.findMany({ where: inArray(commandRules.userId, [ownerId, editorId]) })).toEqual([]);
  }, 30_000);

  it("refuses a command a deny rule covers, in every mode", async () => {
    await db.insert(commandRules).values({ userId: ownerId, pattern: "touch *", action: "deny", source: "settings" });
    for (const mode of ["manual", "auto"] as const) {
      const t = await turn(await newConversation(), mode, bash("touch denied.txt"), null);
      expect(t.request).toBeNull();
      expect(t.results.at(-1)).toMatchObject({ ok: false, permission: { by: "denied", rule: "touch *" } });
      expect(t.results.at(-1)?.output).toContain("denies");
    }
  }, 30_000);

  it("runs read-only commands in planning mode and refuses everything else", async () => {
    const convId = await newConversation();
    const read = await turn(convId, "planning", bash("ls"), null);
    expect(read.results.at(-1)).toMatchObject({ ok: true, permission: { by: "readonly" } });
    const write = await turn(convId, "planning", bash("touch planned.txt"), null);
    expect(write.request).toBeNull();
    expect(write.results.at(-1)).toMatchObject({ ok: false, permission: { by: "refused" } });
  }, 30_000);

  it("asks about a push in every mode, even where a write would run", async () => {
    const t = await turn(await newConversation(), "auto", bash("git push origin feature"));
    expect(t.request).toMatchObject({ tool: "bash", rules: ["git push *"] });
    expect(t.request).not.toHaveProperty("check");
  }, 30_000);
});

describe("the permission check (auto mode outside isolation)", () => {
  it("runs what the check allows, records its usage apart from the turn, and extends the run's own request", async () => {
    const convId = await newConversation();
    const t = await turn(convId, "auto", bash("touch checked.txt"), null);
    expect(t.request).toBeNull();
    expect(t.results.at(-1)).toMatchObject({ ok: true, permission: { by: "classifier", reason: "The mock allows it." } });

    const usage = await db.query.usageRecords.findMany({
      where: and(eq(usageRecords.conversationId, convId), eq(usageRecords.purpose, "permission_check")),
    });
    expect(usage).toHaveLength(1);
    expect(usage[0].messageId).toBeNull();
    const turns = await db.query.usageRecords.findMany({
      where: and(eq(usageRecords.conversationId, convId), isNull(usageRecords.purpose)),
    });
    expect(turns.length).toBeGreaterThan(0);

    // The check is the run's request plus the tool call, a placeholder result
    // and the instruction — the same tools and thinking fields, and no tools
    // allowed — so a llama.cpp backend extends its cached prefix.
    const checkIndex = requests.findIndex((r) => {
      const last = r.messages.at(-1);
      return last?.role === "user" && typeof last.content === "string" && last.content.startsWith(PERMISSION_CHECK_MARKER);
    });
    expect(checkIndex).toBeGreaterThan(0);
    const run = requests[checkIndex - 1];
    const check = requests[checkIndex];
    expect(check.messages.slice(0, run.messages.length)).toEqual(run.messages);
    const tail = check.messages.slice(run.messages.length);
    expect(tail.map((m) => m.role)).toEqual(["assistant", "tool", "user"]);
    expect(tail[1].content).toBe(PERMISSION_CHECK_PLACEHOLDER);
    expect(check.options.toolChoice).toBe("none");
    expect(check.options.tools).toEqual(run.options.tools);
    expect(check.options.thinking).toEqual(run.options.thinking);
    // And the next real request shares everything up to the tool call.
    const next = requests[checkIndex + 1];
    expect(next.messages.slice(0, run.messages.length + 1)).toEqual(check.messages.slice(0, run.messages.length + 1));
  }, 30_000);

  it("asks the person when the check says ASK, with its reason and the rule", async () => {
    const t = await turn(await newConversation(), "auto", bash("touch classifier-ask.txt"));
    expect(t.request).toMatchObject({
      tool: "bash",
      rules: ["touch *"],
      check: { by: "classifier", outcome: "ask", reason: "The mock was told to ask about this one." },
    });
    expect(t.results.at(-1)?.ok).toBe(false);
  }, 30_000);

  it("asks when the check gives no verdict", async () => {
    const t = await turn(await newConversation(), "auto", bash("touch classifier-garbage.txt"));
    expect(t.request).toMatchObject({ check: { by: "classifier", outcome: "unparseable" } });
  }, 30_000);

  it("asks when the check takes too long", async () => {
    process.env.PERMISSION_CHECK_TIMEOUT_MS = "300";
    const t = await turn(await newConversation(), "auto", bash("touch classifier-slow.txt"));
    expect(t.request).toMatchObject({ check: { by: "classifier", outcome: "timeout" } });
  }, 30_000);

  it("checks a file write outside the workspace, and leaves one inside alone", async () => {
    const outside = await turn(await newConversation(), "auto", {
      tool: "fs_write",
      args: { path: "~/.classifier-ask-rc", content: "x" },
    });
    expect(outside.request).toMatchObject({ tool: "fs_write", check: { outcome: "ask" } });
    const inside = await turn(await newConversation(), "auto", { tool: "fs_write", args: { path: "notes.txt", content: "x" } }, null);
    expect(inside.request).toBeNull();
    expect(inside.results.at(-1)?.output).toContain("notes.txt");
    expect(inside.results.at(-1)?.ok).toBe(true);
  }, 30_000);
});

describe("switching a run's mode while it works (#311)", () => {
  /** Starts `step` in `mode` and returns once the run is waiting on a person. */
  async function parked(convId: string, mode: "manual" | "auto", step: { tool: string; args: Record<string, unknown> }) {
    const match = `live-${uuid().slice(0, 8)}`;
    useScenario(match, [step]);
    const { streamId } = await startAgentRun({ userId: ownerId, content: `please ${match}`, model: MODEL, mode, conversationId: convId });
    await waitFor("the run to ask", () => ((getRun(streamId)?.approvals.size ?? 0) > 0 ? true : null));
    return streamId;
  }
  const eventsOf = async (streamId: string): Promise<StreamEventKind[]> =>
    (await getStreamBroker().readFrom(streamId, 0)).map((r) => r.event);
  const requestsOf = async (streamId: string) =>
    (await eventsOf(streamId)).filter((e): e is Extract<StreamEventKind, { kind: "approval.request" }> => e.kind === "approval.request");
  const modesOf = async (streamId: string) =>
    (await eventsOf(streamId)).filter((e) => e.kind === "run.mode").map((e) => (e as { mode: string }).mode);
  async function ended(convId: string): Promise<(ToolResultBlock & { permission?: ToolPermission })[]> {
    await waitFor("the run to end", () => (getRunByConversation(convId) ? null : true));
    const rows = await db.query.messages.findMany({
      where: eq(messages.conversationId, convId),
      orderBy: (m, { asc }) => [asc(m.lamport), asc(m.createdAt)],
    });
    return rows.flatMap((r) => r.content as ContentBlock[]).filter((b): b is ToolResultBlock => b.kind === "tool_result");
  }
  const storedMode = async (convId: string) =>
    (await db.query.conversations.findFirst({ where: eq(conversations.id, convId), columns: { permissionMode: true } }))?.permissionMode;
  const deny = (streamId: string) => {
    const pending = getRun(streamId)?.approvals.entries().next();
    if (pending && !pending.done) pending.value[1](false, { userId: ownerId, always: false });
  };

  it("says the mode the run starts in, in its log and on the conversation", async () => {
    const convId = await newConversation();
    const streamId = await parked(convId, "manual", bash("touch started.txt"));
    expect(await modesOf(streamId)).toEqual(["manual"]);
    expect(await storedMode(convId)).toBe("manual");
    const broker = getStreamBroker();
    expect(broker.foldSnapshot(await broker.readFrom(streamId, 0)).mode).toBe("manual");
    deny(streamId);
    await ended(convId);
  }, 30_000);

  it("sends a waiting command to the permission check when the run goes to Auto, and nobody answers", async () => {
    const convId = await newConversation();
    const streamId = await parked(convId, "manual", bash("touch live-auto.txt"));
    expect(await requestsOf(streamId)).toMatchObject([{ mode: "manual" }]);
    expect((await requestsOf(streamId))[0]).not.toHaveProperty("check");

    await changeRunMode(ownerId, convId, "auto");
    const results = await ended(convId);
    expect(results.at(-1)).toMatchObject({ ok: true, permission: { by: "classifier" } });
    // Asked once, in Manual; the switch decided it, not a person.
    expect(await requestsOf(streamId)).toHaveLength(1);
    expect(await modesOf(streamId)).toEqual(["manual", "auto"]);
    const broker = getStreamBroker();
    const snapshot = broker.foldSnapshot(await broker.readFrom(streamId, 0));
    expect(snapshot.mode).toBe("auto");
    expect(snapshot.pending_approval).toBeUndefined();
    expect(await storedMode(convId)).toBe("auto");
  }, 30_000);

  it("runs it straight away where the sandbox contains it", async () => {
    isolation.forced = true;
    const convId = await newConversation();
    await parked(convId, "manual", bash("touch live-isolated.txt"));
    await changeRunMode(ownerId, convId, "auto");
    expect((await ended(convId)).at(-1)).toMatchObject({ ok: true, permission: { by: "isolated" } });
  }, 30_000);

  it("asks again, in Auto and with the check's reason, when the check says ASK", async () => {
    const convId = await newConversation();
    const streamId = await parked(convId, "manual", bash("touch classifier-ask-live.txt"));
    await changeRunMode(ownerId, convId, "auto");
    await waitFor("the second question", async () => ((await requestsOf(streamId)).length === 2 ? true : null));
    const [first, second] = await requestsOf(streamId);
    expect(first).toMatchObject({ mode: "manual" });
    expect(second).toMatchObject({
      call_id: first.call_id,
      mode: "auto",
      rules: ["touch *"],
      check: { by: "classifier", outcome: "ask" },
    });
    const broker = getStreamBroker();
    expect(broker.foldSnapshot(await broker.readFrom(streamId, 0)).pending_approval).toMatchObject({ mode: "auto" });
    await waitFor("the run to wait again", () => ((getRun(streamId)?.approvals.size ?? 0) > 0 ? true : null));
    deny(streamId);
    expect((await ended(convId)).at(-1)).toMatchObject({ ok: false, output: "User denied this tool call." });
  }, 30_000);

  it("asks again in Manual, without the check's note, when an Auto run goes back", async () => {
    const convId = await newConversation();
    const streamId = await parked(convId, "auto", bash("touch classifier-ask-back.txt"));
    expect((await requestsOf(streamId))[0]).toMatchObject({ mode: "auto", check: { outcome: "ask" } });
    await changeRunMode(ownerId, convId, "manual");
    await waitFor("the second question", async () => ((await requestsOf(streamId)).length === 2 ? true : null));
    const second = (await requestsOf(streamId))[1];
    expect(second).toMatchObject({ mode: "manual", rules: ["touch *"] });
    expect(second).not.toHaveProperty("check");
    await waitFor("the run to wait again", () => ((getRun(streamId)?.approvals.size ?? 0) > 0 ? true : null));
    deny(streamId);
    await ended(convId);
  }, 30_000);

  it("leaves the run as it is on a Planning pick, and remembers it for the next message", async () => {
    const convId = await newConversation();
    const streamId = await parked(convId, "manual", bash("touch planned-later.txt"));
    await changeRunMode(ownerId, convId, "planning");
    expect(getRun(streamId)?.mode).toBe("manual");
    expect(getRun(streamId)?.approvals.size).toBe(1);
    expect(await modesOf(streamId)).toEqual(["manual"]);
    expect(await storedMode(convId)).toBe("planning");
    deny(streamId);
    await ended(convId);
  }, 30_000);

  it("is a silent no-op for a viewer and a stranger, and works for an editor", async () => {
    const convId = await newConversation();
    await db.insert(conversationShares).values([
      { conversationId: convId, userId: viewerId, role: "viewer", createdBy: ownerId },
      { conversationId: convId, userId: editorId, role: "editor", createdBy: ownerId },
    ]);
    const streamId = await parked(convId, "manual", bash("touch shared-live.txt"));
    for (const who of [viewerId, strangerId]) {
      await changeRunMode(who, convId, "auto");
      expect(getRun(streamId)?.mode).toBe("manual");
      expect(await storedMode(convId)).toBe("manual");
    }
    expect(await modesOf(streamId)).toEqual(["manual"]);
    // Nonsense off a socket is ignored too.
    await changeRunMode(ownerId, convId, "yolo");
    await changeRunMode(ownerId, "not-a-uuid", "auto");
    expect(getRun(streamId)?.mode).toBe("manual");

    await changeRunMode(editorId, convId, "auto");
    expect((await ended(convId)).at(-1)).toMatchObject({ ok: true, permission: { by: "classifier" } });
    expect(await storedMode(convId)).toBe("auto");
  }, 30_000);

  it("tells every device following the run, not only the one that switched", async () => {
    const convId = await newConversation();
    const streamId = await parked(convId, "manual", bash("touch heard-live.txt"));
    const inboxes: ServerMessage[][] = [[], []];
    const deliveries = inboxes.map((inbox) => createDelivery(ownerId, (m) => inbox.push(m), () => 0));
    for (const d of deliveries) await d.handleSubscribe(convId);
    await changeRunMode(ownerId, convId, "auto");
    await ended(convId);
    for (const inbox of inboxes) {
      expect(
        inbox.some((m) => m.type === "stream.event" && m.stream_id === streamId && m.event.kind === "run.mode" && m.event.mode === "auto"),
      ).toBe(true);
    }
    for (const d of deliveries) d.close();
  }, 30_000);
});
