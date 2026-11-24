import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { v4 as uuid } from "uuid";
import { asc, db, eq, inArray } from "@loxaic/db";
import { conversations, messages, usageRecords, user, userPrefs } from "@loxaic/db/schema";
import type { ContentBlock, LocationSharing, StreamEventKind } from "@loxaic/types";
import { getStreamBroker, initStreamBroker } from "../../index.ts";
import { getRun, getRunByConversation, runActivityOf } from "../../registry.ts";
import { registerDeviceSocket } from "../../device-presence.ts";
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

/** A device of the person's that can answer, connected for this test. */
function connectDevice(): void {
  releases.push(registerDeviceSocket(userId, ["location"]));
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

async function ask(prompt = "What's the weather like today?") {
  const started = await startChatRun({ userId, content: prompt, model: MODEL, localTime: { tz: "Australia/Brisbane" } });
  convIds.push(started.conversationId);
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
    connectDevice();
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
    expect(result?.device).toEqual({ request: "location", outcome: "shared", place: "Brisbane, Queensland, Australia" });
    expect(result?.ok).toBe(true);
    expect(result?.output).toMatch(/^Approximate location: Brisbane, Queensland, Australia \(latitude -27\.47, longitude 153\.03; city-level, about 1 km\)\.\nLocal time: .* \(Australia\/Brisbane, UTC\+10:00\)\.$/);
    // The live event said exactly what was stored, and the model was told it.
    const live = (await events(streamId)).find((e) => e.kind === "tool.result" && e.call_id === callId);
    expect(live).toMatchObject({ output: result?.output, device: result?.device });
    expect(replyText).toContain("The tool returned: Approximate location: Brisbane");
    expect(await sharing()).toBe("ask");
  });

  it("remembers \"Always allow\" from the sender, and ignores anyone else's answer", async () => {
    await setSharing("ask");
    connectDevice();
    const { streamId, conversationId } = await ask();
    const callId = await waitingCall(streamId);
    // Someone else's position is never the sender's.
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
    connectDevice();
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
    connectDevice();
    const { streamId, conversationId } = await ask();
    await finished(conversationId);
    expect((await events(streamId)).some((e) => e.kind === "device.request")).toBe(false);
    const { result } = await stored(conversationId);
    expect(result?.device?.outcome).toBe("off");
    expect(result?.output).toMatch(/^The user has turned location sharing off in Loxaic's settings\. .*\nLocal time: .*Australia\/Brisbane/);
  });

  it("answers at once when no device that can share is connected", async () => {
    await setSharing("ask");
    const { streamId, conversationId } = await ask();
    await finished(conversationId);
    expect((await events(streamId)).some((e) => e.kind === "device.request")).toBe(false);
    expect((await stored(conversationId)).result?.device?.outcome).toBe("no_device");
  });

  it("passes on a declined request, and why a device could not answer", async () => {
    await setSharing("ask");
    connectDevice();
    const first = await ask();
    let callId = await waitingCall(first.streamId);
    await answerDeviceRequest(userId, { stream_id: first.streamId, call_id: callId, outcome: "declined", always: true });
    await finished(first.conversationId);
    expect((await stored(first.conversationId)).result?.device?.outcome).toBe("declined");
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
    connectDevice();
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
    connectDevice();
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
    connectDevice();
    const { startAgentRun } = await import("../agentRun.ts");
    const started = await startAgentRun({ userId, content: "What's the weather like today?", model: MODEL, mode: "auto" });
    convIds.push(started.conversationId);
    await finished(started.conversationId);
    expect((await events(started.streamId)).some((e) => e.kind === "device.request")).toBe(false);
    expect((await stored(started.conversationId)).result).toBeUndefined();
  });
});

describe("answerLocationCall", () => {
  it("answers a second call in the same reply as the first, without asking again", async () => {
    const emitted: StreamEventKind[] = [];
    const memo: LocationMemo = {
      answered: { output: "first answer", ok: false, device: { request: "location", outcome: "declined" } },
    };
    const result = await answerLocationCall(
      {
        streamId: "s",
        userId,
        producer: { emit: (e: StreamEventKind) => { emitted.push(e); } } as never,
        assistantMsgId: "m",
        slot: { yieldWhile: () => { throw new Error("must not wait"); } } as never,
        signal: new AbortController().signal,
        askDeadline: () => ({ ms: 1000, expiresAt: Date.now() + 1000, basis: "setting" }),
        scheduled: false,
        memo,
      },
      "call_2",
      {},
    );
    expect(result).toEqual({ output: "first answer", ok: false, device: { request: "location", outcome: "declined" } });
    expect(emitted).toEqual([
      { kind: "tool.result", message_id: "m", call_id: "call_2", tool: "get_location", output: "first answer", ok: false, device: { request: "location", outcome: "declined" } },
    ]);
  });
});
