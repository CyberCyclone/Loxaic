import Fastify from "fastify";
import { v4 as uuid } from "uuid";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db, eq, inArray } from "@loxaic/db";
import { conversations, localModels, usageRecords, user } from "@loxaic/db/schema";
import type { ContextStageStatus, StreamEventKind } from "@loxaic/types";
import { getLocalModelRow, invalidateLocalModelCache } from "../../llama/catalog.ts";
import { __resetStageSwitchForTest, pendingStage } from "../../llama/context-stage-switch.ts";
import { __resetSchedulerForTest, acquireRunSlot, resetSlotProbe } from "../../inference/scheduler.ts";
import { neededByOthers, smallestStageFor } from "../../llama/context-stage-policy.ts";
import { getStreamBroker, initStreamBroker } from "../../streams/index.ts";
import { registerRun, unregisterRun } from "../../streams/registry.ts";
import type { StreamProducer } from "../../streams/broker.ts";

/**
 * `/v1/models/context-stage` through a real Fastify instance, only the session
 * stubbed. What is held: who may change a stage, the refusals that protect
 * someone else's conversation and this one, a change from a conversation being
 * a stage run whose steps reach the stream log, and the two automatic paths —
 * a new conversation stepping down, and `whenFull: "extend"`.
 *
 * With the router off: the switch still writes the stage and reports each
 * step, and nothing here needs a GPU. context-stage-switch.test.ts covers the
 * reload against the fake router.
 */
const currentUser = { id: "" };
// Two seams the failure cases need: a stage switch that can be made to fail or
// throw, and a compaction that records that it was asked for.
const seam = vi.hoisted(() => ({
  applyStageChange: null as null | ((...a: unknown[]) => Promise<unknown>),
  compactions: [] as unknown[],
  compact: null as null | ((input: unknown) => Promise<{ streamId: string; conversationId: string }>),
}));
vi.mock("../../llama/context-stage-switch.ts", async (original) => {
  const actual = await original<typeof import("../../llama/context-stage-switch.ts")>();
  return {
    ...actual,
    applyStageChange: (...a: Parameters<typeof actual.applyStageChange>) =>
      seam.applyStageChange ? (seam.applyStageChange(...a) as ReturnType<typeof actual.applyStageChange>) : actual.applyStageChange(...a),
  };
});
vi.mock("../../streams/runs/compactRun.ts", async (original) => {
  const actual = await original<typeof import("../../streams/runs/compactRun.ts")>();
  return {
    ...actual,
    startCompactRun: (input: unknown) => {
      seam.compactions.push(input);
      return seam.compact ? seam.compact(input) : Promise.resolve({ streamId: uuid(), conversationId: "x" });
    },
  };
});
vi.mock("../../auth/middleware", () => ({
  authenticate: () => Promise.resolve(currentUser.id),
  requireAdmin: () => Promise.resolve(currentUser.id),
}));
const { contextStageRoutes } = await import("../context-stage.ts");
const { __resetLeftToPersonForTest, autoExtend, leaveCompactionToPerson, stageForNewConversation, startStageRun } = await import("../../streams/runs/stageRun.ts");

const host = `test-stage-routes-${uuid()}`;
const model = `test/stage-routes-${uuid().slice(0, 8)}:Q4_K_M`;
const admin = `test-stage-admin-${uuid()}`;
const alice = `test-stage-alice-${uuid()}`;
const bob = `test-stage-bob-${uuid()}`;
let aliceConv = "";
let bobConv = "";
const app = Fastify();
contextStageRoutes(app);

const stagesConfig = (over: Record<string, unknown> = {}) => ({
  enabled: true,
  stages: [{ ctxSize: 16384 }, { ctxSize: 32768 }],
  ...over,
});

async function setModel(patch: Partial<typeof localModels.$inferInsert>): Promise<void> {
  await db.update(localModels).set(patch).where(eq(localModels.hostId, host));
  invalidateLocalModelCache();
}

async function activeStage(): Promise<number> {
  invalidateLocalModelCache();
  return (await getLocalModelRow(model))?.activeStage ?? -1;
}

async function use(userId: string, conversationId: string, tokens: number): Promise<void> {
  await db.insert(usageRecords).values({ id: uuid(), userId, conversationId, model, inputTokens: tokens, outputTokens: 0 });
}

async function waitFor(check: () => Promise<boolean>, ms = 10_000): Promise<void> {
  const until = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > until) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function stageEvents(streamId: string): Promise<ContextStageStatus[]> {
  const records = await getStreamBroker().readFrom(streamId, -1);
  return records.flatMap((r) => (r.event.kind === "context.stage" ? [r.event] : []));
}

function fakeProducer(): StreamProducer & { events: StreamEventKind[] } {
  const events: StreamEventKind[] = [];
  return { events, emit: (e: StreamEventKind) => { events.push(e); } } as never;
}

beforeAll(async () => {
  vi.stubEnv("LOXAIC_INSTANCE_ID", host);
  vi.stubEnv("LLAMA_MODE", "off");
  // The cooldown between one person's switches would turn every case that
  // switches twice into a refusal; the cases about it set their own.
  vi.stubEnv("CONTEXT_STAGE_COOLDOWN_MS", "0");
  await initStreamBroker();
  await app.ready();
  const now = new Date();
  await db.insert(user).values([
    { id: admin, name: "Admin", email: `${admin}@example.test`, emailVerified: true, role: "admin", createdAt: now, updatedAt: now },
    { id: alice, name: "Alice", email: `${alice}@example.test`, emailVerified: true, createdAt: now, updatedAt: now },
    { id: bob, name: "Bob", email: `${bob}@example.test`, emailVerified: true, createdAt: now, updatedAt: now },
  ]);
  [{ id: aliceConv }] = await db.insert(conversations).values({ ownerId: alice, title: "alice's" }).returning();
  [{ id: bobConv }] = await db.insert(conversations).values({ ownerId: bob, title: "bob's" }).returning();
  await db.insert(localModels).values({
    id: model,
    hostId: host,
    repo: model.split(":")[0],
    revision: "0".repeat(40),
    quant: "Q4_K_M",
    files: [{ path: "m.gguf", size: 1, sha256: null }],
    sizeBytes: 1,
    status: "ready",
    enabled: true,
    displayName: "Staged",
    publisher: "test",
    meta: { nCtxTrain: 8192, nLayers: 28 },
    loadSettings: { ctxSize: 8192 },
    contextStages: stagesConfig(),
  });
  invalidateLocalModelCache();
});

afterAll(async () => {
  __resetStageSwitchForTest();
  await db.delete(usageRecords).where(eq(usageRecords.model, model));
  await db.delete(conversations).where(inArray(conversations.id, [aliceConv, bobConv]));
  await db.delete(user).where(inArray(user.id, [admin, alice, bob]));
  await db.delete(localModels).where(eq(localModels.hostId, host));
  vi.unstubAllEnvs();
  await app.close();
});

beforeEach(async () => {
  currentUser.id = alice;
  await db.delete(usageRecords).where(eq(usageRecords.model, model));
  await setModel({ activeStage: 0, contextStages: stagesConfig() });
});

describe("the policy", () => {
  it("finds the smallest stage a conversation fits in, and the lowest others still need", () => {
    const windows = [8192, 16384, 32768];
    expect(smallestStageFor(1000, windows)).toBe(0);
    expect(smallestStageFor(8000, windows)).toBe(1); // over 85% of 8K
    expect(smallestStageFor(20000, windows)).toBe(2);
    expect(smallestStageFor(99999, windows)).toBe(2); // nothing holds it: the largest
    expect(neededByOthers([], windows)).toBe(0);
    expect(neededByOthers([{ conversationId: "x", tokens: 20000, at: new Date() }], windows)).toBe(2);
  });
});

describe("GET /v1/models/context-stage", () => {
  it("says what each stage is, what this conversation needs, and who else is using the model", async () => {
    await use(alice, aliceConv, 10000);
    await use(bob, bobConv, 5000);
    const res = await app.inject({ method: "GET", url: `/v1/models/context-stage?model=${encodeURIComponent(model)}&conversation_id=${aliceConv}` });
    expect(res.statusCode).toBe(200);
    const body = res.json<Record<string, unknown>>();
    expect(body).toMatchObject({
      active: 0,
      may_change: true,
      who_may_change: "everyone",
      when_full: "compact",
      conversation_tokens: 10000,
      recommended: 1, // 10000 is past 75% of 8K, within 16K
      blocked_down_to: 0, // Bob's 5000 fits the standard stage
      others: { count: 1, running: 0 },
    });
    expect((body.stages as { context_tokens: number; yarn: boolean }[]).map((s) => [s.context_tokens, s.yarn])).toEqual([
      [8192, false], [16384, true], [32768, true],
    ]);
  });

  it("does not describe a conversation the caller cannot see", async () => {
    const res = await app.inject({ method: "GET", url: `/v1/models/context-stage?model=${encodeURIComponent(model)}&conversation_id=${bobConv}` });
    expect(res.statusCode).toBe(404);
  });
});

describe("POST /v1/models/context-stage", () => {
  const post = (payload: Record<string, unknown>) => app.inject({ method: "POST", url: "/v1/models/context-stage", payload: { model, ...payload } });

  it("an admins-only model refuses anyone else, and says who can", async () => {
    await setModel({ contextStages: stagesConfig({ whoMayChange: "admins" }) });
    const res = await post({ stage: 1 });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: "not_allowed", error: "An admin controls this model's context." });
    currentUser.id = admin;
    expect((await post({ stage: 1 })).statusCode).toBe(200);
    await waitFor(async () => (await activeStage()) === 1);
  });

  it("will not step down under someone else's long conversation", async () => {
    await setModel({ activeStage: 2 });
    await use(bob, bobConv, 20000);
    const res = await post({ stage: 0 });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "others_need_stage" });
    expect(res.json<{ error: string }>().error).toMatch(/still needs 32K/);
  });

  it("will not shrink the window under this conversation without compacting first", async () => {
    await setModel({ activeStage: 2 });
    await use(alice, aliceConv, 20000);
    const res = await post({ stage: 1, conversation_id: aliceConv });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "conversation_too_large" });
  });

  it("from a conversation, runs as a stage run whose steps reach the stream log", async () => {
    const res = await post({ stage: 2, conversation_id: aliceConv });
    expect(res.statusCode).toBe(200);
    const { started, stream_id } = res.json<{ started: string; stream_id: string }>();
    expect(started).toBe("stage");
    await waitFor(async () => (await getStreamBroker().getMeta(stream_id))?.status === "complete");
    expect(await activeStage()).toBe(2);
    const steps = await stageEvents(stream_id);
    expect(steps.map((s) => s.step)).toEqual(["reloading", "applied"]);
    expect(steps.at(-1)).toMatchObject({ reason: "chosen", auto: false, from_stage: 0, to_stage: 2, to_tokens: 32768, yarn_factor: 4 });
  });

  it("a viewer cannot change the stage from someone else's conversation", async () => {
    const res = await post({ stage: 1, conversation_id: bobConv });
    expect(res.statusCode).toBe(404);
  });

  it("withdrawing with nothing pending says so", async () => {
    const res = await app.inject({ method: "DELETE", url: `/v1/models/context-stage?model=${encodeURIComponent(model)}` });
    expect(res.json()).toEqual({ withdrawn: false });
  });
});

describe("a stage run", () => {
  afterEach(() => { seam.applyStageChange = null; });

  it("ends as a failure with a reason when something under it throws, never as a silent cancel", async () => {
    seam.applyStageChange = () => Promise.reject(new Error("database went away"));
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => { unhandled.push(e); };
    process.on("unhandledRejection", onUnhandled);
    try {
      const { streamId } = await startStageRun({ userId: alice, conversationId: aliceConv, model, target: 1, reason: "chosen", auto: false, surface: "chat" });
      await waitFor(async () => (await getStreamBroker().getMeta(streamId))?.status !== "active");
      expect((await getStreamBroker().getMeta(streamId))?.status).toBe("error");
      expect((await stageEvents(streamId)).at(-1)).toMatchObject({ step: "failed", message: expect.stringMatching(/stopped unexpectedly: database went away/) as string });
      await new Promise((r) => setTimeout(r, 50));
      expect(unhandled).toHaveLength(0);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("claims the conversation at once, so two that arrive together cannot both run", async () => {
    let finish: (v: unknown) => void = () => undefined;
    seam.applyStageChange = () => new Promise((resolve) => { finish = resolve; });
    const start = () => startStageRun({ userId: alice, conversationId: aliceConv, model, target: 1, reason: "chosen", auto: false, surface: "chat" });
    const results = await Promise.allSettled([start(), start()]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    const rejected = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(rejected?.reason).toMatchObject({ message: expect.stringMatching(/already in progress/) as string });
    finish({ kind: "applied", stage: 1 });
    const ok = results.find((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof startStageRun>>> => r.status === "fulfilled");
    await waitFor(async () => (await getStreamBroker().getMeta(ok?.value.streamId ?? ""))?.status === "complete");
  });
});

describe("compact and switch", () => {
  afterEach(() => { seam.compact = null; });

  it("starts the switch only once the compaction has let go of the conversation", async () => {
    // As the real compaction run does it: the stream's end is announced first,
    // and the conversation is released a little later in its `finally`.
    seam.compact = async () => {
      const streamId = uuid();
      const producer = await getStreamBroker().openProducer({ streamId, conversationId: aliceConv, userId: alice, surface: "chat" });
      registerRun({ streamId, conversationId: aliceConv, userId: alice, abort: new AbortController(), approvals: new Map(), model });
      setTimeout(() => {
        void (async () => {
          await producer.end("complete");
          await new Promise((r) => setTimeout(r, 200));
          unregisterRun(streamId);
        })();
      }, 50);
      return { streamId, conversationId: aliceConv };
    };
    const res = await app.inject({ method: "POST", url: "/v1/models/context-stage", payload: { model, stage: 1, conversation_id: aliceConv, compact_first: true } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ started: "compaction" });
    // Not before the conversation is free, and then without anyone asking again.
    await waitFor(async () => (await activeStage()) === 1, 8000);
  });
});

describe("how often, and whose switch", () => {
  const post = (payload: Record<string, unknown>) => app.inject({ method: "POST", url: "/v1/models/context-stage", payload: { model, ...payload } });
  const del = () => app.inject({ method: "DELETE", url: `/v1/models/context-stage?model=${encodeURIComponent(model)}` });

  afterEach(() => {
    vi.stubEnv("CONTEXT_STAGE_COOLDOWN_MS", "0");
    __resetStageSwitchForTest();
    __resetSchedulerForTest();
    Reflect.deleteProperty(process.env, "INFERENCE_MAX_CONCURRENT_RUNS");
  });

  it("makes someone wait after a switch before asking for another — an admin and the same stage are exempt", async () => {
    __resetStageSwitchForTest(); // earlier cases' switches count toward the cooldown
    vi.stubEnv("CONTEXT_STAGE_COOLDOWN_MS", "60000");
    expect((await post({ stage: 1 })).statusCode).toBe(200);
    await waitFor(async () => (await activeStage()) === 1);

    // Alternating stages is the loop that would stall every other conversation.
    const again = await post({ stage: 0 });
    expect(again.statusCode).toBe(429);
    expect(again.json()).toMatchObject({ code: "too_soon" });
    expect(again.json<{ error: string }>().error).toMatch(/again in \d+ s/);
    expect(await activeStage()).toBe(1);

    // Asking for where the model already is changes nothing, so it is not refused.
    expect((await post({ stage: 1 })).statusCode).toBe(200);
    // An admin decides the stage, and is not limited.
    currentUser.id = admin;
    expect((await post({ stage: 0 })).statusCode).toBe(200);
    await waitFor(async () => (await activeStage()) === 0);
  });

  it("will not let someone replace another person's waiting switch, but the starter may", async () => {
    process.env.INFERENCE_MAX_CONCURRENT_RUNS = "1";
    resetSlotProbe();
    const reply = await acquireRunSlot({ signal: new AbortController().signal, onQueued: () => undefined });
    expect((await post({ stage: 1 })).statusCode).toBe(200); // alice's, detached: it waits behind the reply
    await waitFor(() => Promise.resolve(pendingStage(model) === 1));

    currentUser.id = bob;
    const replaced = await post({ stage: 2 });
    expect(replaced.statusCode).toBe(409);
    expect(replaced.json()).toMatchObject({ code: "switch_pending" });
    expect(pendingStage(model)).toBe(1);

    // The person who asked can change their mind.
    currentUser.id = alice;
    expect((await post({ stage: 2 })).statusCode).toBe(200);
    await waitFor(() => Promise.resolve(pendingStage(model) === 2));
    reply?.release();
    await waitFor(async () => (await activeStage()) === 2);
  });

  it("only its starter, an admin, or someone who can edit its conversation may cancel a switch", async () => {
    process.env.INFERENCE_MAX_CONCURRENT_RUNS = "1";
    resetSlotProbe();
    const reply = await acquireRunSlot({ signal: new AbortController().signal, onQueued: () => undefined });
    // Alice's, started from her own conversation.
    const started = await post({ stage: 1, conversation_id: aliceConv });
    expect(started.statusCode).toBe(200);
    await waitFor(() => Promise.resolve(pendingStage(model) === 1));

    currentUser.id = bob;
    const refused = await del();
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ code: "not_allowed" });
    expect(pendingStage(model)).toBe(1);

    currentUser.id = admin;
    expect((await del()).json()).toEqual({ withdrawn: true });
    await waitFor(() => Promise.resolve(pendingStage(model) === null));

    // And the starter's own cancel still works.
    currentUser.id = alice;
    expect((await post({ stage: 1, conversation_id: aliceConv })).statusCode).toBe(200);
    await waitFor(() => Promise.resolve(pendingStage(model) === 1));
    expect((await del()).json()).toEqual({ withdrawn: true });
    reply?.release();
    expect(await activeStage()).toBe(0);
  });
});

describe("a new conversation", () => {
  it("steps the model back down to standard, reporting it on its own stream", async () => {
    await setModel({ activeStage: 2 });
    const producer = fakeProducer();
    await stageForNewConversation({ userId: alice, conversationId: aliceConv, model, producer, signal: new AbortController().signal });
    expect(await activeStage()).toBe(0);
    const steps = producer.events.flatMap((e) => (e.kind === "context.stage" ? [e] : []));
    expect(steps.at(-1)).toMatchObject({ step: "applied", reason: "new-conversation", auto: true, to_stage: 0 });
  });

  it("stops where another conversation still needs it, and says why", async () => {
    await setModel({ activeStage: 2 });
    await use(bob, bobConv, 10000); // needs stage 1
    const producer = fakeProducer();
    await stageForNewConversation({ userId: alice, conversationId: aliceConv, model, producer, signal: new AbortController().signal });
    expect(await activeStage()).toBe(1);
    const last = producer.events.filter((e) => e.kind === "context.stage").at(-1);
    expect(last).toMatchObject({ step: "applied", to_stage: 1, message: expect.stringMatching(/still needs/) as string });
  });

  it("starts at the stage chosen in Context settings, and says nothing when it is already there", async () => {
    const producer = fakeProducer();
    await stageForNewConversation({ userId: alice, conversationId: aliceConv, model, chosen: 2, producer, signal: new AbortController().signal });
    expect(await activeStage()).toBe(2);
    const quiet = fakeProducer();
    await stageForNewConversation({ userId: alice, conversationId: aliceConv, model, chosen: 2, producer: quiet, signal: new AbortController().signal });
    expect(quiet.events).toEqual([]);
  });

  it("a refused choice is said on the card, and the run goes on", async () => {
    await setModel({ contextStages: stagesConfig({ whoMayChange: "admins" }) });
    const producer = fakeProducer();
    await stageForNewConversation({ userId: alice, conversationId: aliceConv, model, chosen: 2, producer, signal: new AbortController().signal });
    expect(await activeStage()).toBe(0);
    expect(producer.events.at(-1)).toMatchObject({ kind: "context.stage", step: "failed", message: "An admin controls this model's context." });
  });
});

describe("a turn that crosses the compaction threshold, on a model set to compact", () => {
  const leave = (userId = alice, conversationId = aliceConv) => leaveCompactionToPerson({ userId, conversationId, model });
  beforeEach(() => { __resetLeftToPersonForTest(); __resetStageSwitchForTest(); });

  it("is left to the person the first time at a stage, and compacts the next time nobody chose", async () => {
    // A single turn can jump from below the prompt (75%) past compaction (85%);
    // compacting at once meant Extend was never offered.
    expect(await leave()).toBe(true);
    expect(await leave()).toBe(false);
    // At the next stage it is asked again.
    await setModel({ activeStage: 1 });
    expect(await leave()).toBe(true);
  });

  it("is not left to anyone at the largest stage, or on a model that extends by itself", async () => {
    await setModel({ activeStage: 2 });
    expect(await leave()).toBe(false);
    await setModel({ activeStage: 0, contextStages: stagesConfig({ whenFull: "extend" }) });
    expect(await leave()).toBe(false);
  });

  it("is not left to someone who could not extend: an admins-only model compacts for everyone else", async () => {
    await setModel({ contextStages: stagesConfig({ whoMayChange: "admins" }) });
    expect(await leave()).toBe(false);
    // An admin, on a conversation of their own, is asked.
    const [{ id: adminConv }] = await db.insert(conversations).values({ ownerId: admin, title: "admin's" }).returning();
    try {
      expect(await leave(admin, adminConv)).toBe(true);
    } finally {
      await db.delete(conversations).where(eq(conversations.id, adminConv));
    }
  });

  it("is not left to anyone on a routine's conversation, which has nobody to ask", async () => {
    const [{ id: routineConv }] = await db.insert(conversations).values({ ownerId: alice, title: "a routine's", kind: "routine" }).returning();
    try {
      expect(await leave(alice, routineConv)).toBe(false);
    } finally {
      await db.delete(conversations).where(eq(conversations.id, routineConv));
    }
  });
});

describe("when a conversation fills the window", () => {
  it("a model set to compact leaves it to compaction", async () => {
    expect(await autoExtend({ userId: alice, conversationId: aliceConv, model, surface: "chat", canCompact: true })).toBe(false);
  });

  it("a model set to extend moves to the next stage in a stage run, whoever may change it by hand", async () => {
    await setModel({ contextStages: stagesConfig({ whenFull: "extend", whoMayChange: "admins" }) });
    expect(await autoExtend({ userId: alice, conversationId: aliceConv, model, surface: "chat", canCompact: true })).toBe(true);
    await waitFor(async () => (await activeStage()) === 1);
  });

  it("a failed extension compacts instead — but only where compaction would have fired", async () => {
    await setModel({ contextStages: stagesConfig({ whenFull: "extend" }) });
    seam.applyStageChange = () => Promise.resolve({ kind: "failed", message: "llama.cpp could not load it" });
    seam.compactions.length = 0;
    expect(await autoExtend({ userId: alice, conversationId: aliceConv, model, surface: "chat", canCompact: true })).toBe(true);
    await waitFor(() => Promise.resolve(seam.compactions.length === 1));
    expect(seam.compactions[0]).toMatchObject({ conversationId: aliceConv, auto: true });

    // A short thread is over the threshold after one big paste: extending ignores
    // the floor, but the fallback must not compact it every turn.
    seam.compactions.length = 0;
    expect(await autoExtend({ userId: alice, conversationId: aliceConv, model, surface: "chat", canCompact: false })).toBe(true);
    await new Promise((r) => setTimeout(r, 300));
    expect(seam.compactions).toHaveLength(0);
  });

  it("at its largest stage, compacts instead", async () => {
    await setModel({ activeStage: 2, contextStages: stagesConfig({ whenFull: "extend" }) });
    expect(await autoExtend({ userId: alice, conversationId: aliceConv, model, surface: "chat", canCompact: true })).toBe(false);
  });
});
