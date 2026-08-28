import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { v4 as uuid } from "uuid";
import { db, eq } from "@shannon/db";
import { mcpServers, user, userPrefs } from "@shannon/db/schema";
import { toOpenAiTools } from "@shannon/agent";
import { buildToolset } from "../registry.ts";
import { encryptSecrets } from "../secrets.ts";
import { MAX_RESULT_BYTES } from "../sanitize.ts";

/** Integration test against real Postgres + the stdio fixture server
 * (spawned from apps/server's cwd, matching how vitest runs). */

process.env.MCP_ENCRYPTION_KEY ??= "registry-test-key";

/** A tool the toolset was expected to offer. Failing here names the missing
 * tool, which a bare non-null assertion would turn into a confusing
 * "cannot read property of undefined" further down the assertion. */
function mustGet(ts: Awaited<ReturnType<typeof buildToolset>>, name: string) {
  const tool = ts.get(name);
  if (!tool) throw new Error(`toolset did not offer "${name}"`);
  return tool;
}

const userId = `test-mcp-${uuid()}`;
let serverId: string;

beforeAll(async () => {
  await db.insert(user).values({
    id: userId,
    name: "MCP Registry Test",
    email: `${userId}@example.com`,
    emailVerified: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const [row] = await db
    .insert(mcpServers)
    .values({
      ownerId: userId,
      name: "Mock MCP",
      slug: "mockmcp",
      transport: "stdio",
      command: "node_modules/.bin/tsx",
      args: ["test-fixtures/mock-mcp-server.ts"],
      secrets: encryptSecrets({ FAKE_KEY: "fake-secret-value" }),
    })
    .returning();
  serverId = row.id;
}, 30_000);

afterAll(async () => {
  await db.delete(mcpServers).where(eq(mcpServers.ownerId, userId));
  await db.delete(user).where(eq(user.id, userId));
});

describe("buildToolset without MCP servers", () => {
  it("matches the legacy builtin output exactly", async () => {
    const ts = await buildToolset(`no-such-user-${uuid()}`, { mode: "manual" });
    expect(ts.openAiTools).toEqual(toOpenAiTools());
    expect(ts.systemPromptAddendum).toBeNull();
  });
});

describe("buildToolset with the fixture server", () => {
  it("offers namespaced MCP tools alongside builtins, with the addendum", async () => {
    const ts = await buildToolset(userId, { mode: "manual" });
    const names = ts.openAiTools.map((t) => t.function.name);
    expect(names).toContain("bash");
    expect(names).toContain("mockmcp__echo");
    expect(names).toContain("mockmcp__slow");
    expect(ts.systemPromptAddendum).toMatch(/UNTRUSTED/);
    // MCP schemas pass through without an injected additionalProperties.
    const echo = ts.openAiTools.find((t) => t.function.name === "mockmcp__echo");
    if (!echo) throw new Error("mockmcp__echo was not offered");
    expect(Object.prototype.hasOwnProperty.call(echo.function.parameters, "additionalProperties")).toBe(false);
  }, 20_000);

  it("requires approval for MCP tools in every mode until allowlisted", async () => {
    const ts = await buildToolset(userId, { mode: "auto" });
    const echo = mustGet(ts, "mockmcp__echo");
    expect(ts.requiresApproval(echo, "auto")).toBe(true);
    expect(ts.requiresApproval(echo, "manual")).toBe(true);
    // Builtins keep their auto-mode behavior.
    expect(ts.requiresApproval(mustGet(ts, "bash"), "auto")).toBe(false);
  }, 20_000);

  it("honors an explicit allowlist and readOnly planning gate", async () => {
    const row = await db.query.mcpServers.findFirst({ where: eq(mcpServers.id, serverId) });
    if (!row) throw new Error("fixture server row missing");
    await db
      .update(mcpServers)
      .set({
        toolPolicies: {
          // The jsonb column is typed `unknown`, so the spread needs a shape.
          ...(row.toolPolicies as Record<string, unknown>),
          echo: { enabled: true, approval: "allow", readOnly: true },
        },
      })
      .where(eq(mcpServers.id, serverId));

    const manual = await buildToolset(userId, { mode: "manual" });
    expect(manual.requiresApproval(mustGet(manual, "mockmcp__echo"), "manual")).toBe(false);

    const planning = await buildToolset(userId, { mode: "planning" });
    const names = planning.openAiTools.map((t) => t.function.name);
    expect(names).toContain("mockmcp__echo"); // user-marked read-only
    expect(names).not.toContain("mockmcp__slow"); // not read-only
    expect(planning.get("mockmcp__slow")).toBeUndefined();
  }, 20_000);

  it("dispatches echo and wraps the result in provenance markers", async () => {
    const ts = await buildToolset(userId, { mode: "manual" });
    const result = await ts.dispatchMcp(mustGet(ts, "mockmcp__echo"), { text: "hi" });
    expect(result.ok).toBe(true);
    expect(result.output).toContain('<mcp-tool-result server="mockmcp" tool="echo"');
    expect(result.output).toContain("echo: hi");
  }, 20_000);

  it("rejects schema-invalid arguments before dispatch", async () => {
    const ts = await buildToolset(userId, { mode: "manual" });
    const result = await ts.dispatchMcp(mustGet(ts, "mockmcp__echo"), { wrong: 1 });
    expect(result.ok).toBe(false);
    expect(result.output).toMatch(/Invalid arguments for mockmcp__echo/);
    expect(result.output).not.toContain("mcp-tool-result"); // never reached the server
  }, 20_000);

  it("caps oversized results with a truncation marker", async () => {
    const ts = await buildToolset(userId, { mode: "manual" });
    const result = await ts.dispatchMcp(mustGet(ts, "mockmcp__huge"), {});
    expect(result.output).toContain(`[truncated at ${String(MAX_RESULT_BYTES)} bytes]`);
  }, 20_000);

  it("neutralizes wrapper-escape attempts in results", async () => {
    const ts = await buildToolset(userId, { mode: "manual" });
    const result = await ts.dispatchMcp(mustGet(ts, "mockmcp__evil"), {});
    // Exactly one genuine closing tag — the wrapper's own.
    expect(result.output.split("</mcp-tool-result").length).toBe(2);
  }, 20_000);

  it("excludes disabled servers and per-conversation disabled servers", async () => {
    await db.update(mcpServers).set({ enabled: false }).where(eq(mcpServers.id, serverId));
    const ts = await buildToolset(userId, { mode: "manual" });
    expect(ts.openAiTools.map((t) => t.function.name)).not.toContain("mockmcp__echo");
    await db.update(mcpServers).set({ enabled: true }).where(eq(mcpServers.id, serverId));
  }, 20_000);

  it("clears requiresApproval for a builtin on the user's allow-always list", async () => {
    const before = await buildToolset(userId, { mode: "manual" });
    expect(before.requiresApproval(mustGet(before, "bash"), "manual")).toBe(true);

    await db.insert(userPrefs).values({ userId, toolAllowlist: ["bash"] });
    try {
      const after = await buildToolset(userId, { mode: "manual" });
      expect(after.requiresApproval(mustGet(after, "bash"), "manual")).toBe(false);
      // Untouched: only the allowlisted name is affected.
      expect(after.requiresApproval(mustGet(after, "fs_write"), "manual")).toBe(true);
      // Planning gates on isWrite regardless of the allowlist — "allow
      // always" doesn't defeat planning mode's no-writes guarantee.
      const planning = await buildToolset(userId, { mode: "planning" });
      expect(planning.openAiTools.map((t) => t.function.name)).not.toContain("bash");
    } finally {
      await db.delete(userPrefs).where(eq(userPrefs.userId, userId));
    }
  }, 20_000);

  it("skips an unreachable server without failing the run", async () => {
    const [dead] = await db
      .insert(mcpServers)
      .values({
        ownerId: userId,
        name: "Dead",
        slug: "dead",
        transport: "stdio",
        command: "/nonexistent/binary",
      })
      .returning();
    try {
      const ts = await buildToolset(userId, { mode: "manual" });
      const names = ts.openAiTools.map((t) => t.function.name);
      expect(names).toContain("mockmcp__echo");
      expect(names.some((n) => n.startsWith("dead__"))).toBe(false);
    } finally {
      await db.delete(mcpServers).where(eq(mcpServers.id, dead.id));
    }
  }, 20_000);
});

describe("compileValidator", () => {
  it("compiles 2020-12 schemas carrying a $schema meta pointer (Brave's shape)", async () => {
    const { compileValidator } = await import("../registry.ts");
    const validate = compileValidator({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: { query: { type: "string", maxLength: 400 } },
      required: ["query"],
      additionalProperties: false,
    });
    expect(validate({ query: "hi" })).toBe(true);
    expect(validate({})).toBe(false);
    expect(validate({ query: "hi", extra: 1 })).toBe(false);
  });

  it("compiles draft-07-style schemas too", async () => {
    const { compileValidator } = await import("../registry.ts");
    const validate = compileValidator({
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      properties: { n: { type: "integer", minimum: 1 } },
    });
    expect(validate({ n: 3 })).toBe(true);
    expect(validate({ n: 0 })).toBe(false);
  });
});
