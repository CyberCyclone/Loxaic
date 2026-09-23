import { afterEach, beforeAll, describe, expect, it } from "vitest";

// Before any encryption happens. `??=` because vitest shares one process
// across files and another suite may have set it already — the value only has
// to be stable within a run, not particular.
process.env.MCP_ENCRYPTION_KEY ??= "provider-test-key";

import { v4 as uuid } from "uuid";
import { db, eq, inArray } from "@loxaic/db";
import { inferenceProviders, user } from "@loxaic/db/schema";
import { DEFAULT_PROVIDER_ID, formatModelRef, parseModelRef } from "@loxaic/types";
import { decryptApiKey, encryptApiKey, redactSecrets } from "../provider-secrets.ts";
import { useServableModels } from "../../llama/__tests__/servable-model.ts";
import {
  __resetProviderCacheForTest,
  allocateSlug,
  assertModelUsable,
  createProvider,
  defaultProvider,
  deleteProvider,
  ModelRefError,
  normalizeBaseUrl,
  normalizeHeaderInput,
  normalizeName,
  ProviderInputError,
  resolveModelRef,
  toApi,
  updateProvider,
} from "../providers.ts";

/**
 * Provider rows are deployment-wide, and vitest shares one database across
 * files — so every row here is created with a name whose slug is unique to
 * this run, and torn down by id. Nothing asserts on the *set* of providers,
 * only on the ones this file made.
 */
const created: string[] = [];
const adminId = `test-providers-${uuid()}`;

async function makeProvider(input: Record<string, unknown>) {
  const row = await createProvider(
    { name: `T ${uuid().slice(0, 8)}`, baseUrl: "http://127.0.0.1:1/v1", ...input },
    adminId,
  );
  created.push(row.id);
  return row;
}

beforeAll(async () => {
  await db.insert(user).values({
    id: adminId,
    name: "Provider Test Admin",
    email: `${adminId}@example.test`,
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return async () => {
    await db.delete(inferenceProviders).where(eq(inferenceProviders.createdBy, adminId));
    await db.delete(user).where(eq(user.id, adminId));
  };
});

afterEach(async () => {
  if (created.length) await db.delete(inferenceProviders).where(inArray(inferenceProviders.id, created));
  created.length = 0;
  __resetProviderCacheForTest();
});

describe("API key encryption", () => {
  it("round-trips a key", () => {
    const key = "sk-test-0123456789abcdef";
    expect(decryptApiKey(encryptApiKey(key))).toBe(key);
  });

  it("produces a different blob each time for the same key", () => {
    // Per-blob salt and IV. Identical ciphertext for identical plaintext would
    // tell anyone with database access which two providers share a key.
    expect(encryptApiKey("sk-same-key-value")).not.toBe(encryptApiKey("sk-same-key-value"));
  });

  it("refuses a tampered blob rather than returning wrong bytes", () => {
    const blob = encryptApiKey("sk-test-0123456789abcdef");
    const parts = blob.split(":");
    parts[4] = Buffer.from("tampered-ciphertext").toString("base64");
    expect(() => decryptApiKey(parts.join(":"))).toThrow();
  });
});

describe("redactSecrets", () => {
  it("scrubs a key an upstream error echoed back", () => {
    const key = "sk-proj-abcdef0123456789";
    expect(redactSecrets(`Incorrect API key provided: ${key}`, [key])).toBe(
      "Incorrect API key provided: [redacted]",
    );
  });

  it("leaves a short value alone", () => {
    // Below the length threshold a "secret" is far likelier to be an ordinary
    // word, and replacing every occurrence would mangle the message while
    // protecting nothing.
    expect(redactSecrets("the model failed", ["the"])).toBe("the model failed");
  });

  it("scrubs custom header values too", () => {
    const header = "second-credential-in-a-header";
    expect(redactSecrets(`rejected ${header}`, [null, header])).toBe("rejected [redacted]");
  });
});

describe("model references", () => {
  it("leaves an unqualified id on the default provider", () => {
    // Every model reference stored before providers existed is this shape.
    expect(parseModelRef("qwen2.5-14b-instruct")).toEqual({
      providerSlug: null,
      upstreamModel: "qwen2.5-14b-instruct",
    });
  });

  it("splits on the first separator only", () => {
    // OpenRouter ids contain slashes and Ollama ids contain colons; neither
    // may be mistaken for a provider boundary.
    expect(parseModelRef("work::openai/gpt-4o")).toEqual({
      providerSlug: "work",
      upstreamModel: "openai/gpt-4o",
    });
    expect(parseModelRef("work::qwen2.5:7b")).toEqual({
      providerSlug: "work",
      upstreamModel: "qwen2.5:7b",
    });
  });

  it("treats a non-slug prefix as part of the model id", () => {
    // A future backend inventing an id with `::` in it belongs to the default
    // provider, which is the conservative reading.
    expect(parseModelRef("Weird Name::thing").providerSlug).toBeNull();
    expect(parseModelRef("::leading").providerSlug).toBeNull();
  });

  it("formats back to what it parsed", () => {
    expect(formatModelRef("work", "openai/gpt-4o")).toBe("work::openai/gpt-4o");
    expect(formatModelRef(null, "plain")).toBe("plain");
  });
});

describe("resolveModelRef", () => {
  it("sends an unqualified reference to the built-in backend — when it is an enabled local model", async () => {
    const cleanup = await useServableModels(["qwen2.5-14b-instruct"]);
    try {
      const { provider, upstreamModel } = await resolveModelRef("qwen2.5-14b-instruct");
      expect(provider.id).toBe(DEFAULT_PROVIDER_ID);
      expect(provider.isDefault).toBe(true);
      expect(upstreamModel).toBe("qwen2.5-14b-instruct");
    } finally {
      await cleanup();
    }
  });

  it("refuses an unqualified reference that is not an enabled local model", async () => {
    // The built-in provider is the local llama.cpp router now, and it serves
    // exactly what an admin downloaded and enabled — never "whatever the
    // backend happens to have". Enforced here, at send time.
    await expect(resolveModelRef(`not-downloaded-${uuid()}`)).rejects.toMatchObject({ code: "local_model_unavailable" });
  });

  it("routes a qualified reference to its provider, under the upstream id", async () => {
    const row = await makeProvider({ apiKey: "sk-test-0123456789abcdef" });
    const { provider, upstreamModel } = await resolveModelRef(`${row.slug}::openai/gpt-4o`);
    expect(provider.id).toBe(row.id);
    expect(provider.apiKey).toBe("sk-test-0123456789abcdef");
    // The `slug::` prefix is ours and must never reach the backend.
    expect(upstreamModel).toBe("openai/gpt-4o");
  });

  it("refuses a provider that no longer exists, rather than falling through", async () => {
    // The whole reason this throws: llama.cpp ignores the `model` field, so a
    // deleted provider's reference sent to the built-in backend would be
    // answered by the local model with nothing anywhere saying so.
    const row = await makeProvider({});
    await deleteProvider(row.id);
    await expect(resolveModelRef(`${row.slug}::some-model`)).rejects.toThrow(ModelRefError);
  });

  it("refuses a disabled provider", async () => {
    const row = await makeProvider({ enabled: false });
    await expect(resolveModelRef(`${row.slug}::some-model`)).rejects.toMatchObject({
      code: "provider_disabled",
    });
  });

  it("refuses a model the admin did not allow", async () => {
    const row = await makeProvider({ modelAllowlist: ["allowed-model"] });
    await expect(assertModelUsable(`${row.slug}::allowed-model`)).resolves.toBeUndefined();
    await expect(assertModelUsable(`${row.slug}::expensive-model`)).rejects.toMatchObject({
      code: "model_not_allowed",
    });
  });

  it("treats an empty allowlist as no allowlist", async () => {
    // The UI writes null for "all models"; an empty array would mean "no
    // models at all", which nobody means by it.
    const row = await makeProvider({ modelAllowlist: [] });
    await expect(assertModelUsable(`${row.slug}::anything`)).resolves.toBeUndefined();
  });
});

describe("base URL normalization", () => {
  it("appends /v1 to a bare origin", () => {
    // What an admin pastes for llama.cpp, LM Studio, vLLM or Ollama.
    expect(normalizeBaseUrl("http://192.168.1.50:1234")).toBe("http://192.168.1.50:1234/v1");
    expect(normalizeBaseUrl("http://192.168.1.50:1234/")).toBe("http://192.168.1.50:1234/v1");
  });

  it("leaves an already-versioned path alone", () => {
    // OpenRouter's API is under /api/v1 — "origin plus /v1" cannot express it.
    expect(normalizeBaseUrl("https://openrouter.ai/api/v1")).toBe("https://openrouter.ai/api/v1");
    expect(normalizeBaseUrl("https://openrouter.ai/api/v1/")).toBe("https://openrouter.ai/api/v1");
  });

  it("keeps a private address", () => {
    // Deliberately not behind the SSRF guard: a llama.cpp host on the LAN is
    // the case this feature exists for.
    expect(normalizeBaseUrl("http://127.0.0.1:4002")).toBe("http://127.0.0.1:4002/v1");
  });

  it("refuses credentials in the URL", () => {
    // They would sit in the clear in `base_url`, beside an encrypted column
    // that exists to stop exactly that.
    expect(() => normalizeBaseUrl("https://user:pass@example.com/v1")).toThrow(ProviderInputError);
  });

  it("refuses a non-http scheme", () => {
    expect(() => normalizeBaseUrl("file:///etc/passwd")).toThrow(ProviderInputError);
    expect(() => normalizeBaseUrl("not a url")).toThrow(ProviderInputError);
  });
});

describe("header validation", () => {
  it("accepts an ordinary provider header", () => {
    expect(normalizeHeaderInput({ "HTTP-Referer": "https://loxaic.local" })).toEqual({
      "HTTP-Referer": "https://loxaic.local",
    });
  });

  it("refuses an Authorization header", () => {
    // Setting it here would silently defeat the encrypted key column beside it.
    expect(() => normalizeHeaderInput({ Authorization: "Bearer sneaky" })).toThrow(ProviderInputError);
    expect(() => normalizeHeaderInput({ authorization: "Bearer sneaky" })).toThrow(ProviderInputError);
  });

  it("refuses a header that is a credential under another name", () => {
    // Review finding. `x-api-key` is how Anthropic authenticates natively and
    // `api-key` is Azure OpenAI's, so an admin has a plausible reason to put a
    // live key here — where it would be stored in the clear and returned to
    // every admin, beside an encrypted column that exists to prevent that.
    for (const name of ["x-api-key", "X-Api-Key", "api-key", "Proxy-Authorization"]) {
      expect(() => normalizeHeaderInput({ [name]: "sk-live-key-0123456789" })).toThrow(/API key field/);
    }
  });

  it("refuses a line break in a value", () => {
    expect(() => normalizeHeaderInput({ "X-Thing": "a\r\nX-Injected: yes" })).toThrow(ProviderInputError);
  });

  it("treats no headers as null", () => {
    expect(normalizeHeaderInput({})).toBeNull();
    expect(normalizeHeaderInput(undefined)).toBeNull();
  });
});

describe("names and slugs", () => {
  it("strips control characters from a pasted name", () => {
    expect(normalizeName("Work  OpenRouter")).toBe("Work OpenRouter");
  });

  it("refuses an empty name", () => {
    expect(() => normalizeName("   ")).toThrow(ProviderInputError);
  });

  it("derives a slug from the name", async () => {
    const row = await makeProvider({ name: "Work OpenRouter" });
    expect(row.slug).toBe("work-openrouter");
  });

  it("de-duplicates a slug rather than colliding", async () => {
    const a = await makeProvider({ name: "GPU Box" });
    const b = await makeProvider({ name: "GPU Box" });
    expect(a.slug).toBe("gpu-box");
    expect(b.slug).toBe("gpu-box-2");
  });

  it("never allocates the reserved default slug", async () => {
    // ws/chat.ts sends the literal string "default" when a client names no
    // model, so a provider holding that slug would capture it.
    expect(await allocateSlug("default")).not.toBe(DEFAULT_PROVIDER_ID);
  });

  it("keeps the slug when the name changes", async () => {
    // The slug is baked into every stored model reference, so a rename must
    // not orphan a conversation's model.
    const row = await makeProvider({ name: "Old Name" });
    const renamed = await updateProvider(row.id, { name: "New Name" });
    expect(renamed?.name).toBe("New Name");
    expect(renamed?.slug).toBe(row.slug);
    await expect(resolveModelRef(`${row.slug}::m`)).resolves.toBeTruthy();
  });

  it("refuses a slug change outright", async () => {
    const row = await makeProvider({});
    await expect(updateProvider(row.id, { slug: "something-else" })).rejects.toThrow(ProviderInputError);
  });
});

describe("the API projection", () => {
  it("never carries the key, only whether there is one", async () => {
    const key = "sk-secret-value-0123456789";
    const row = await makeProvider({ apiKey: key });
    const body = JSON.stringify(toApi(row));
    expect(body).not.toContain(key);
    expect(body).not.toContain(row.encryptedApiKey ?? " ");
    expect(toApi(row).hasApiKey).toBe(true);
  });

  it("reports no key when none is stored", async () => {
    const row = await makeProvider({});
    expect(toApi(row).hasApiKey).toBe(false);
  });
});

describe("updating the key", () => {
  it("keeps the stored key when the field is absent", async () => {
    // The key is never sent back to the client, so "absent" cannot mean
    // "clear" — an edit that only renamed the provider would wipe it.
    const row = await makeProvider({ apiKey: "sk-keep-me-0123456789" });
    const updated = await updateProvider(row.id, { name: "Renamed" });
    expect(updated?.encryptedApiKey).toBe(row.encryptedApiKey);
    const { provider } = await resolveModelRef(`${row.slug}::m`);
    expect(provider.apiKey).toBe("sk-keep-me-0123456789");
  });

  it("replaces the key when a string is sent", async () => {
    const row = await makeProvider({ apiKey: "sk-old-0123456789" });
    await updateProvider(row.id, { apiKey: "sk-new-0123456789" });
    const { provider } = await resolveModelRef(`${row.slug}::m`);
    expect(provider.apiKey).toBe("sk-new-0123456789");
  });

  it("clears the key when null is sent", async () => {
    const row = await makeProvider({ apiKey: "sk-old-0123456789" });
    await updateProvider(row.id, { apiKey: null });
    const { provider } = await resolveModelRef(`${row.slug}::m`);
    expect(provider.apiKey).toBeNull();
  });
});

describe("deleting the admin who added a provider", () => {
  it("keeps the provider and loses only the attribution", async () => {
    // Review finding. The default `no action` made any admin who had ever added
    // a provider undeletable; `cascade` would have removed deployment-wide
    // configuration — and orphaned every conversation naming its slug — because
    // the person who typed it in left.
    const authorId = `test-providers-author-${uuid()}`;
    await db.insert(user).values({
      id: authorId,
      name: "Departing Admin",
      email: `${authorId}@example.test`,
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const row = await createProvider({ name: `T ${uuid().slice(0, 8)}`, baseUrl: "http://127.0.0.1:1/v1" }, authorId);
    created.push(row.id);

    await db.delete(user).where(eq(user.id, authorId));

    const after = await db.query.inferenceProviders.findFirst({ where: eq(inferenceProviders.id, row.id) });
    expect(after).toBeTruthy();
    expect(after?.createdBy).toBeNull();
  });
});

describe("the built-in provider", () => {
  it("is synthesized from wherever the llama.cpp router is, not a row", () => {
    const previous = { mode: process.env.LLAMA_MODE, url: process.env.LLAMA_ROUTER_URL };
    process.env.LLAMA_MODE = "attach";
    process.env.LLAMA_ROUTER_URL = "http://example.test:9999";
    try {
      // Read at call time: Compose's sidecar is named in the environment.
      expect(defaultProvider().apiBase).toBe("http://example.test:9999/v1");
      expect(defaultProvider().nativeRoot).toBe("http://example.test:9999");
      expect(defaultProvider().id).toBe(DEFAULT_PROVIDER_ID);
    } finally {
      if (previous.mode === undefined) delete process.env.LLAMA_MODE;
      else process.env.LLAMA_MODE = previous.mode;
      if (previous.url === undefined) delete process.env.LLAMA_ROUTER_URL;
      else process.env.LLAMA_ROUTER_URL = previous.url;
    }
  });
});
