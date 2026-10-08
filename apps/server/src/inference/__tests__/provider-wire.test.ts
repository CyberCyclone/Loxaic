import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { v4 as uuid } from "uuid";

process.env.MCP_ENCRYPTION_KEY ??= "provider-wire-test-key";

import { db, eq, inArray } from "@loxaic/db";
import { conversations, inferenceProviders, messages, usageRecords, user } from "@loxaic/db/schema";
import type { ContentBlock } from "@loxaic/types";
import { initStreamBroker } from "../../streams/index.ts";
import { getRunByConversation } from "../../streams/registry.ts";
import { startChatRun } from "../../streams/runs/chatRun.ts";
import { estimateTallyTokens, tallyChatMessages } from "../context.ts";
import type { ChatMessage } from "../provider.ts";
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

describe("the thinking level on an added provider", () => {
  /** Qwen3.8's validation of the effort, as a llama.cpp `/props` reports it. */
  const TEMPLATE =
    "{%- if enable_thinking is undefined or enable_thinking is true %}" +
    "{%- if reasoning_effort not in ('xhigh', 'high', 'medium', 'low') %}{{ raise_exception('no') }}{%- endif %}{%- endif %}";

  async function send(model: string, level: "None" | "Low" | "Medium" | "High") {
    const { thinkingFields } = await import("../thinking.ts");
    const info = await getModelInfo(model);
    for await (const _ of streamCompletion(model, [{ role: "user", content: "hi" }], { thinking: thinkingFields(info?.thinking, level) })) {
      // drain
    }
  }

  it("detects llama.cpp's levels from /props and sends reasoning_effort in the body", async () => {
    const llama = await startMockOpenAi({ apiKey: API_KEY, nCtx: 8192, chatTemplate: TEMPLATE });
    try {
      const row = await makeProvider({ baseUrl: llama.apiBase });
      const ref = `${row.slug}::mock-remote-model`;
      expect((await getModelInfo(ref))?.thinking?.levels).toEqual(["None", "Low", "Medium", "High"]);
      await send(ref, "High");
      await send(ref, "None");
      expect(llama.completions.map((r) => r.body.reasoning_effort)).toEqual(["high", "none"]);
    } finally {
      await llama.stop();
    }
  });

  it("takes OpenRouter's word for which models reason, and sends reasoning.effort", async () => {
    const router = await startMockOpenAi({
      apiKey: API_KEY,
      models: [
        { id: "deepseek/deepseek-r1", supported_parameters: ["tools", "reasoning"] },
        { id: "meta/llama-3.3-70b", supported_parameters: ["tools"] },
      ],
    });
    try {
      const row = await makeProvider({ baseUrl: router.apiBase, preset: "openrouter" });
      expect((await getModelInfo(`${row.slug}::deepseek/deepseek-r1`))?.thinking?.dialect).toBe("openrouter");
      expect((await getModelInfo(`${row.slug}::meta/llama-3.3-70b`))?.thinking).toBeUndefined();
      await send(`${row.slug}::deepseek/deepseek-r1`, "Low");
      await send(`${row.slug}::meta/llama-3.3-70b`, "High");
      const [reasoner, plain] = router.completions;
      expect(reasoner.body.reasoning).toEqual({ effort: "low" });
      // A model that takes no level is sent no field it might refuse.
      expect(plain.body).not.toHaveProperty("reasoning");
      expect(plain.body).not.toHaveProperty("reasoning_effort");
    } finally {
      await router.stop();
    }
  });

  it("knows OpenAI's reasoning models by id, and sends a hosted API nothing otherwise", async () => {
    const openai = await startMockOpenAi({ apiKey: API_KEY, models: [{ id: "gpt-5.1" }, { id: "gpt-4o" }] });
    try {
      const row = await makeProvider({ baseUrl: openai.apiBase, preset: "openai" });
      await send(`${row.slug}::gpt-5.1`, "None");
      await send(`${row.slug}::gpt-4o`, "High");
      expect(openai.completions[0].body.reasoning_effort).toBe("none");
      expect(openai.completions[1].body).not.toHaveProperty("reasoning_effort");
      // A custom provider with no /props: unknown, so nothing.
      const custom = await makeProvider();
      expect((await getModelInfo(`${custom.slug}::mock-remote-model`))?.thinking).toBeUndefined();
    } finally {
      await openai.stop();
    }
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

  it("uses the admin's size for a model that reports none", async () => {
    // Without one, compaction never acts: a conversation on the model grows
    // until the provider refuses a request, and then cannot continue.
    const bare = await startMockOpenAi({ apiKey: API_KEY, models: [{ id: "no-context-model" }] });
    try {
      const row = await makeProvider({ baseUrl: bare.apiBase, contextWindows: { "*": 32_000 } });
      const info = await getModelInfo(`${row.slug}::no-context-model`);
      expect(info?.context_source).toBe("configured");
      expect(info?.context_tokens).toBe(32_000);
      expect(await resolveWindow(`${row.slug}::no-context-model`)).toBe(32_000);
    } finally {
      await bare.stop();
    }
  });

  it("lets a size for one model win over what it declares, and never lets \"*\" do so", async () => {
    const declared = await makeProvider({ contextWindows: { "*": 32_000 } });
    expect(await resolveWindow(`${declared.slug}::mock-remote-model`)).toBe(128_000);
    const own = await makeProvider({ contextWindows: { "*": 32_000, "mock-remote-model": 64_000 } });
    expect(await resolveWindow(`${own.slug}::mock-remote-model`)).toBe(64_000);
  });

  it("never overrides what a llama.cpp backend actually allocated", async () => {
    const llama = await startMockOpenAi({ apiKey: API_KEY, nCtx: 16_384, models: [{ id: "loaded-model" }] });
    try {
      const row = await makeProvider({ baseUrl: llama.apiBase, contextWindows: { "loaded-model": 64_000 } });
      expect(await resolveWindow(`${row.slug}::loaded-model`)).toBe(16_384);
      // And the list says so too, which is what the meter and picker show.
      const info = await getModelInfo(`${row.slug}::loaded-model`);
      expect(info).toMatchObject({ context_source: "loaded", context_tokens: 16_384 });
    } finally {
      await llama.stop();
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

describe("a conversation on a model that reports no context size", () => {
  it("is compacted once an admin sets a size, rather than sent whole until the provider refuses it", { timeout: 60_000 }, async () => {
    // Before the size could be set, the window was unknown, so compaction
    // never acted: the history grew until the provider refused a request, and
    // every turn after failed the same way, /compact included.
    await initStreamBroker();
    const WINDOW = 16_384;
    const bare = await startMockOpenAi({ apiKey: API_KEY, models: [{ id: "no-context-model" }], reply: "A summary of it all." });
    const [conv] = await db.insert(conversations).values({ ownerId: adminId, title: "unsized model" }).returning();
    try {
      const row = await makeProvider({ baseUrl: bare.apiBase, contextWindows: { "*": WINDOW } });
      await db.insert(messages).values(
        Array.from({ length: 300 }, (_, i) => ({
          id: uuid(),
          conversationId: conv.id,
          authorType: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
          origin: "server" as const,
          lamport: 1000 + i,
          content: [{ kind: "text", text: `message ${String(i)}: ${"words ".repeat(40)}` }] as ContentBlock[],
          status: "complete" as const,
          createdAt: new Date(1_700_000_000_000 + i),
        })),
      );

      await startChatRun({ userId: adminId, content: "another question", model: `${row.slug}::no-context-model`, conversationId: conv.id });
      const start = Date.now();
      while (getRunByConversation(conv.id) && Date.now() - start < 50_000) await new Promise((r) => setTimeout(r, 100));

      const summary = (await db.query.messages.findMany({ where: eq(messages.conversationId, conv.id) })).find(
        (r) => r.authorType === "summary",
      );
      expect(summary?.status).toBe("complete");
      // Nothing went out over the size: the history was summarised in parts,
      // and the question was asked after the summary.
      expect(bare.completions.length).toBeGreaterThan(1);
      for (const req of bare.completions) {
        expect(estimateTallyTokens(tallyChatMessages((req.body.messages ?? []) as ChatMessage[]))).toBeLessThan(WINDOW);
      }
      expect(bare.completions.at(-1)?.body.messages?.at(-1)).toEqual({ role: "user", content: "another question" });
    } finally {
      await db.delete(messages).where(eq(messages.conversationId, conv.id));
      await db.delete(usageRecords).where(eq(usageRecords.conversationId, conv.id));
      await db.delete(conversations).where(eq(conversations.id, conv.id));
      await bare.stop();
    }
  });
});
