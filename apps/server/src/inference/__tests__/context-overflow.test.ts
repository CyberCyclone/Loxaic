import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { v4 as uuid } from "uuid";
import { asc, db, eq, inArray } from "@loxaic/db";
import { conversations, inferenceProviders, messages, usageRecords, user } from "@loxaic/db/schema";
import { backendErrorFields, ContextOverflowError, isContextOverflow } from "../context-overflow.ts";
import { streamCompletion } from "../provider.ts";
import { __resetProviderCacheForTest, createProvider } from "../providers.ts";
import { startMockOpenAi } from "./mock-openai-server.ts";
import { getStreamBroker, initStreamBroker } from "../../streams/index.ts";
import { getRunByConversation } from "../../streams/registry.ts";
import { startChatRun } from "../../streams/runs/chatRun.ts";

/**
 * A request longer than the model's context, refused — by Loxaic when it knows
 * the window, by the backend when it does not — is marked so the failed reply
 * can offer "Edit message" and Retry (#166). Each vendor says it differently;
 * these are their real bodies.
 */
const BODIES = {
  openai: {
    error: {
      message: "This model's maximum context length is 128000 tokens. However, your messages resulted in 130123 tokens. Please reduce the length of the messages.",
      type: "invalid_request_error",
      param: "messages",
      code: "context_length_exceeded",
    },
  },
  vllm: {
    object: "error",
    error: { message: "This model's maximum context length is 32768 tokens. However, you requested 40000 tokens in the messages.", type: "BadRequestError", code: 400 },
  },
  llamacpp: {
    error: {
      code: 400,
      message: "request (5000 tokens) exceeds the available context size (4096 tokens), try increasing it",
      type: "exceed_context_size_error",
      n_prompt_tokens: 5000,
      n_ctx: 4096,
    },
  },
  lmstudio: {
    error: "Trying to keep the first 9000 tokens when context the overflows. However, the model is loaded with context length of only 8192 tokens, which is not enough. Try to load the model with a larger context length, or provide a shorter input. The number of tokens to keep from the initial prompt is greater than the context length.",
  },
  anthropic: { type: "error", error: { type: "invalid_request_error", message: "prompt is too long: 210000 tokens > 200000 maximum" } },
};

describe("isContextOverflow", () => {
  it.each(Object.entries(BODIES))("recognises %s's refusal", (_name, body) => {
    const fields = backendErrorFields(body);
    expect(fields).not.toBeNull();
    expect(isContextOverflow(fields ?? {})).toBe(true);
  });

  it("does not take other refusals that mention context or length for one", () => {
    const others = [
      { error: { message: "max_tokens is too large: 9000. This model supports at most 4096 completion tokens.", code: "invalid_value" } },
      { error: { message: "Rate limit reached for gpt-4o in organization org-x on tokens per min.", code: "rate_limit_exceeded" } },
      { error: { message: "Invalid 'messages[2].content': string too short." } },
      { error: { message: "The context window could not be loaded: model not found" } },
      { error: "Failed to load model \"mock-model\"." },
    ];
    for (const body of others) expect(isContextOverflow(backendErrorFields(body) ?? {})).toBe(false);
    expect(backendErrorFields("not json at all")).toBeNull();
  });
});

describe("a refusal through the real wire", () => {
  const adminId = `test-overflow-${uuid()}`;
  const providerIds: string[] = [];
  const convIds: string[] = [];

  beforeAll(async () => {
    await initStreamBroker();
    await db.insert(user).values({
      id: adminId, name: "Overflow", email: `${adminId}@example.test`, emailVerified: true, createdAt: new Date(), updatedAt: new Date(),
    });
  });

  afterAll(async () => {
    if (convIds.length) {
      await db.delete(messages).where(inArray(messages.conversationId, convIds));
      await db.delete(conversations).where(inArray(conversations.id, convIds));
    }
    await db.delete(usageRecords).where(eq(usageRecords.userId, adminId));
    if (providerIds.length) await db.delete(inferenceProviders).where(inArray(inferenceProviders.id, providerIds));
    await db.delete(user).where(eq(user.id, adminId));
    __resetProviderCacheForTest();
  });

  async function refusing(refuse: { status: number; body: unknown }) {
    const mock = await startMockOpenAi({ refuse, models: [{ id: "small-model" }] });
    const row = await createProvider({ name: `Overflow ${uuid().slice(0, 8)}`, baseUrl: mock.apiBase }, adminId);
    providerIds.push(row.id);
    return { mock, model: `${row.slug}::small-model` };
  }

  async function firstError(model: string): Promise<unknown> {
    try {
      for await (const _ of streamCompletion(model, [{ role: "user", content: "hello" }])) void _;
    } catch (err) {
      return err;
    }
    return null;
  }

  it("marks a refusal before the stream, and one in the middle of it", async () => {
    for (const refuse of [{ status: 400, body: BODIES.openai }, { status: 200, body: BODIES.llamacpp }]) {
      const { mock, model } = await refusing(refuse);
      try {
        const err = await firstError(model);
        expect(err).toBeInstanceOf(ContextOverflowError);
        expect((err as ContextOverflowError).code).toBe("context_overflow");
      } finally {
        await mock.stop();
      }
    }
    // Anything else stays an ordinary error.
    const { mock, model } = await refusing({ status: 400, body: { error: { message: "something else broke" } } });
    try {
      const err = await firstError(model);
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(ContextOverflowError);
    } finally {
      await mock.stop();
    }
  });

  it("stores the code on the failed reply and sends it with the run's end", async () => {
    const { mock, model } = await refusing({ status: 400, body: BODIES.openai });
    try {
      const started = await startChatRun({ userId: adminId, content: "a long message", model });
      convIds.push(started.conversationId);
      const ended = new Promise<string | undefined>((resolve) => {
        getStreamBroker().onEnd(started.streamId, (info) => { resolve(info.errorCode); });
      });
      const deadline = Date.now() + 15_000;
      while (getRunByConversation(started.conversationId)) {
        if (Date.now() > deadline) throw new Error("timed out");
        await new Promise((r) => setTimeout(r, 25));
      }
      const rows = await db
        .select()
        .from(messages)
        .where(eq(messages.conversationId, started.conversationId))
        .orderBy(asc(messages.lamport));
      const reply = rows.find((r) => r.authorType === "assistant");
      expect(reply).toMatchObject({ status: "error", errorCode: "context_overflow" });
      expect(reply?.error).toContain("maximum context length");
      expect(await ended).toBe("context_overflow");
    } finally {
      await mock.stop();
    }
  });
});
