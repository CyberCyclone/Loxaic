import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { v4 as uuid } from "uuid";
import { db, eq } from "@loxaic/db";
import { inferenceProviders, user } from "@loxaic/db/schema";
import { __resetModelCachesForTest } from "../../../inference/models.ts";
import { __resetProviderCacheForTest, createProvider } from "../../../inference/providers.ts";
import { startMockOpenAi, type MockOpenAi } from "../../../inference/__tests__/mock-openai-server.ts";
import { VERDICT_SCHEMA, reviewRun } from "../progress-review.ts";

/**
 * The review's request, over the wire: the verdict is asked for under a JSON
 * schema where a backend will hold the reply to one, and in words alone where
 * it will not. Real HTTP, because what matters is the request body.
 */
describe("the review request", () => {
  const adminId = `test-review-request-${uuid()}`;
  const VERDICT = '{"verdict": "stuck", "reason": "It keeps rereading engine.ts."}';
  const backends: MockOpenAi[] = [];

  async function backend(options: Parameters<typeof startMockOpenAi>[0], preset?: string) {
    const server = await startMockOpenAi(options);
    backends.push(server);
    const row = await createProvider({ name: `P ${uuid().slice(0, 8)}`, baseUrl: server.apiBase, ...(preset ? { preset } : {}) }, adminId);
    return { server, model: `${row.slug}::mock-remote-model` };
  }

  const review = (model: string) =>
    reviewRun({ model, messages: [{ role: "user", content: "digest" }], thinking: {}, signal: new AbortController().signal });

  beforeAll(async () => {
    await db.insert(user).values({
      id: adminId,
      name: "Review Request Admin",
      email: `${adminId}@example.test`,
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  });

  afterEach(async () => {
    for (const server of backends.splice(0)) await server.stop();
    __resetProviderCacheForTest();
    __resetModelCachesForTest();
  });

  afterAll(async () => {
    await db.delete(inferenceProviders).where(eq(inferenceProviders.createdBy, adminId));
    await db.delete(user).where(eq(user.id, adminId));
  });

  it("asks a generic backend for its verdict under the schema, and reads it", async () => {
    const { server, model } = await backend({ nCtx: 8192, reply: VERDICT });
    const { read, result } = await review(model);

    expect(read).toEqual({ verdict: "stuck", reason: "It keeps rereading engine.ts." });
    expect(result).not.toBeNull();
    expect(server.completions).toHaveLength(1);
    expect(server.completions[0].body.response_format).toEqual({
      type: "json_schema",
      json_schema: { name: VERDICT_SCHEMA.name, strict: true, schema: VERDICT_SCHEMA.schema },
    });
  });

  it("never sends the schema to a named hosted API", async () => {
    const { server, model } = await backend({ reply: VERDICT }, "openai");
    expect((await review(model)).read?.verdict).toBe("stuck");
    expect(server.completions).toHaveLength(1);
    expect(server.completions[0].body).not.toHaveProperty("response_format");
  });

  it("asks once more without the schema when the backend refuses it", async () => {
    const { server, model } = await backend({ nCtx: 8192, reply: VERDICT, refuseResponseFormat: true });
    const { read } = await review(model);

    expect(read?.verdict).toBe("stuck");
    expect(server.completions).toHaveLength(2);
    expect(server.completions[0].body).toHaveProperty("response_format");
    expect(server.completions[1].body).not.toHaveProperty("response_format");
  });

  it("is no verdict, and no error, when the backend refuses either way", async () => {
    const { server, model } = await backend({ nCtx: 8192, refuse: { status: 500, body: { error: { message: "boom" } } } });
    const { read, result } = await review(model);
    expect(read).toBeNull();
    expect(result).toBeNull();
    // Both ways were tried.
    expect(server.completions).toHaveLength(2);
  });
});
