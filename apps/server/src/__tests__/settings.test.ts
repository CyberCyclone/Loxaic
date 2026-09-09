import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db, eq } from "@loxaic/db";
import { serverSettings } from "@loxaic/db/schema";
import {
  __setLoadFailedForTest,
  __setSandboxApplyForTest,
  getSandboxSettings,
  loadServerSettings,
  resetServerSettingsCache,
  sandboxDisabledReason,
  SettingsError,
  updateSandboxSettings,
} from "../settings.ts";

const SANDBOX_KEY = "sandbox";
const ENV_KEYS = [
  "SANDBOX_MODE",
  "CONTAINER_SOCKET",
  "SANDBOX_ALLOW_NETWORK",
  "SANDBOX_IDLE_STOP_MS",
  "SANDBOX_REAP_ENABLED",
  "SANDBOX_REAP_AFTER_MS",
] as const;

/** The no-env, nothing-persisted shape. Spread into the per-test expectations
 * so adding a pinnable field doesn't mean editing every assertion. */
const NO_OVERRIDES = {
  mode: false,
  socket: false,
  allowNetwork: false,
  idleStop: false,
  reapEnabled: false,
  reapAfter: false,
} as const;

/** Restores whatever the ambient environment had, so a developer running
 * these with SANDBOX_MODE exported doesn't get a polluted process. */
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
  await db.delete(serverSettings).where(eq(serverSettings.key, SANDBOX_KEY));
});

describe("sandbox settings precedence", () => {
  it("falls back to defaults with no env and nothing persisted", () => {
    const s = getSandboxSettings();
    expect(s.mode).toBe("container");
    expect(s.engine).toBe("auto");
    expect(s.customSocket).toBeNull();
    expect(s.allowNetwork).toBe(false);
    expect(s.envOverrides).toEqual(NO_OVERRIDES);
  });

  it("uses persisted values when the environment says nothing", async () => {
    await db.insert(serverSettings).values({
      key: SANDBOX_KEY,
      value: { mode: "host", engine: "podman", customSocket: null, allowNetwork: true },
    });
    await loadServerSettings();

    const s = getSandboxSettings();
    expect(s.mode).toBe("host");
    expect(s.engine).toBe("podman");
    expect(s.allowNetwork).toBe(true);
    // Persisted is not "overridden" — the GUI must still let an admin edit it.
    expect(s.envOverrides).toEqual(NO_OVERRIDES);
  });

  it("lets the environment win over persisted values, per field", async () => {
    await db.insert(serverSettings).values({
      key: SANDBOX_KEY,
      value: { mode: "host", engine: "podman", customSocket: null, allowNetwork: true },
    });
    await loadServerSettings();
    process.env.SANDBOX_MODE = "off";

    const s = getSandboxSettings();
    expect(s.mode).toBe("off");
    // Untouched by env, so the persisted value still stands.
    expect(s.engine).toBe("podman");
    expect(s.allowNetwork).toBe(true);
    expect(s.envOverrides).toEqual({ ...NO_OVERRIDES, mode: true });
  });

  it("treats CONTAINER_SOCKET as a custom-engine pin covering both socket fields", () => {
    process.env.CONTAINER_SOCKET = "/tmp/custom.sock";
    const s = getSandboxSettings();
    expect(s.engine).toBe("custom");
    expect(s.customSocket).toBe("/tmp/custom.sock");
    expect(s.envOverrides.socket).toBe(true);
  });

  it('reads an empty env var as unset, not as a value ("FOO=" in a .env file)', () => {
    process.env.SANDBOX_MODE = "";
    process.env.CONTAINER_SOCKET = "";
    const s = getSandboxSettings();
    expect(s.mode).toBe("container");
    expect(s.engine).toBe("auto");
    expect(s.envOverrides).toEqual(NO_OVERRIDES);
  });

  it("ignores an unrecognized SANDBOX_MODE rather than pinning it", async () => {
    await db.insert(serverSettings).values({ key: SANDBOX_KEY, value: { mode: "host" } });
    await loadServerSettings();
    process.env.SANDBOX_MODE = "nonsense";

    const s = getSandboxSettings();
    expect(s.mode).toBe("host");
    expect(s.envOverrides.mode).toBe(false);
  });

  it("parses the truthy spellings of SANDBOX_ALLOW_NETWORK", () => {
    for (const value of ["1", "true", "TRUE", "yes"]) {
      process.env.SANDBOX_ALLOW_NETWORK = value;
      expect(getSandboxSettings().allowNetwork).toBe(true);
    }
    for (const value of ["0", "false", "no", "anything-else"]) {
      process.env.SANDBOX_ALLOW_NETWORK = value;
      expect(getSandboxSettings().allowNetwork).toBe(false);
      // Still an override: the env said something, so the GUI can't edit it.
      expect(getSandboxSettings().envOverrides.allowNetwork).toBe(true);
    }
  });

  it("ignores junk in a persisted row instead of trusting it", async () => {
    await db.insert(serverSettings).values({
      key: SANDBOX_KEY,
      value: { mode: "banana", engine: 7, allowNetwork: "yes-please" },
    });
    await loadServerSettings();

    const s = getSandboxSettings();
    expect(s.mode).toBe("container");
    expect(s.engine).toBe("auto");
    expect(s.allowNetwork).toBe(false);
  });
});

describe("updateSandboxSettings validation", () => {
  // Each case below must reject *before* persisting or applying, so none of
  // them reach the sandbox-stopping path (which is global and would disturb
  // the other suites sharing this database).
  async function expectRejection(patch: unknown, code: "invalid" | "envOverride") {
    await expect(updateSandboxSettings(patch)).rejects.toMatchObject({ name: "SettingsError", code });
    const row = await db.query.serverSettings.findFirst({ where: eq(serverSettings.key, SANDBOX_KEY) });
    expect(row).toBeUndefined();
  }

  it("rejects a non-object body", async () => {
    await expectRejection("mode=host", "invalid");
  });

  it("rejects an unknown mode", async () => {
    await expectRejection({ mode: "sideways" }, "invalid");
  });

  it("rejects an unknown engine", async () => {
    await expectRejection({ engine: "containerd" }, "invalid");
  });

  it("rejects a non-boolean allowNetwork", async () => {
    await expectRejection({ allowNetwork: "true" }, "invalid");
  });

  it("ignores unknown keys rather than persisting them", async () => {
    await updateSandboxSettings({ mode: "container", somethingElse: "ignored" });
    const row = await db.query.serverSettings.findFirst({ where: eq(serverSettings.key, SANDBOX_KEY) });
    expect(row?.value).not.toHaveProperty("somethingElse");
  });

  it("rejects engine=custom with no socket, which would silently auto-discover", async () => {
    await expectRejection({ engine: "custom" }, "invalid");
  });

  it("rejects a non-integer or out-of-range duration rather than clamping it", async () => {
    // Rejecting, not clamping: a client that asked for a two-second idle stop
    // should be told it did not get one.
    await expectRejection({ idleStopMs: "4h" }, "invalid");
    await expectRejection({ idleStopMs: 1.5 }, "invalid");
    await expectRejection({ idleStopMs: 1_000 }, "invalid");
    await expectRejection({ reapAfterMs: 60_000 }, "invalid");
    await expectRejection({ reapAfterMs: 100 * 365 * 24 * 60 * 60 * 1000 }, "invalid");
  });

  it("rejects a non-boolean reapEnabled", async () => {
    await expectRejection({ reapEnabled: "yes" }, "invalid");
  });

  it("refuses a retention window shorter than the idle-stop window", async () => {
    // The two timers would otherwise race over the same sandbox: it would be
    // eligible for deletion before it was ever eligible to be paused.
    await expectRejection({ idleStopMs: 24 * 60 * 60 * 1000, reapAfterMs: 60 * 60 * 1000 }, "invalid");
  });

  it("catches the conflict when only one of the pair moves", async () => {
    // Checked against the resolved pair, not just the patch — lowering the
    // retention window alone must still be caught against the stored
    // idle-stop value.
    await updateSandboxSettings({ idleStopMs: 24 * 60 * 60 * 1000 });
    await expect(updateSandboxSettings({ reapAfterMs: 60 * 60 * 1000 })).rejects.toMatchObject({
      name: "SettingsError",
      code: "invalid",
    });
  });

  it("refuses to write a duration the environment pins", async () => {
    process.env.SANDBOX_IDLE_STOP_MS = "60000";
    await expectRejection({ idleStopMs: 4 * 60 * 60 * 1000 }, "envOverride");
  });

  it("lets the environment pin retention in milliseconds, unbounded by the API's ranges", () => {
    // A harness that wants an immediate stop is the reason these pins exist,
    // so they are deliberately not held to the ranges the GUI is.
    process.env.SANDBOX_IDLE_STOP_MS = "1";
    process.env.SANDBOX_REAP_AFTER_MS = "2";
    process.env.SANDBOX_REAP_ENABLED = "false";

    const s = getSandboxSettings();
    expect(s.idleStopMs).toBe(1);
    expect(s.reapAfterMs).toBe(2);
    expect(s.reapEnabled).toBe(false);
    expect(s.envOverrides).toEqual({
      ...NO_OVERRIDES,
      idleStop: true,
      reapAfter: true,
      reapEnabled: true,
    });
  });

  it("ignores junk in a duration env var rather than pinning it to nonsense", () => {
    process.env.SANDBOX_IDLE_STOP_MS = "four hours";
    const s = getSandboxSettings();
    expect(s.idleStopMs).toBe(4 * 60 * 60 * 1000);
    expect(s.envOverrides.idleStop).toBe(false);
  });

  it("refuses to leave container mode while hosting — on the write path, not just at boot", async () => {
    // hostingBlockedReason() guards startup; this guards the only other way
    // the mode changes. Without it an admin on a live Host could switch to
    // "host" and run every other user's commands unisolated immediately, or
    // to "off" and brick the next boot.
    const prev = process.env.LOXAIC_HOSTING;
    process.env.LOXAIC_HOSTING = "1";
    try {
      await expect(updateSandboxSettings({ mode: "host" })).rejects.toMatchObject({
        name: "SettingsError",
        code: "invalid",
      });
      await expect(updateSandboxSettings({ mode: "off" })).rejects.toMatchObject({
        name: "SettingsError",
        code: "invalid",
      });
      const err = await updateSandboxSettings({ mode: "host" }).catch((e: unknown) => e);
      expect((err as SettingsError).message).toContain("hosts for other users");
      // Container stays permitted — the gate pins the value, it doesn't freeze the field.
      await expect(updateSandboxSettings({ mode: "container" })).resolves.toBeDefined();
    } finally {
      if (prev === undefined) delete process.env.LOXAIC_HOSTING;
      else process.env.LOXAIC_HOSTING = prev;
    }
  });

  it("rejects a field pinned by the environment", async () => {
    process.env.SANDBOX_MODE = "host";
    await expectRejection({ mode: "container" }, "envOverride");
  });

  it("rejects an engine change while CONTAINER_SOCKET pins the socket", async () => {
    process.env.CONTAINER_SOCKET = "/tmp/pinned.sock";
    await expectRejection({ engine: "podman" }, "envOverride");
  });

  it("carries a human-readable message naming the variable", async () => {
    process.env.SANDBOX_ALLOW_NETWORK = "0";
    const err = await updateSandboxSettings({ allowNetwork: true }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SettingsError);
    expect((err as SettingsError).message).toContain("SANDBOX_ALLOW_NETWORK");
  });
});

describe("updateSandboxSettings persistence", () => {
  // These assert the write path only. The apply path is global by nature —
  // it stops every running sandbox of the affected kind — and these suites
  // share a Postgres and a container engine with suites running in parallel,
  // so a real change here would stop the MCP e2e suite's live container.
  // Apply behaviour is asserted separately, below, without touching sandboxes.
  beforeEach(() => { __setSandboxApplyForTest(false); });
  afterEach(() => { __setSandboxApplyForTest(true); });

  it("writes the full resolved object and returns the new view", async () => {
    const view = await updateSandboxSettings({ mode: "container", allowNetwork: false });

    expect(view.mode).toBe("container");
    expect(view.allowNetwork).toBe(false);

    const row = await db.query.serverSettings.findFirst({ where: eq(serverSettings.key, SANDBOX_KEY) });
    // Every field is stored, not just the patched ones, so a later read
    // doesn't depend on defaults drifting.
    expect(row?.value).toEqual({
      mode: "container",
      engine: "auto",
      customSocket: null,
      allowNetwork: false,
      idleStopMs: 4 * 60 * 60 * 1000,
      reapEnabled: true,
      reapAfterMs: 30 * 24 * 60 * 60 * 1000,
    });
  });

  it("upserts rather than duplicating the row", async () => {
    await updateSandboxSettings({ mode: "container" });
    await updateSandboxSettings({ mode: "container" });
    const rows = await db.query.serverSettings.findMany({ where: eq(serverSettings.key, SANDBOX_KEY) });
    expect(rows).toHaveLength(1);
  });

  it("accepts engine=custom when a socket comes with it", async () => {
    const view = await updateSandboxSettings({ engine: "custom", customSocket: "/tmp/somewhere.sock" });
    expect(view.engine).toBe("custom");
    expect(view.customSocket).toBe("/tmp/somewhere.sock");
  });

  it("does not let an env-pinned retention pair block an unrelated write", async () => {
    // Both fields are read-only while pinned, so the pair cannot be fixed
    // through the API — and rejecting every write for it would take
    // `{ mode: "off" }` with it, the one call that stops execution while the
    // operator sorts the environment out.
    process.env.SANDBOX_IDLE_STOP_MS = "2";
    process.env.SANDBOX_REAP_AFTER_MS = "1";
    const view = await updateSandboxSettings({ mode: "off" });
    expect(view.mode).toBe("off");
  });

  it("serializes concurrent writes instead of losing one", async () => {
    // Both patches are built from the in-memory `persisted`, so without
    // serialization the later write's object still carries the earlier
    // field's *old* value and silently reverts it.
    await Promise.all([
      updateSandboxSettings({ mode: "host" }),
      updateSandboxSettings({ allowNetwork: true }),
    ]);
    const row = await db.query.serverSettings.findFirst({ where: eq(serverSettings.key, SANDBOX_KEY) });
    expect(row?.value).toMatchObject({ mode: "host", allowNetwork: true });
  });
});

describe("fail-closed when settings can't be read", () => {
  afterEach(() => { __setLoadFailedForTest(false); });

  it("resolves mode to off rather than the permissive default", async () => {
    // A persisted "off" that silently becomes "container" would restart agent
    // execution an admin had deliberately disabled. Migrations only warn in
    // non-strict mode, so a missing table reaches exactly this path.
    await db.insert(serverSettings).values({ key: SANDBOX_KEY, value: { mode: "off" } });
    await loadServerSettings();
    expect(getSandboxSettings().mode).toBe("off");

    resetServerSettingsCache();
    __setLoadFailedForTest(true);
    expect(getSandboxSettings().mode).toBe("off");
    expect(sandboxDisabledReason()).toContain("could not be read");
  });

  it("still lets an explicit env pin win — it needs no database", () => {
    __setLoadFailedForTest(true);
    process.env.SANDBOX_MODE = "host";
    expect(getSandboxSettings().mode).toBe("host");
  });

  it("names the right source when an admin disabled sandboxes via the API", async () => {
    await db.insert(serverSettings).values({ key: SANDBOX_KEY, value: { mode: "off" } });
    await loadServerSettings();
    // Previously hardcoded "SANDBOX_MODE=off", which pointed the admin at an
    // environment variable that isn't set.
    expect(sandboxDisabledReason()).toContain("server settings");
    expect(sandboxDisabledReason()).not.toContain("SANDBOX_MODE");
  });
});
