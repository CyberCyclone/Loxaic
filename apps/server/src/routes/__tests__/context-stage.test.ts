import Fastify from "fastify";
import { v4 as uuid } from "uuid";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db, eq, inArray } from "@loxaic/db";
import { conversations, localModels, usageRecords, user } from "@loxaic/db/schema";
import type { ContextStageStatus, StreamEventKind } from "@loxaic/types";
import { getLocalModelRow, invalidateLocalModelCache } from "../../llama/catalog.ts";
import { __resetStageSwitchForTest } from "../../llama/context-stage-switch.ts";
import { neededByOthers, smallestStageFor } from "../../llama/context-stage-policy.ts";
import { getStreamBroker, initStreamBroker } from "../../streams/index.ts";
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
vi.mock("../../auth/middleware", () => ({
  authenticate: () => Promise.resolve(currentUser.id),
  requireAdmin: () => Promise.resolve(currentUser.id),
}));
const { contextStageRoutes } = await import("../context-stage.ts");
const { autoExtend, stageForNewConversation } = await import("../../streams/runs/stageRun.ts");

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

describe("when a conversation fills the window", () => {
  it("a model set to compact leaves it to compaction", async () => {
    expect(await autoExtend({ userId: alice, conversationId: aliceConv, model, surface: "chat" })).toBe(false);
  });

  it("a model set to extend moves to the next stage in a stage run, whoever may change it by hand", async () => {
    await setModel({ contextStages: stagesConfig({ whenFull: "extend", whoMayChange: "admins" }) });
    expect(await autoExtend({ userId: alice, conversationId: aliceConv, model, surface: "chat" })).toBe(true);
    await waitFor(async () => (await activeStage()) === 1);
  });

  it("at its largest stage, compacts instead", async () => {
    await setModel({ activeStage: 2, contextStages: stagesConfig({ whenFull: "extend" }) });
    expect(await autoExtend({ userId: alice, conversationId: aliceConv, model, surface: "chat" })).toBe(false);
  });
});
