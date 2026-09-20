import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { v4 as uuid } from "uuid";

process.env.MCP_ENCRYPTION_KEY ??= "provider-wire-test-key";

import { db, eq, inArray } from "@loxaic/db";
import { inferenceProviders, user } from "@loxaic/db/schema";
import { streamCompletion } from "../provider.ts";
import {
  __resetModelCachesForTest,
  getModelInfo,
  listBackendModels,
  probeProviderModels,
  resolveWindow,
} from "../models.ts";
import { __resetProviderCacheForTest, createProvider } from "../providers.ts";
import { startMockOpenAi, type MockOpenAi } from "./mock-openai-server.ts";

/**
 * What actually goes over the wire to an added provider.
 *
 * Asserted against a real HTTP server rather than a mocked `streamCompletion`,
 * because every claim here is about the request itself — the bearer, the
 * model id with our own prefix stripped off, the custom header — and a mock of
 * the function that builds it could not tell us any of them.
 */
const created: string[] = [];
const adminId = `test-wire-${uuid()}`;
let mock: MockOpenAi;

const API_KEY = "sk-wire-test-0123456789abcdef";

async function makeProvider(input: Record<string, unknown> = {}) {
  const row = await createProvider(
    { name: `W ${uuid().slice(0, 8)}`, baseUrl: mock.apiBase, apiKey: API_KEY, ...input },
    adminId,
  );
  created.push(row.id);
  return row;
}

async function collect(model: string): Promise<{ text: string; cached: number | null }> {
  let text = "";
  let cached: number | null = null;
  for await (const ev of streamCompletion(model, [{ role: "user", content: "hello" }])) {
    if (ev.type === "delta") text += ev.content;
    if (ev.type === "done") cached = ev.result.cachedTokens;
  }
  return { text, cached };
}

beforeAll(async () => {
  mock = await startMockOpenAi({ apiKey: API_KEY });
  await db.insert(user).values({
    id: adminId,
    name: "Wire Test Admin",
    email: `${adminId}@example.test`,
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return async () => {
    await db.delete(inferenceProviders).where(eq(inferenceProviders.createdBy, adminId));
    await db.delete(user).where(eq(user.id, adminId));
    await mock.stop();
  };
});

afterEach(async () => {
  if (created.length) await db.delete(inferenceProviders).where(inArray(inferenceProviders.id, created));
  created.length = 0;
  mock.requests.length = 0;
  __resetProviderCacheForTest();
  __resetModelCachesForTest();
});

describe("a completion through an added provider", () => {
  it("sends the key as a bearer and the model without our prefix", async () => {
    const row = await makeProvider();
    const { text } = await collect(`${row.slug}::mock-remote-model`);

    expect(text).toBe("Hello from the mock provider.");
    expect(mock.completions).toHaveLength(1);
    expect(mock.completions[0].authorization).toBe(`Bearer ${API_KEY}`);
    // The `slug::` prefix is ours. A backend asked for "work::gpt-4o" would
    // either 404 or — on llama.cpp, which ignores the field — quietly answer
    // with whatever it has loaded.
    expect(mock.completions[0].body.model).toBe("mock-remote-model");
  });

  it("runs for real even when mock inference is on", async () => {
    // MOCK_INFERENCE stands in for the backend this deployment was configured
    // with, not for a provider an admin added — which is what lets the e2e
    // mock lane exercise the whole provider path with nothing stubbed.
    const previous = process.env.MOCK_INFERENCE;
    process.env.MOCK_INFERENCE = "true";
    try {
      const row = await makeProvider();
      const { text } = await collect(`${row.slug}::mock-remote-model`);
      expect(text).toBe("Hello from the mock provider.");
      expect(mock.completions).toHaveLength(1);
    } finally {
      if (previous === undefined) delete process.env.MOCK_INFERENCE;
      else process.env.MOCK_INFERENCE = previous;
    }
  });

  it("sends the admin's custom headers", async () => {
    const row = await makeProvider({ headers: { "HTTP-Referer": "https://loxaic.local", "X-Title": "Loxaic" } });
    await collect(`${row.slug}::mock-remote-model`);
    expect(mock.completions[0].headers["http-referer"]).toBe("https://loxaic.local");
    expect(mock.completions[0].headers["x-title"]).toBe("Loxaic");
  });

  it("reports the provider's own cached-token figure", async () => {
    // llama.cpp calls it `timings.cache_n`; a hosted provider reports
    // `usage.prompt_tokens_details.cached_tokens`. Either is ground truth.
    const row = await makeProvider();
    const { cached } = await collect(`${row.slug}::mock-remote-model`);
    expect(cached).toBe(4);
  });
});

describe("a rejected key", () => {
  it("does not put the key into the error the conversation stores", async () => {
    // Whatever this throws is persisted on the message row and re-served to
    // everyone on the thread, shared viewers included — and the mock echoes
    // the rejected key exactly as OpenAI's own 401 does.
    const row = await makeProvider({ apiKey: "sk-wrong-key-0123456789" });
    let message = "";
    try {
      await collect(`${row.slug}::mock-remote-model`);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toBeTruthy();
    expect(message).not.toContain("sk-wrong-key-0123456789");
    // Replaced outright rather than appended to, so no part of the vendor's
    // wording — which may quote the key — survives.
    expect(message).toMatch(/rejected this server's API key/i);
    expect(message).toContain(row.name);
  });
});

describe("listing an added provider's models", () => {
  it("qualifies every id and keeps the upstream one beside it", async () => {
    const row = await makeProvider();
    const models = await listBackendModels();
    const mine = models.filter((m) => m.provider_id === row.id);
    expect(mine).toHaveLength(1);
    expect(mine[0].id).toBe(`${row.slug}::mock-remote-model`);
    expect(mine[0].upstream_id).toBe("mock-remote-model");
    expect(mine[0].provider_name).toBe(row.name);
    // A hosted model is always ready: reporting it unloaded would emit
    // `model.loading` every turn and describe a JIT load that never happens.
    expect(mine[0].loaded).toBe(true);
    expect(mine[0].location).toBe("remote");
  });

  it("applies the allowlist", async () => {
    const row = await makeProvider({
      modelAllowlist: ["something-else"],
    });
    const models = await listBackendModels();
    expect(models.filter((m) => m.provider_id === row.id)).toHaveLength(0);
  });

  it("uses a declared context length as the window", async () => {
    const row = await makeProvider();
    expect(await resolveWindow(`${row.slug}::mock-remote-model`)).toBe(128_000);
  });

  it("reports an unknown window as null rather than guessing", async () => {
    // OpenAI's /v1/models reports no context length at all. A default of 8192
    // would have every GPT conversation auto-compacting at about 7k tokens —
    // a billed call and a full prompt re-evaluation, over and over, on a model
    // whose real window is twenty times that.
    const bare = await startMockOpenAi({ apiKey: API_KEY, models: [{ id: "no-context-model" }] });
    try {
      const row = await makeProvider({ baseUrl: bare.apiBase });
      const info = await getModelInfo(`${row.slug}::no-context-model`);
      expect(info).toBeTruthy();
      expect(info?.context_source).toBe("default");
      expect(await resolveWindow(`${row.slug}::no-context-model`)).toBeNull();
    } finally {
      await bare.stop();
    }
  });

  it("falls back to the allowlist when the provider will not list", async () => {
    // A provider whose /models needs different auth than its completions
    // endpoint is still usable: the ids an admin typed are the catalogue.
    const row = await makeProvider({
      baseUrl: "http://127.0.0.1:1/v1",
      modelAllowlist: ["hand-entered-model"],
    });
    const models = await listBackendModels();
    const mine = models.filter((m) => m.provider_id === row.id);
    expect(mine.map((m) => m.upstream_id)).toEqual(["hand-entered-model"]);
  });

  it("does not claim GGUF for a backend that never said so", async () => {
    // Found by driving the real UI: a hand-entered provider has no preset, and
    // keying the format on that put a GGUF badge on Claude and GPT. Only a
    // backend that answered /props — which is llama.cpp identifying itself —
    // is known to serve GGUF; the mock has no /props, like every hosted API.
    const row = await makeProvider();
    const info = await getModelInfo(`${row.slug}::mock-remote-model`);
    expect(info?.format).toBe("—");
  });

  it("reports the endpoint the admin configured, not the probe's", async () => {
    // Also found in the browser. The LM Studio probe is an opportunistic guess
    // at a path nobody entered, and it fails on every backend that is not LM
    // Studio — so reporting its 401 sent an admin who had configured `…/v1`
    // looking for `…/api/v0/models`, a URL that is not theirs.
    const row = await makeProvider({ apiKey: "sk-wrong-key-0123456789" });
    let message = "";
    try {
      await probeProviderModels(row.id);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("/v1/models");
    expect(message).not.toContain("/api/v0/models");
  });

  it("lets one unreachable provider fail without taking the list down", async () => {
    const dead = await makeProvider({ baseUrl: "http://127.0.0.1:1/v1" });
    const live = await makeProvider();
    const models = await listBackendModels();
    expect(models.filter((m) => m.provider_id === dead.id)).toHaveLength(0);
    expect(models.filter((m) => m.provider_id === live.id)).toHaveLength(1);
  });
});
