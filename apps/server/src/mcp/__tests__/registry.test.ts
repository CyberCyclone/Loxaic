import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { v4 as uuid } from "uuid";
import { db, eq } from "@loxaic/db";
import { conversations, mcpServers, user, userPrefs } from "@loxaic/db/schema";
import { toOpenAiTools } from "@loxaic/agent";
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
  await db.delete(conversations).where(eq(conversations.ownerId, userId));
  await db.delete(mcpServers).where(eq(mcpServers.ownerId, userId));
  await db.delete(userPrefs).where(eq(userPrefs.userId, userId));
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

  it("excludes a globally disabled server", async () => {
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

/**
 * "Allow always" on an approval (#266). The engine calls `grantTrust` when the
 * run's own sender answers with it; these pin what it writes and what it
 * leaves alone. Dispatching never grants: an approval is for one call unless
 * the person said otherwise.
 */
describe("grantTrust (#266)", () => {
  async function setPolicies(toolPolicies: Record<string, Record<string, unknown>>) {
    await db.update(mcpServers).set({ toolPolicies }).where(eq(mcpServers.id, serverId));
  }
  async function policies(): Promise<Record<string, Record<string, unknown> | undefined>> {
    const row = await db.query.mcpServers.findFirst({
      where: eq(mcpServers.id, serverId),
      columns: { toolPolicies: true },
    });
    return (row?.toolPolicies ?? {}) as Record<string, Record<string, unknown>>;
  }
  async function allowlist(): Promise<unknown> {
    const row = await db.query.userPrefs.findFirst({ where: eq(userPrefs.userId, userId) });
    return row?.toolAllowlist ?? [];
  }

  it("dispatching an MCP tool grants nothing, in auto mode or any other", async () => {
    await setPolicies({ echo: { enabled: true, approval: "ask", readOnly: false } });
    for (const mode of ["auto", "manual"] as const) {
      const ts = await buildToolset(userId, { mode });
      const echo = mustGet(ts, "mockmcp__echo");
      expect((await ts.dispatchMcp(echo, { text: "once" })).ok).toBe(true);
      expect(ts.requiresApproval(echo, mode)).toBe(true);
      expect((await policies()).echo?.approval).toBe("ask");
    }
  }, 30_000);

  it("allows an MCP tool for the rest of the run and for every later one", async () => {
    // `changed` as a revoked grant leaves it: allowing again acknowledges it.
    await setPolicies({ echo: { enabled: true, approval: "ask", readOnly: true, changed: true } });
    const ts = await buildToolset(userId, { mode: "manual" });
    const echo = mustGet(ts, "mockmcp__echo");
    expect(ts.requiresApproval(echo, "manual")).toBe(true);

    // Another device edits a different tool while this run is going. The
    // grant must change its own tool's entry and nothing else.
    await setPolicies({
      echo: { enabled: true, approval: "ask", readOnly: true, changed: true },
      slow: { enabled: false, approval: "ask", readOnly: false },
    });
    await ts.grantTrust(echo);

    expect(ts.requiresApproval(echo, "manual")).toBe(false);
    const stored = await policies();
    expect(stored.echo).toEqual({
      enabled: true,
      approval: "allow",
      readOnly: true,
      changed: false,
      grantedFrom: "prompt",
    });
    expect(stored.slow?.enabled).toBe(false);

    for (const mode of ["manual", "auto"] as const) {
      const next = await buildToolset(userId, { mode });
      expect(next.requiresApproval(mustGet(next, "mockmcp__echo"), mode)).toBe(false);
    }
    await setPolicies({});
  }, 30_000);

  it("allows a builtin for the rest of the run and for every later one, once", async () => {
    await db.delete(userPrefs).where(eq(userPrefs.userId, userId));
    const ts = await buildToolset(userId, { mode: "manual" });
    const write = mustGet(ts, "fs_write");
    expect(ts.requiresApproval(write, "manual")).toBe(true);

    await ts.grantTrust(write);
    await ts.grantTrust(write);
    await ts.grantTrust(mustGet(ts, "bash"));

    expect(ts.requiresApproval(write, "manual")).toBe(false);
    expect(await allowlist()).toEqual(["fs_write", "bash"]);
    const next = await buildToolset(userId, { mode: "manual" });
    expect(next.requiresApproval(mustGet(next, "fs_write"), "manual")).toBe(false);
    // One run's grant is not another run's: tool objects are per toolset.
    expect(next.requiresApproval(mustGet(next, "fs_edit"), "manual")).toBe(true);
    await db.delete(userPrefs).where(eq(userPrefs.userId, userId));
  }, 30_000);

  it("keeps the planning hand-over tools off the allowlist", async () => {
    await db.delete(userPrefs).where(eq(userPrefs.userId, userId));
    const ts = await buildToolset(userId, { mode: "planning" });
    await ts.grantTrust(mustGet(ts, "propose_plan"));
    expect(await allowlist()).toEqual([]);
  }, 30_000);
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

describe("buildToolset: per-kind defaults and per-conversation choices", () => {
  const offered = async (conversationId?: string, surface?: "chat" | "agent") =>
    (await buildToolset(userId, { mode: "manual", conversationId, surface })).openAiTools
      .map((t) => t.function.name)
      .includes("mockmcp__echo");

  async function conversation(kind: "chat" | "agent" | "routine", mcpOverrides: unknown = null) {
    const [row] = await db
      .insert(conversations)
      .values({ ownerId: userId, title: "mcp state", kind, mcpOverrides })
      .returning();
    return row.id;
  }

  async function defaults(values: { onInChat?: boolean; onInAgent?: boolean; onInRoutines?: boolean }) {
    await db.update(mcpServers).set(values).where(eq(mcpServers.id, serverId));
  }

  afterAll(async () => {
    await defaults({ onInChat: true, onInAgent: true, onInRoutines: true });
  });

  it("follows the default for the conversation's own kind", async () => {
    await defaults({ onInChat: false, onInAgent: true, onInRoutines: false });
    expect(await offered(await conversation("chat"))).toBe(false);
    expect(await offered(await conversation("agent"))).toBe(true);
    expect(await offered(await conversation("routine"))).toBe(false);
    await defaults({ onInChat: true, onInAgent: false, onInRoutines: true });
    expect(await offered(await conversation("chat"))).toBe(true);
    expect(await offered(await conversation("agent"))).toBe(false);
    expect(await offered(await conversation("routine"))).toBe(true);
  }, 30_000);

  it("uses the run's surface only when there is no conversation to read", async () => {
    await defaults({ onInChat: false, onInAgent: true });
    expect(await offered(undefined, "chat")).toBe(false);
    expect(await offered(undefined, "agent")).toBe(true);
    // A conversation's kind outranks the surface the run claims.
    expect(await offered(await conversation("chat"), "agent")).toBe(false);
    await defaults({ onInChat: true, onInAgent: true });
  }, 30_000);

  it("offers no MCP server when the conversation's choices cannot be read", async () => {
    // The surface can never say "routine", so falling back to it on a failed
    // read would resolve a routine run against the Chat default. A malformed id
    // is a real failure of that read (Postgres refuses it as a uuid).
    await defaults({ onInChat: true });
    expect(await offered("not-a-uuid", "chat")).toBe(false);
    expect(mustGet(await buildToolset(userId, { mode: "manual", conversationId: "not-a-uuid" }), "bash")).toBeTruthy();
  }, 20_000);

  it("lets a conversation switch a server off that is on by default", async () => {
    await defaults({ onInChat: true });
    expect(await offered(await conversation("chat", { disabledServerIds: [serverId] }))).toBe(false);
  }, 20_000);

  it("lets a conversation switch a server on that is off by default", async () => {
    await defaults({ onInChat: false });
    expect(await offered(await conversation("chat", { enabledServerIds: [serverId] }))).toBe(true);
    await defaults({ onInChat: true });
  }, 20_000);

  it("keeps a server named in both lists off", async () => {
    const id = await conversation("chat", { disabledServerIds: [serverId], enabledServerIds: [serverId] });
    expect(await offered(id)).toBe(false);
  }, 20_000);

  it("still reads a row written before enabledServerIds existed", async () => {
    expect(await offered(await conversation("agent", { disabledServerIds: [serverId] }))).toBe(false);
  }, 20_000);

  it("never offers a globally disabled server, whatever the conversation chose", async () => {
    await db.update(mcpServers).set({ enabled: false }).where(eq(mcpServers.id, serverId));
    try {
      expect(await offered(await conversation("chat", { enabledServerIds: [serverId] }))).toBe(false);
    } finally {
      await db.update(mcpServers).set({ enabled: true }).where(eq(mcpServers.id, serverId));
    }
  }, 20_000);
});
