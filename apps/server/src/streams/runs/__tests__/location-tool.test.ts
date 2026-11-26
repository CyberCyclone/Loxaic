import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { v4 as uuid } from "uuid";
import { asc, db, eq, inArray } from "@loxaic/db";
import { conversationShares, conversations, messages, usageRecords, user, userPrefs } from "@loxaic/db/schema";
import type { ContentBlock, LocationSharing, StreamEventKind } from "@loxaic/types";
import { getStreamBroker, initStreamBroker } from "../../index.ts";
import { getRun, getRunByConversation, runActivityOf } from "../../registry.ts";
import { followStream } from "../../device-presence.ts";
import { answerDeviceRequest } from "../../../ws/run-actions.ts";
import { startChatRun } from "../chatRun.ts";
import { answerLocationCall, withoutPosition, type LocationMemo } from "../location.ts";

/**
 * `get_location` through the real tool loop on the mock model: "weather" in a
 * chat makes it call the tool (inference/provider.ts), the person's device
 * answers through the same handler a socket's `device.answer` reaches
 * (ws/run-actions.ts), and what the model was told is read back from the
 * stored rows and the mock's reply.
 */
process.env.MOCK_INFERENCE = "true";
const MODEL = "llama-3.1-8b-instruct";
const BRISBANE = { lat: -27.4679, lon: 153.0281 };

const userId = `test-location-${uuid()}`;
const otherId = `test-location-other-${uuid()}`;
const convIds: string[] = [];
let releases: (() => void)[] = [];

beforeAll(async () => {
  process.env.DELETED_CHAT_RETENTION_ENABLED = "false";
  await initStreamBroker();
  for (const id of [userId, otherId]) {
    await db.insert(user).values({
      id,
      name: "Test Location",
      email: `${id}@example.test`,
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }
});

afterEach(() => {
  for (const release of releases) release();
  releases = [];
  delete process.env.LOCATION_SILENT_TIMEOUT_MS;
  delete process.env.LOCATION_FOLLOWER_GRACE_MS;
});

afterAll(async () => {
  delete process.env.DELETED_CHAT_RETENTION_ENABLED;
  if (convIds.length) {
    await db.delete(messages).where(inArray(messages.conversationId, convIds));
    await db.delete(conversations).where(inArray(conversations.id, convIds));
  }
  await db.delete(usageRecords).where(inArray(usageRecords.userId, [userId, otherId]));
  await db.delete(userPrefs).where(inArray(userPrefs.userId, [userId, otherId]));
  await db.delete(user).where(inArray(user.id, [userId, otherId]));
});

async function setSharing(value: LocationSharing): Promise<void> {
  await db
    .insert(userPrefs)
    .values({ userId, locationSharing: value })
    .onConflictDoUpdate({ target: userPrefs.userId, set: { locationSharing: value } });
}

async function sharing(): Promise<string | undefined> {
  return (await db.query.userPrefs.findFirst({ where: eq(userPrefs.userId, userId) }))?.locationSharing;
}

/** The run's handle, or a failed test saying it is gone. */
function runOf(streamId: string) {
  const run = getRun(streamId);
  if (!run) throw new Error(`run ${streamId} is not registered`);
  return run;
}

async function waitFor(label: string, check: () => boolean, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** Sends the weather question. `device`: a device of the person's that can
 * answer follows the run, as the socket that sent it does once the send is
 * answered (ws/delivery.ts). */
async function ask(prompt = "What's the weather like today?", device = true) {
  const started = await startChatRun({ userId, content: prompt, model: MODEL, localTime: { tz: "Australia/Brisbane" } });
  convIds.push(started.conversationId);
  if (device) releases.push(followStream(userId, started.streamId));
  return started;
}

/** The call waiting on the device, once it is. */
async function waitingCall(streamId: string): Promise<string> {
  await waitFor("the location request", () => (getRun(streamId)?.deviceRequests?.size ?? 0) > 0);
  const [callId] = [...(getRun(streamId)?.deviceRequests?.keys() ?? [])];
  return callId;
}

async function finished(convId: string): Promise<void> {
  await waitFor("the run to end", () => getRunByConversation(convId) === undefined);
}

async function events(streamId: string): Promise<StreamEventKind[]> {
  return (await getStreamBroker().readFrom(streamId, 0)).map((r) => r.event);
}

async function stored(convId: string) {
  const rows = await db.select().from(messages).where(eq(messages.conversationId, convId)).orderBy(asc(messages.lamport), asc(messages.createdAt));
  const result = rows
    .flatMap((r) => r.content as ContentBlock[])
    .find((b): b is Extract<ContentBlock, { kind: "tool_result" }> => b.kind === "tool_result");
  const reply = rows.filter((r) => r.authorType === "assistant").at(-1);
  const replyText = ((reply?.content ?? []) as ContentBlock[]).filter((b) => b.kind === "text").map((b) => (b as { text: string }).text).join("");
  return { result, replyText };
}

describe("get_location", () => {
  it("asks the device, and tells the model the nearest town and the local time", async () => {
    await setSharing("ask");
    const { streamId, conversationId } = await ask();
    const callId = await waitingCall(streamId);
    // Waiting on a person, as an approval is, with the inference slot given back.
    expect(runActivityOf(runOf(streamId))).toBe("awaiting_approval");
    const request = (await events(streamId)).find((e) => e.kind === "device.request");
    expect(request).toMatchObject({ kind: "device.request", call_id: callId, request: "location", ask: true, user_id: userId });
    expect((request as { expires_at?: number }).expires_at).toBeGreaterThan(Date.now());

    await answerDeviceRequest(userId, { stream_id: streamId, call_id: callId, outcome: "shared", location: BRISBANE, tz: "Australia/Brisbane" });
    await finished(conversationId);
    const { result, replyText } = await stored(conversationId);
    expect(result?.device).toEqual({ request: "location", outcome: "shared", place: "Brisbane, Queensland, Australia", user_id: userId });
    expect(result?.ok).toBe(true);
    // The town, never coordinates: what the model holds, a page it reads can
    // ask it to send on.
    expect(result?.output).toMatch(/^Approximate location: Brisbane, Queensland, Australia \(city-level\)\.\nLocal time: .* \(Australia\/Brisbane, UTC\+10:00\)\.$/);
    expect(result?.output).not.toMatch(/-?27\.4|153\.0|latitude|longitude/);
    // The live event said exactly what was stored, and the model was told it.
    const live = (await events(streamId)).find((e) => e.kind === "tool.result" && e.call_id === callId);
    expect(live).toMatchObject({ output: result?.output, device: result?.device });
    expect(replyText).toContain("The tool returned: Approximate location: Brisbane");
    expect(await sharing()).toBe("ask");
  });

  it("remembers \"Always allow\" from the sender, and ignores anyone else's answer", async () => {
    await setSharing("ask");
    const { streamId, conversationId } = await ask();
    const callId = await waitingCall(streamId);
    // An editor of the conversation may approve its tools, but their position
    // is never the sender's.
    await db.insert(conversationShares).values({ conversationId, userId: otherId, role: "editor", createdBy: userId });
    await answerDeviceRequest(otherId, { stream_id: streamId, call_id: callId, outcome: "shared", location: { lat: 51.5, lon: -0.13 } });
    // Nor is a malformed answer, or one for another run.
    await answerDeviceRequest(userId, { stream_id: streamId, call_id: callId, outcome: "shared" });
    await answerDeviceRequest(userId, { stream_id: uuid(), call_id: callId, outcome: "declined" });
    expect(getRun(streamId)?.deviceRequests?.has(callId)).toBe(true);

    await answerDeviceRequest(userId, { stream_id: streamId, call_id: callId, outcome: "shared", location: BRISBANE, always: true });
    // A second answer finds nothing waiting.
    await answerDeviceRequest(userId, { stream_id: streamId, call_id: callId, outcome: "declined" });
    await finished(conversationId);
    expect((await stored(conversationId)).result?.device?.outcome).toBe("shared");
    expect(await sharing()).toBe("always");
  });

  it("with Always allow, lets the device answer without asking, and gives up when it does not", async () => {
    await setSharing("always");
    process.env.LOCATION_SILENT_TIMEOUT_MS = "400";
    const { streamId, conversationId } = await ask();
    await waitingCall(streamId);
    // Not waiting on a person: the device answers by itself.
    expect(runActivityOf(runOf(streamId))).toBe("running");
    expect((await events(streamId)).find((e) => e.kind === "device.request")).toMatchObject({ ask: false, timeout_ms: 400 });
    await finished(conversationId);
    const { result } = await stored(conversationId);
    expect(result?.device?.outcome).toBe("no_answer");
    expect(result?.output.startsWith(withoutPosition("no_answer"))).toBe(true);
  });

  it("says sharing is off, without asking, when it is", async () => {
    await setSharing("off");
    const { streamId, conversationId } = await ask();
    await finished(conversationId);
    expect((await events(streamId)).some((e) => e.kind === "device.request")).toBe(false);
    const { result } = await stored(conversationId);
    expect(result?.device?.outcome).toBe("off");
    expect(result?.output).toMatch(/^The user has turned location sharing off in Loxaic's settings\. .*\nLocal time: .*Australia\/Brisbane/);
  });

  it("answers soon when no device that can share follows the run", async () => {
    await setSharing("ask");
    process.env.LOCATION_FOLLOWER_GRACE_MS = "200";
    const { streamId, conversationId } = await ask(undefined, false);
    await finished(conversationId);
    expect((await events(streamId)).some((e) => e.kind === "device.request")).toBe(false);
    expect((await stored(conversationId)).result?.device?.outcome).toBe("no_device");
  });

  it("does not wait on a device that is open on another thread", async () => {
    await setSharing("ask");
    process.env.LOCATION_FOLLOWER_GRACE_MS = "200";
    // The phone follows some other run of the person's, not this one.
    releases.push(followStream(userId, uuid()));
    const { streamId, conversationId } = await ask(undefined, false);
    await finished(conversationId);
    expect((await events(streamId)).some((e) => e.kind === "device.request")).toBe(false);
    expect((await stored(conversationId)).result?.device?.outcome).toBe("no_device");
  });

  it("passes on a declined request, and why a device could not answer", async () => {
    await setSharing("ask");
    const first = await ask();
    let callId = await waitingCall(first.streamId);
    // A zone the server does not know falls back to the one on record.
    await answerDeviceRequest(userId, { stream_id: first.streamId, call_id: callId, outcome: "declined", always: true, tz: "Foo/Bar" });
    await finished(first.conversationId);
    const declined = (await stored(first.conversationId)).result;
    expect(declined?.device?.outcome).toBe("declined");
    expect(declined?.output).toMatch(/\nLocal time: .* \(Australia\/Brisbane, UTC\+10:00\)\.$/);
    // "Always" never rides a refusal.
    expect(await sharing()).toBe("ask");

    const second = await ask();
    callId = await waitingCall(second.streamId);
    await answerDeviceRequest(userId, { stream_id: second.streamId, call_id: callId, outcome: "unavailable", reason: "permission_denied" });
    await finished(second.conversationId);
    const { result } = await stored(second.conversationId);
    expect(result?.device?.outcome).toBe("unavailable");
    expect(result?.output).toContain("location permission is turned off for Loxaic on that device");
  });

  it("stops cleanly while it waits", async () => {
    await setSharing("ask");
    const { streamId, conversationId } = await ask();
    const callId = await waitingCall(streamId);
    getRun(streamId)?.abort.abort();
    await finished(conversationId);
    const { result } = await stored(conversationId);
    expect(result?.call_id).toBe(callId);
    expect(result?.ok).toBe(false);
    expect(result?.output).toMatch(/[Ss]topped/);
  });

  it("asks nobody for a schedule's run", async () => {
    await setSharing("always");
    const started = await startChatRun({ userId, content: "What's the weather like today?", model: MODEL, localTime: "schedule" });
    convIds.push(started.conversationId);
    await finished(started.conversationId);
    expect((await events(started.streamId)).some((e) => e.kind === "device.request")).toBe(false);
    expect((await stored(started.conversationId)).result?.device?.outcome).toBe("unattended");
  });
});

describe("where it is offered", () => {
  it("is a chat's tool, not a coding run's", async () => {
    await setSharing("ask");
    const { startAgentRun } = await import("../agentRun.ts");
    const started = await startAgentRun({ userId, content: "What's the weather like today?", model: MODEL, mode: "auto" });
    convIds.push(started.conversationId);
    await finished(started.conversationId);
    expect((await events(started.streamId)).some((e) => e.kind === "device.request")).toBe(false);
    expect((await stored(started.conversationId)).result).toBeUndefined();
  });
});

describe("answerLocationCall", () => {
  function callWith(memo: LocationMemo, emitted: StreamEventKind[], callId = "call_2") {
    return answerLocationCall(
      {
        streamId: uuid(),
        userId,
        producer: { emit: (e: StreamEventKind) => { emitted.push(e); } } as never,
        assistantMsgId: "m",
        slot: { yieldWhile: () => { throw new Error("must not wait"); } } as never,
        signal: new AbortController().signal,
        askDeadline: () => ({ ms: 1000, expiresAt: Date.now() + 1000, basis: "setting" }),
        scheduled: false,
        memo,
      },
      callId,
      {},
    );
  }
  const earlier = { output: "first answer", ok: false, device: { request: "location" as const, outcome: "declined" as const } };

  it("answers a later call in the run as the person did, without asking again", async () => {
    await setSharing("ask");
    const emitted: StreamEventKind[] = [];
    const result = await callWith({ answered: earlier }, emitted);
    expect(result).toEqual(earlier);
    expect(emitted).toEqual([
      { kind: "tool.result", message_id: "m", call_id: "call_2", tool: "get_location", output: "first answer", ok: false, device: earlier.device },
    ]);
  });

  it("does not replay an answer once sharing is turned off", async () => {
    await setSharing("off");
    const result = await callWith({ answered: { ...earlier, ok: true, device: { request: "location", outcome: "shared" } } }, []);
    expect(result.device.outcome).toBe("off");
  });

  it("keeps no answer but the person's own: no device is asked about again", async () => {
    await setSharing("ask");
    process.env.LOCATION_FOLLOWER_GRACE_MS = "0";
    const memo: LocationMemo = {};
    expect((await callWith(memo, [])).device.outcome).toBe("no_device");
    expect(memo.answered).toBeUndefined();
  });
});
