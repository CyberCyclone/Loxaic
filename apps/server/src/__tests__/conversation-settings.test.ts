import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db, eq } from "@loxaic/db";
import { serverSettings } from "@loxaic/db/schema";
import {
  __setConversationLoadFailedForTest,
  __setLoadFailedForTest,
  conversationPurgeAt,
  conversationRetentionUnknown,
  getConversationSettings,
  getSandboxSettings,
  loadServerSettings,
  resetServerSettingsCache,
  SettingsError,
  updateConversationSettings,
} from "../settings.ts";

/**
 * The retention policy: what it resolves to, and — the part that matters —
 * which way it fails.
 *
 * Its own file rather than a block in settings.test.ts because that suite
 * deletes the `sandbox` row in its afterEach and pins sandbox env vars; this
 * one owns the `conversations` row and its own two variables, and the two
 * should not be able to clear each other's state.
 */
const KEY = "conversations";
const ENV_KEYS = ["DELETED_CHAT_RETENTION_ENABLED", "DELETED_CHAT_RETENTION_DAYS"] as const;

const DAY_MS = 24 * 60 * 60 * 1000;

let saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

beforeEach(() => {
  saved = {};
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    Reflect.deleteProperty(process.env, key);
  }
  resetServerSettingsCache();
});

afterEach(async () => {
  for (const key of ENV_KEYS) {
    const value = saved[key];
    if (value === undefined) Reflect.deleteProperty(process.env, key);
    else process.env[key] = value;
  }
  resetServerSettingsCache();
  await db.delete(serverSettings).where(eq(serverSettings.key, KEY));
});

describe("conversation retention settings", () => {
  it("is off by default, which is what makes 'Delete chat' mean what it says", () => {
    const s = getConversationSettings();
    expect(s.keepDeleted).toBe(false);
    expect(s.keepDeletedDays).toBe(30);
    expect(s.envOverrides).toEqual({ keepDeleted: false, keepDeletedDays: false });
  });

  it("reads a persisted policy", async () => {
    await db.insert(serverSettings).values({ key: KEY, value: { keepDeleted: true, keepDeletedDays: 7 } });
    await loadServerSettings();
    expect(getConversationSettings()).toMatchObject({ keepDeleted: true, keepDeletedDays: 7 });
  });

  it("lets the environment pin either field, and refuses to write a pinned one", async () => {
    process.env.DELETED_CHAT_RETENTION_ENABLED = "1";
    process.env.DELETED_CHAT_RETENTION_DAYS = "90";
    const s = getConversationSettings();
    expect(s).toMatchObject({ keepDeleted: true, keepDeletedDays: 90 });
    expect(s.envOverrides).toEqual({ keepDeleted: true, keepDeletedDays: true });

    await expect(updateConversationSettings({ keepDeleted: false })).rejects.toMatchObject({
      code: "envOverride",
    });
    await expect(updateConversationSettings({ keepDeletedDays: 5 })).rejects.toMatchObject({
      code: "envOverride",
    });
  });

  it("is a partial patch — flipping the switch does not reset the window", async () => {
    await updateConversationSettings({ keepDeleted: true, keepDeletedDays: 14 });
    await updateConversationSettings({ keepDeleted: false });
    expect(getConversationSettings()).toMatchObject({ keepDeleted: false, keepDeletedDays: 14 });
    // An empty patch is a 400, not a silently empty write.
    await expect(updateConversationSettings({})).rejects.toBeInstanceOf(SettingsError);
  });

  it("rejects a window outside the accepted range rather than clamping it", async () => {
    for (const days of [0, -1, 3651, 1.5]) {
      await expect(updateConversationSettings({ keepDeletedDays: days })).rejects.toBeInstanceOf(SettingsError);
    }
    await expect(updateConversationSettings({ keepDeleted: "yes" })).rejects.toBeInstanceOf(SettingsError);
  });
});

describe("conversationPurgeAt", () => {
  it("derives the date from the policy in force, not from when the row was written", async () => {
    const deletedAt = new Date("2026-01-01T00:00:00Z");
    await updateConversationSettings({ keepDeleted: true, keepDeletedDays: 30 });
    expect(conversationPurgeAt(deletedAt, false)?.getTime()).toBe(deletedAt.getTime() + 30 * DAY_MS);

    // An admin shortening the window moves every retained conversation with
    // it. A stored date would have the admin screen promising one the sweep
    // will not honour.
    await updateConversationSettings({ keepDeletedDays: 7 });
    expect(conversationPurgeAt(deletedAt, false)?.getTime()).toBe(deletedAt.getTime() + 7 * DAY_MS);
  });

  it("is null for a held conversation — nothing will erase it", async () => {
    await updateConversationSettings({ keepDeleted: true });
    expect(conversationPurgeAt(new Date(), true)).toBeNull();
  });

  it("with retention off, is the deletion time itself — the next sweep takes it", () => {
    const deletedAt = new Date("2026-01-01T00:00:00Z");
    expect(conversationPurgeAt(deletedAt, false)?.getTime()).toBe(deletedAt.getTime());
  });
});

describe("when the policy cannot be read", () => {
  it("keeps, rather than erases — the irreversible direction is the permissive one", () => {
    __setConversationLoadFailedForTest(true);
    try {
      expect(getConversationSettings().keepDeleted).toBe(true);
      expect(conversationRetentionUnknown()).toBe(true);
      // And no date, so nothing claims a conversation is about to be erased
      // on a schedule we could not read.
      expect(conversationPurgeAt(new Date(), false)).toBeNull();
    } finally {
      __setConversationLoadFailedForTest(false);
    }
  });

  it("does not disable sandboxes — that coupling is the bug the inference read already documents", () => {
    __setConversationLoadFailedForTest(true);
    try {
      expect(getSandboxSettings().mode).toBe("container");
    } finally {
      __setConversationLoadFailedForTest(false);
    }
  });

  it("an unreadable sandbox row also means an unknown retention policy", () => {
    __setLoadFailedForTest(true);
    try {
      expect(getConversationSettings().keepDeleted).toBe(true);
      expect(conversationRetentionUnknown()).toBe(true);
    } finally {
      __setLoadFailedForTest(false);
    }
  });

  it("but an env pin still wins — it needs no database", () => {
    __setConversationLoadFailedForTest(true);
    process.env.DELETED_CHAT_RETENTION_ENABLED = "0";
    try {
      expect(getConversationSettings().keepDeleted).toBe(false);
      expect(conversationRetentionUnknown()).toBe(false);
    } finally {
      __setConversationLoadFailedForTest(false);
    }
  });
});
