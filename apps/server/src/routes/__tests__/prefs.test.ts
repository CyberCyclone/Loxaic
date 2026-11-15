import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { v4 as uuid } from "uuid";
import Fastify from "fastify";
import { db, eq } from "@loxaic/db";
import { user, userPrefs } from "@loxaic/db/schema";

/**
 * `/v1/prefs` through a real Fastify instance, matching shares.test.ts — only
 * authentication is stubbed.
 *
 * The PATCH used to require `toolAllowlist` on every call. Adding a second
 * field to a route shaped like that is how one setting silently reverts
 * another: any client sending one key would have had to send the other, and a
 * client that read prefs before the user changed something elsewhere would
 * write back a stale value. The partial-update behaviour is therefore asserted
 * directly, in both directions.
 */
const currentUser = { id: "" };

vi.mock("../../auth/middleware", () => ({
  authenticate: () => Promise.resolve(currentUser.id),
}));

const { prefsRoutes } = await import("../prefs.ts");
const { DEFAULT_REVIEW_PROMPT } = await import("../../streams/runs/progress-review.ts");

interface PrefsBody {
  toolAllowlist: string[];
  recentModels: string[];
  approvalTimeoutMs: number | null;
  adaptiveTimeout: boolean;
  progressReview: boolean;
  progressCheckMs: number | null;
  progressCheckSteps: number | null;
  progressReviewPrompt: string | null;
  subagentModelMode: string;
  subagentModel: string | null;
  serverDefaults: {
    approvalTimeoutMs: number;
    progressCheckMs: number;
    progressCheckSteps: number;
    progressReviewPrompt: string;
  };
}

const userId = `test-prefs-${uuid()}`;

const app = Fastify();
prefsRoutes(app);

beforeAll(async () => {
  await app.ready();
  await db.insert(user).values({
    id: userId,
    name: "Test Prefs",
    email: `${userId}@example.test`,
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  currentUser.id = userId;
});

afterAll(async () => {
  await db.delete(userPrefs).where(eq(userPrefs.userId, userId));
  await db.delete(user).where(eq(user.id, userId));
  await app.close();
});

const get = async (): Promise<PrefsBody> =>
  (await app.inject({ method: "GET", url: "/v1/prefs" })).json<PrefsBody>();

async function patch(payload: Record<string, unknown>) {
  return app.inject({ method: "PATCH", url: "/v1/prefs", payload });
}

describe("GET /v1/prefs", () => {
  it("reads the defaults for a user with no prefs row", async () => {
    // A user who has never touched settings must read the same as one whose
    // row says nothing — otherwise a setting looks changed until they happen
    // to change something unrelated. No `autoCompact`: compaction is not a
    // setting any more, and a client from before hides its switch on absence.
    const { serverDefaults, ...prefs } = await get();
    expect(serverDefaults).toBeDefined();
    expect(prefs).toEqual({
      toolAllowlist: [],
      recentModels: [],
      approvalTimeoutMs: null,
      adaptiveTimeout: true,
      progressReview: true,
      progressCheckMs: null,
      progressCheckSteps: null,
      progressReviewPrompt: null,
      subagentModelMode: "choose",
      subagentModel: null,
      bashGrantRetired: false,
    });
  });

  it("reports what a null setting means on this server, so the screen can name it", async () => {
    const saved = { a: process.env.APPROVAL_TIMEOUT_MS, m: process.env.PROGRESS_CHECK_MS, s: process.env.PROGRESS_CHECK_STEPS };
    process.env.APPROVAL_TIMEOUT_MS = "90000";
    process.env.PROGRESS_CHECK_MS = "600000";
    process.env.PROGRESS_CHECK_STEPS = "12";
    try {
      expect((await get()).serverDefaults).toEqual({
        approvalTimeoutMs: 90_000,
        progressCheckMs: 600_000,
        progressCheckSteps: 12,
        progressReviewPrompt: DEFAULT_REVIEW_PROMPT,
      });
    } finally {
      for (const [key, value] of [["APPROVAL_TIMEOUT_MS", saved.a], ["PROGRESS_CHECK_MS", saved.m], ["PROGRESS_CHECK_STEPS", saved.s]] as const) {
        if (value === undefined) Reflect.deleteProperty(process.env, key);
        else process.env[key] = value;
      }
    }
  });
});

describe("PATCH /v1/prefs", () => {
  it("refuses autoCompact by name: compaction cannot be turned off", async () => {
    // Said, not ignored: a client from before would otherwise believe it had
    // turned compaction off.
    const res = await patch({ autoCompact: false });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toMatch(/no longer a setting/);
    expect(await get()).not.toHaveProperty("autoCompact");
  });

  it("refuses the step check-in's settings by name: the progress review replaced them", async () => {
    for (const key of ["maxIterations", "checkinTimeoutMs", "checkinAutoContinues", "loopSensitivity"]) {
      const res = await patch({ [key]: key === "loopSensitivity" ? "normal" : 10 });
      expect(res.statusCode).toBe(400);
      expect(res.json<{ error: string }>().error).toBe(`${key} is no longer a setting: runs are bounded by the progress review`);
    }
    const prefs = await get();
    for (const key of ["maxIterations", "checkinTimeoutMs", "checkinAutoContinues", "loopSensitivity"]) expect(prefs).not.toHaveProperty(key);
  });

  it("does not disturb the tool allowlist when only a review setting is sent, nor the other way", async () => {
    await patch({ toolAllowlist: ["fs_read"] });
    await patch({ progressCheckSteps: 40 });
    expect(await get()).toMatchObject({ toolAllowlist: ["fs_read"], progressCheckSteps: 40 });
    await patch({ toolAllowlist: ["grep"] });
    expect(await get()).toMatchObject({ toolAllowlist: ["grep"], progressCheckSteps: 40 });
  });

  it("rejects an allowlist that is not builtin tool names", async () => {
    expect((await patch({ toolAllowlist: ["not_a_tool"] })).statusCode).toBe(400);
    expect((await patch({ toolAllowlist: "fs_read" })).statusCode).toBe(400);
  });

  it("rejects a patch with nothing in it, rather than writing an empty row", async () => {
    expect((await patch({})).statusCode).toBe(400);
  });

  it("sets each review and wait setting and reads it back, leaving the others alone", async () => {
    expect((await patch({ progressReview: false })).statusCode).toBe(200);
    expect((await patch({ progressCheckMs: 15 * 60_000 })).statusCode).toBe(200);
    expect((await patch({ progressCheckSteps: 50 })).statusCode).toBe(200);
    expect((await patch({ progressReviewPrompt: "Be strict about repeats." })).statusCode).toBe(200);
    expect((await patch({ approvalTimeoutMs: 2 * 60_000 })).statusCode).toBe(200);
    expect((await patch({ adaptiveTimeout: false })).statusCode).toBe(200);
    expect(await get()).toMatchObject({
      progressReview: false,
      progressCheckMs: 15 * 60_000,
      progressCheckSteps: 50,
      progressReviewPrompt: "Be strict about repeats.",
      approvalTimeoutMs: 2 * 60_000,
      adaptiveTimeout: false,
    });
  });

  it("resets each to the server's default with null", async () => {
    await patch({ progressCheckMs: 60_000, progressCheckSteps: 10, progressReviewPrompt: "Mine.", approvalTimeoutMs: 60_000 });
    expect((await patch({ progressCheckMs: null, progressCheckSteps: null, progressReviewPrompt: null, approvalTimeoutMs: null })).statusCode).toBe(200);
    expect(await get()).toMatchObject({ progressCheckMs: null, progressCheckSteps: null, progressReviewPrompt: null, approvalTimeoutMs: null });
  });

  it("refuses values outside the supported ranges, and takes the edges", async () => {
    for (const bad of [4_999, 8 * 60 * 60 * 1000 + 1, 1.5, "60000", true]) {
      expect((await patch({ progressCheckMs: bad })).statusCode).toBe(400);
    }
    expect((await patch({ progressCheckMs: 5_000 })).statusCode).toBe(200);
    expect((await patch({ progressCheckMs: 8 * 60 * 60 * 1000 })).statusCode).toBe(200);
    for (const bad of [2, 501, 3.5, "20"]) expect((await patch({ progressCheckSteps: bad })).statusCode).toBe(400);
    expect((await patch({ progressCheckSteps: 3 })).statusCode).toBe(200);
    expect((await patch({ progressCheckSteps: 500 })).statusCode).toBe(200);
    for (const bad of ["", "   ", "x".repeat(8_001), 7]) expect((await patch({ progressReviewPrompt: bad })).statusCode).toBe(400);
    expect((await patch({ progressReviewPrompt: "x".repeat(8_000) })).statusCode).toBe(200);
    expect((await patch({ progressReview: "yes" })).statusCode).toBe(400);
    for (const bad of [4_999, 86_400_001]) expect((await patch({ approvalTimeoutMs: bad })).statusCode).toBe(400);
  });

  it("refuses to write the server defaults, rather than pretending to", async () => {
    expect((await patch({ serverDefaults: { progressCheckMs: 1 } })).statusCode).toBe(400);
  });

  it("clamps a stored value that arrived some other way, and ignores an unusable prompt", async () => {
    await db
      .update(userPrefs)
      .set({ approvalTimeoutMs: 1, progressCheckMs: 1, progressCheckSteps: 9_999, progressReviewPrompt: "  " })
      .where(eq(userPrefs.userId, userId));
    expect(await get()).toMatchObject({
      approvalTimeoutMs: 5_000,
      progressCheckMs: 5_000,
      progressCheckSteps: 500,
      progressReviewPrompt: null,
    });
  });
});

describe("the sub-agent model setting", () => {
  /**
   * Which model a sub-agent runs on is a spending decision as much as a
   * preference: `fixed` sends every child of every conversation to one model.
   * So a fixed model is checked the way a routine's is when saved, and "fixed"
   * with nothing to fix it to is refused rather than left to fall back.
   */
  const withMock = async <T>(fn: () => Promise<T>): Promise<T> => {
    const previous = process.env.MOCK_INFERENCE;
    // Under the mock any bare reference resolves, which stands in for a model
    // this server can serve.
    process.env.MOCK_INFERENCE = "true";
    try {
      return await fn();
    } finally {
      if (previous === undefined) delete process.env.MOCK_INFERENCE;
      else process.env.MOCK_INFERENCE = previous;
    }
  };

  it("refuses a mode it does not know", async () => {
    for (const bad of ["always", "", null, 1, true]) {
      expect((await patch({ subagentModelMode: bad })).statusCode).toBe(400);
    }
  });

  it("refuses a fixed model this server cannot serve, naming why", async () => {
    const res = await patch({ subagentModelMode: "fixed", subagentModel: "no-such-provider::some-model" });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toMatch(/provider/i);
    for (const bad of ["", "default", 1, true]) {
      expect((await patch({ subagentModel: bad })).statusCode).toBe(400);
    }
    // Nothing was written by any of those.
    expect(await get()).toMatchObject({ subagentModelMode: "choose", subagentModel: null });
  });

  it("refuses 'fixed' when the model saved for it can no longer be served", async () => {
    // Saved while its provider existed; the provider has since been deleted.
    // The patch names only the mode, so the model is the stored one.
    await db
      .insert(userPrefs)
      .values({ userId, subagentModelMode: "parent", subagentModel: "deleted-provider::some-model" })
      .onConflictDoUpdate({ target: userPrefs.userId, set: { subagentModelMode: "parent", subagentModel: "deleted-provider::some-model" } });
    try {
      const res = await patch({ subagentModelMode: "fixed" });
      expect(res.statusCode).toBe(400);
      expect(res.json<{ error: string }>().error).toMatch(/provider/i);
      expect((await get()).subagentModelMode).toBe("parent");
    } finally {
      await db.update(userPrefs).set({ subagentModelMode: "choose", subagentModel: null }).where(eq(userPrefs.userId, userId));
    }
  });

  it("refuses 'fixed' with no model to fix it to", async () => {
    expect((await patch({ subagentModelMode: "fixed" })).statusCode).toBe(400);
    expect((await get()).subagentModelMode).toBe("choose");
  });

  it("saves a fixed model, keeps it across a change of mode, and will not clear it while fixed", async () => {
    await withMock(async () => {
      const res = await patch({ subagentModelMode: "fixed", subagentModel: "llama-3.1-8b-instruct" });
      expect(res.statusCode).toBe(200);
      expect(await get()).toMatchObject({ subagentModelMode: "fixed", subagentModel: "llama-3.1-8b-instruct" });
      // Clearing the model out from under `fixed` would leave the setting
      // saying one thing while children ran on another.
      expect((await patch({ subagentModel: null })).statusCode).toBe(400);
      // Moving off `fixed` keeps the model, so going back offers it again —
      // and now it may be cleared.
      expect((await patch({ subagentModelMode: "parent" })).statusCode).toBe(200);
      expect(await get()).toMatchObject({ subagentModelMode: "parent", subagentModel: "llama-3.1-8b-instruct" });
      expect((await patch({ subagentModelMode: "fixed" })).statusCode).toBe(200);
      expect((await patch({ subagentModelMode: "choose", subagentModel: null })).statusCode).toBe(200);
      expect(await get()).toMatchObject({ subagentModelMode: "choose", subagentModel: null });
    });
  });

  it("leaves every other setting alone", async () => {
    await patch({ progressCheckSteps: 42 });
    await patch({ subagentModelMode: "parent" });
    expect(await get()).toMatchObject({ progressCheckSteps: 42, subagentModelMode: "parent" });
  });
});

describe("command rules and the retired bash grant", () => {
  interface RulesBody {
    rules: { id: string; pattern: string; action: string; source: string }[];
  }
  const rules = async () => (await app.inject({ method: "GET", url: "/v1/prefs/command-rules" })).json<RulesBody>().rules;

  it("adds, lists and removes rules, refusing ones that would allow too much", async () => {
    const added = await app.inject({ method: "POST", url: "/v1/prefs/command-rules", payload: { pattern: "  gh   pr view *", action: "allow" } });
    expect(added.statusCode).toBe(200);
    // Again, and as another action: the first is a no-op, the second its own rule.
    await app.inject({ method: "POST", url: "/v1/prefs/command-rules", payload: { pattern: "gh pr view *", action: "allow" } });
    await app.inject({ method: "POST", url: "/v1/prefs/command-rules", payload: { pattern: "rm *", action: "deny" } });
    const listed = await rules();
    expect(listed.map((r) => [r.pattern, r.action, r.source])).toEqual([
      ["gh pr view *", "allow", "settings"],
      ["rm *", "deny", "settings"],
    ]);

    for (const payload of [{ pattern: "python *", action: "allow" }, { pattern: "*", action: "deny" }, { pattern: "ls; rm", action: "allow" }, { pattern: "ls", action: "sometimes" }]) {
      expect((await app.inject({ method: "POST", url: "/v1/prefs/command-rules", payload })).statusCode).toBe(400);
    }

    const removed = await app.inject({ method: "DELETE", url: `/v1/prefs/command-rules/${listed[0].id}` });
    expect(removed.statusCode).toBe(200);
    expect((await rules()).map((r) => r.pattern)).toEqual(["rm *"]);
    expect((await app.inject({ method: "DELETE", url: `/v1/prefs/command-rules/${listed[0].id}` })).statusCode).toBe(404);
    expect((await app.inject({ method: "DELETE", url: "/v1/prefs/command-rules/not-an-id" })).statusCode).toBe(404);
    for (const r of await rules()) await app.inject({ method: "DELETE", url: `/v1/prefs/command-rules/${r.id}` });
  });

  it("drops bash from the allowlist instead of refusing an older client's whole write", async () => {
    const res = await patch({ toolAllowlist: ["fs_write", "bash"] });
    expect(res.statusCode).toBe(200);
    expect(res.json<PrefsBody>().toolAllowlist).toEqual(["fs_write"]);
    expect((await patch({ toolAllowlist: ["not_a_tool"] })).statusCode).toBe(400);
    await patch({ toolAllowlist: [] });
  });

  it("says once that an old bash grant was retired, until dismissed", async () => {
    await db.update(userPrefs).set({ bashGrantRetiredAt: new Date() }).where(eq(userPrefs.userId, userId));
    expect((await get()) as unknown as { bashGrantRetired: boolean }).toMatchObject({ bashGrantRetired: true });
    expect((await patch({ bashGrantNoticeSeen: false })).statusCode).toBe(400);
    const seen = await patch({ bashGrantNoticeSeen: true });
    expect(seen.json<{ bashGrantRetired: boolean }>().bashGrantRetired).toBe(false);
  });
});
