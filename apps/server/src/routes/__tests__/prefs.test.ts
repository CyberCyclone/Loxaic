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

interface PrefsBody {
  toolAllowlist: string[];
  autoCompact: boolean;
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
  it("defaults autoCompact to on for a user with no prefs row", async () => {
    // A user who has never touched settings must read the same as one whose
    // row says nothing — otherwise the feature looks disabled until they
    // happen to change something unrelated.
    expect(await get()).toEqual({ toolAllowlist: [], autoCompact: true });
  });
});

describe("PATCH /v1/prefs", () => {
  it("turns auto-compaction off and reads it back", async () => {
    const res = await patch({ autoCompact: false });
    expect(res.statusCode).toBe(200);
    expect(res.json<PrefsBody>().autoCompact).toBe(false);
    expect((await get()).autoCompact).toBe(false);
  });

  it("does not disturb the tool allowlist when only autoCompact is sent", async () => {
    await patch({ toolAllowlist: ["fs_read"] });
    await patch({ autoCompact: false });
    const prefs = await get();
    expect(prefs.toolAllowlist).toEqual(["fs_read"]);
    expect(prefs.autoCompact).toBe(false);
  });

  it("does not disturb autoCompact when only the allowlist is sent", async () => {
    await patch({ autoCompact: false });
    await patch({ toolAllowlist: ["grep"] });
    const prefs = await get();
    expect(prefs.autoCompact).toBe(false);
    expect(prefs.toolAllowlist).toEqual(["grep"]);
  });

  it("turns it back on", async () => {
    await patch({ autoCompact: false });
    await patch({ autoCompact: true });
    expect((await get()).autoCompact).toBe(true);
  });

  it("rejects a non-boolean autoCompact", async () => {
    const res = await patch({ autoCompact: "yes" });
    expect(res.statusCode).toBe(400);
  });

  it("rejects an allowlist that is not builtin tool names", async () => {
    expect((await patch({ toolAllowlist: ["not_a_tool"] })).statusCode).toBe(400);
    expect((await patch({ toolAllowlist: "fs_read" })).statusCode).toBe(400);
  });

  it("rejects a patch with nothing in it, rather than writing an empty row", async () => {
    expect((await patch({})).statusCode).toBe(400);
  });
});
