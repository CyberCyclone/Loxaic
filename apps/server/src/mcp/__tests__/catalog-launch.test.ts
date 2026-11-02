import { existsSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { v4 as uuid } from "uuid";
import { db, eq } from "@loxaic/db";
import { mcpServers, user } from "@loxaic/db/schema";
import { dropEntry, listServerTools, stdioLaunch, type McpServerRow } from "../client-manager.ts";
import { catalogEntry } from "../catalog.ts";
import { encryptSecrets } from "../secrets.ts";

process.env.MCP_ENCRYPTION_KEY ??= "mcp-catalog-launch-test-key";

/**
 * A built-in server's launch, as a packaged install needs it. A row added on an
 * older build keeps the path of the package version that build shipped, and on
 * a packaged build process.execPath is Electron, which only runs a script as
 * Node when the flag reaches the child.
 */
const STALE_PATH = "/opt/old/node_modules/.pnpm/@brave+brave-search-mcp-server@2.1.3/dist/index.js";

function row(overrides: Partial<McpServerRow>): McpServerRow {
  return { transport: "stdio", command: null, args: null, env: null, builtinKey: null, ...overrides } as McpServerRow;
}

describe("stdioLaunch", () => {
  const staleBrave = row({ builtinKey: "brave", command: "/opt/old/loxaic", args: [STALE_PATH] });

  it("starts a catalog server from the catalog, whatever its row stored", () => {
    const launch = stdioLaunch(staleBrave, {});
    expect(launch.command).toBe(process.execPath);
    expect(launch.args).toEqual(catalogEntry("brave")?.resolveLaunch().args);
    expect(launch.args).not.toContain(STALE_PATH);
    expect(existsSync(launch.args[0])).toBe(true);
  });

  it("starts a catalog server added since rows stopped storing a launch", () => {
    expect(stdioLaunch(row({ builtinKey: "brave" }), {}).command).toBe(process.execPath);
  });

  it("tells the binary to run as Node, with the server's secrets alongside", () => {
    const { env } = stdioLaunch(staleBrave, { BRAVE_API_KEY: "key" });
    expect(env).toMatchObject({ ELECTRON_RUN_AS_NODE: "1", BRAVE_API_KEY: "key" });
  });

  it("lets a secret win over the row's plaintext env", () => {
    const launch = stdioLaunch(row({ command: "server", env: { TOKEN: "plain" } }), { TOKEN: "secret" });
    expect(launch.env.TOKEN).toBe("secret");
  });

  it("never hands the child the rest of the host's environment", () => {
    process.env.LOXAIC_LAUNCH_TEST_LEAK = "host";
    try {
      expect(stdioLaunch(staleBrave, {}).env).not.toHaveProperty("LOXAIC_LAUNCH_TEST_LEAK");
    } finally {
      delete process.env.LOXAIC_LAUNCH_TEST_LEAK;
    }
  });

  it("starts a custom server as configured, without the flag", () => {
    const launch = stdioLaunch(row({ command: "/usr/bin/server", args: ["--port", 4] }), {});
    expect(launch).toMatchObject({ command: "/usr/bin/server", args: ["--port", "4"] });
    expect(launch.env).not.toHaveProperty("ELECTRON_RUN_AS_NODE");
  });

  it("never lets a row unset what the catalog's launch needs", () => {
    const launch = stdioLaunch(row({ builtinKey: "brave", env: { ELECTRON_RUN_AS_NODE: "" } }), {
      ELECTRON_RUN_AS_NODE: "0",
    });
    expect(launch.env.ELECTRON_RUN_AS_NODE).toBe("1");
  });

  it("refuses a built-in the catalog no longer has, whatever its row stored", () => {
    const retired = row({ builtinKey: "retired", command: process.execPath, args: [STALE_PATH] });
    expect(() => stdioLaunch(retired, {})).toThrow('built-in MCP server "retired" is not in this version');
  });

  it("refuses a row with nothing to start", () => {
    expect(() => stdioLaunch(row({}), {})).toThrow("no command configured");
  });
});

describe("connecting to a row stored by an older build", () => {
  const userId = `test-mcp-launch-${uuid()}`;

  beforeAll(async () => {
    const now = new Date();
    await db
      .insert(user)
      .values({ id: userId, name: "t", email: `${userId}@example.test`, emailVerified: true, createdAt: now, updatedAt: now });
  });

  afterAll(async () => {
    await db.delete(mcpServers).where(eq(mcpServers.ownerId, userId));
    await db.delete(user).where(eq(user.id, userId));
  });

  it("really connects and lists the server's tools", async () => {
    const [stale] = await db
      .insert(mcpServers)
      .values({
        ownerId: userId,
        name: "Brave Search",
        slug: "brave",
        transport: "stdio",
        builtinKey: "brave",
        command: "/opt/old/loxaic",
        args: [STALE_PATH],
        env: { BRAVE_API_KEY: "not-a-key" },
      })
      .returning();

    let tools;
    try {
      tools = await listServerTools(userId, stale);
    } finally {
      await dropEntry(userId, stale.id);
    }

    expect(tools.map((t) => t.name)).toContain("brave_web_search");
    const after = await db.query.mcpServers.findFirst({ where: eq(mcpServers.id, stale.id) });
    expect(after?.lastError).toBeNull();
    expect(after?.lastConnectedAt).not.toBeNull();
  }, 20_000);

  it("records the end of what a server that will not start wrote to stderr, secrets redacted", async () => {
    const secret = "sekrit-value-1234";
    const script = `process.stderr.write("x".repeat(3000) + " cannot start: " + process.env.TOKEN, () => process.exit(3))`;
    const [broken] = await db
      .insert(mcpServers)
      .values({
        ownerId: userId,
        name: "Broken",
        slug: "broken",
        transport: "stdio",
        command: process.execPath,
        args: ["-e", script],
        secrets: encryptSecrets({ TOKEN: secret }),
      })
      .returning();

    try {
      await expect(listServerTools(userId, broken)).rejects.toThrow("cannot start: [redacted]");
    } finally {
      await dropEntry(userId, broken.id);
    }

    const after = await db.query.mcpServers.findFirst({ where: eq(mcpServers.id, broken.id) });
    expect(after?.lastError).toContain("(stderr: ");
    expect(after?.lastError).toMatch(/cannot start: \[redacted\]\)$/);
    expect(after?.lastError).not.toContain(secret);
    expect(after?.lastError?.length).toBeLessThan(600);
  }, 20_000);

  it("never reports part of a secret the cut would have split", async () => {
    const secret = "sekrit-value-1234";
    // Without redacting first, the reported tail would start with "-1234".
    const script = `process.stderr.write(process.env.TOKEN + "y".repeat(495), () => process.exit(3))`;
    const [broken] = await db
      .insert(mcpServers)
      .values({
        ownerId: userId,
        name: "Split",
        slug: "split",
        transport: "stdio",
        command: process.execPath,
        args: ["-e", script],
        secrets: encryptSecrets({ TOKEN: secret }),
      })
      .returning();

    try {
      await expect(listServerTools(userId, broken)).rejects.toThrow();
    } finally {
      await dropEntry(userId, broken.id);
    }

    const after = await db.query.mcpServers.findFirst({ where: eq(mcpServers.id, broken.id) });
    expect(after?.lastError).toContain("yyyy)");
    expect(after?.lastError).not.toContain("1234");
  }, 20_000);
});
