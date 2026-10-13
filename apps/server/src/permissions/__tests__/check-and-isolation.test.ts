import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { v4 as uuid } from "uuid";
import { db, eq, inArray } from "@loxaic/db";
import { conversations, sandboxes, user } from "@loxaic/db/schema";
import { parseVerdict, permissionCheckInstruction, permissionCheckMessages, PERMISSION_CHECK_MARKER } from "../check.ts";
import { isolationFor, isSensitiveWrite } from "../isolation.ts";

describe("parseVerdict", () => {
  it.each([
    ["VERDICT: ALLOW\nREASON: Runs the tests.", { verdict: "allow", reason: "Runs the tests." }],
    ["VERDICT: ASK\nREASON: Sends data off the machine.", { verdict: "ask", reason: "Sends data off the machine." }],
    ["VERDICT: ALLOW - Running the test suite is local.", { verdict: "allow", reason: "Running the test suite is local." }],
    ["VERDICT: ALLOW\n\nThe command only runs tests.", { verdict: "allow" }],
    ["**VERDICT: ask**", { verdict: "ask" }],
    // The last verdict decides: a model that changes its mind asked.
    ["VERDICT: ALLOW\nOn reflection:\nVERDICT: ASK\nREASON: It pushes.", { verdict: "ask", reason: "It pushes." }],
  ])("reads %j", (text, verdict) => {
    expect(parseVerdict(text)).toEqual(verdict);
  });

  it.each(["", "I would rather not say.", "ALLOW", "The verdict is ALLOW.", "VERDICT: MAYBE"])("finds nothing in %j", (text) => {
    expect(parseVerdict(text)).toBeNull();
  });
});

describe("the check's request", () => {
  it("is the run's messages, a placeholder per pending call, then the instruction", () => {
    const run = [
      { role: "system" as const, content: "sys" },
      { role: "user" as const, content: "do it" },
      { role: "assistant" as const, content: null, tool_calls: [] },
    ];
    const toolResult = (id: string, name: string, content: string) => ({ role: "tool" as const, tool_call_id: id, name, content });
    const out = permissionCheckMessages(run, [{ id: "a", name: "bash" }, { id: "b", name: "fs_read" }], toolResult, "check");
    expect(out.slice(0, 3)).toEqual(run);
    expect(out.slice(3).map((m) => [m.role, "tool_call_id" in m ? m.tool_call_id : null])).toEqual([
      ["tool", "a"],
      ["tool", "b"],
      ["user", null],
    ]);
  });

  it("starts with the marker and names the action and directory", () => {
    const text = permissionCheckInstruction("run the shell command: make", "/home/loxaic/repo");
    expect(text.startsWith(PERMISSION_CHECK_MARKER)).toBe(true);
    expect(text).toContain("Action: run the shell command: make");
    expect(text).toContain("Working directory: /home/loxaic/repo");
  });
});

describe("isSensitiveWrite", () => {
  const roots = ["/home/loxaic/repo"];
  it.each(["notes.txt", "src/a.ts", "/home/loxaic/repo/x", ".eslintrc"])("%s is not", (p) => {
    expect(isSensitiveWrite(p, roots)).toBe(false);
  });
  it.each(["~/.bashrc", "../out", ".git/hooks/pre-commit", "a/.git/config", "/home/loxaic/.profile", "/etc/x", "/home/loxaic/repository"])(
    "%s is",
    (p) => {
      expect(isSensitiveWrite(p, roots)).toBe(true);
    },
  );
  it("treats every absolute path as outside when the root is not known", () => {
    expect(isSensitiveWrite("/tmp/x", [])).toBe(true);
  });
});

describe("isolationFor", () => {
  const ownerId = `test-isolation-${uuid()}`;
  const convIds: string[] = [];
  const saved = { mode: process.env.SANDBOX_MODE, network: process.env.SANDBOX_ALLOW_NETWORK };

  beforeAll(async () => {
    await db.insert(user).values({ id: ownerId, name: "Isolation", email: `${ownerId}@example.test`, emailVerified: true, createdAt: new Date(), updatedAt: new Date() });
  });
  afterEach(() => {
    for (const [key, value] of [["SANDBOX_MODE", saved.mode], ["SANDBOX_ALLOW_NETWORK", saved.network]] as const) {
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value;
    }
  });
  afterAll(async () => {
    await db.delete(sandboxes).where(eq(sandboxes.ownerId, ownerId));
    if (convIds.length) await db.delete(conversations).where(inArray(conversations.id, convIds));
    await db.delete(user).where(eq(user.id, ownerId));
  });

  async function conversation(workspace: unknown = null): Promise<string> {
    const [row] = await db.insert(conversations).values({ ownerId, title: "isolation", kind: "agent", workspace }).returning();
    convIds.push(row.id);
    return row.id;
  }

  it("is isolated only for a server container with no network", async () => {
    process.env.SANDBOX_MODE = "container";
    process.env.SANDBOX_ALLOW_NETWORK = "false";
    const scratch = await conversation();
    expect((await isolationFor(scratch)).isolated).toBe(true);

    process.env.SANDBOX_ALLOW_NETWORK = "true";
    expect((await isolationFor(scratch)).isolated).toBe(false);

    process.env.SANDBOX_MODE = "host";
    expect(await isolationFor(scratch)).toEqual({ isolated: false, roots: [] });
  });

  it("trusts the sandbox row's own network over the current setting", async () => {
    process.env.SANDBOX_MODE = "container";
    process.env.SANDBOX_ALLOW_NETWORK = "false";
    const convId = await conversation();
    await db.insert(sandboxes).values({
      ownerId,
      conversationId: convId,
      provider: "container",
      containerId: `fake-${uuid()}`,
      image: "loxaic-sandbox:test",
      status: "stopped",
      limits: { memory: 512, cpu: 1, network: true },
    });
    expect((await isolationFor(convId)).isolated).toBe(false);
  });

  it("is never isolated for a GitHub workspace or a folder on someone's own machine", async () => {
    process.env.SANDBOX_MODE = "container";
    process.env.SANDBOX_ALLOW_NETWORK = "false";
    const github = await conversation({ kind: "github", repo: "o/r", baseBranch: "main", branch: "b", cloneUrl: "https://x/o/r.git" });
    expect(await isolationFor(github)).toEqual({ isolated: false, roots: ["/home/loxaic/repo"] });
    const local = await conversation({ kind: "local", executorId: "e", executorName: "mac", path: "/Users/me/p", isolation: "direct" });
    expect(await isolationFor(local)).toEqual({ isolated: false, roots: ["/Users/me/p"] });
  });
});
