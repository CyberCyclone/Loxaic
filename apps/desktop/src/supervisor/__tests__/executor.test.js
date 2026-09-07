import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { startExecutor } from "../executor.js";
import { addRoot, loadOrCreateExecutorId, loadRoots, removeRoot, rootsPath } from "../executor-store.js";

/**
 * A stand-in for dist/executor.js that reports what it was given, so the
 * test can assert *where* the token travelled: only on stdin. It speaks the
 * same stdout handshake the real one does.
 */
const FAKE_EXECUTOR = `
const { createInterface } = require("node:readline");
const rl = createInterface({ input: process.stdin });
let first = true;
rl.on("line", (line) => {
  if (first) {
    first = false;
    const leaked = Object.entries(process.env).filter(([, v]) => v && v.includes(line)).map(([k]) => k);
    const inArgv = process.argv.some((a) => a.includes(line));
    process.stdout.write("REPORT " + JSON.stringify({
      token: line,
      leakedEnv: leaked,
      inArgv,
      api: process.env.LOXAIC_API_URL,
      id: process.env.LOXAIC_EXECUTOR_ID,
      name: process.env.LOXAIC_EXECUTOR_NAME,
      roots: process.env.LOXAIC_EXECUTOR_ROOTS_FILE,
      envKeys: Object.keys(process.env).sort(),
    }) + "\\n");
    process.stdout.write("LOXAIC_EXECUTOR_CONNECTED\\n");
    return;
  }
  process.stdout.write("CONTROL " + line + "\\n");
  if (line.includes("unauthorized-please")) {
    process.stdout.write("LOXAIC_EXECUTOR_UNAUTHORIZED\\n");
    process.exit(0);
  }
});
rl.on("close", () => process.exit(0));
`;

let dir;
let running = [];

afterEach(async () => {
  for (const r of running.splice(0)) await r.stop();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function fakeEntry() {
  dir = mkdtempSync(path.join(os.tmpdir(), "loxaic-executor-sup-"));
  const entry = path.join(dir, "executor.js");
  writeFileSync(entry, FAKE_EXECUTOR);
  return entry;
}

function start(entry, overrides = {}) {
  const lines = [];
  const states = [];
  const controller = startExecutor({
    entry,
    cwd: dir,
    apiBaseUrl: "http://127.0.0.1:1",
    executorId: "machine-1",
    name: "Test Machine",
    rootsFile: path.join(dir, "roots.json"),
    token: "sekrit-token-value",
    log: (line) => lines.push(line),
    onState: (s) => states.push(s),
    ...overrides,
  });
  running.push(controller);
  return { controller, lines, states };
}

async function waitFor(fn, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("startExecutor", () => {
  it("hands the token over on stdin only — never in the environment or argv — and builds the env from scratch", async () => {
    // A value that is in *this* process's environment and must not be in
    // the child's: proof the env is built up, not filtered down.
    process.env.LOXAIC_TEST_SENTINEL = "must-not-leak";
    try {
      const { controller, lines } = start(fakeEntry());
      const report = await waitFor(() => lines.find((l) => l.includes("REPORT ")));
      const parsed = JSON.parse(report.slice(report.indexOf("REPORT ") + 7));
      expect(parsed.token).toBe("sekrit-token-value");
      expect(parsed.leakedEnv).toEqual([]);
      expect(parsed.inArgv).toBe(false);
      expect(parsed.api).toBe("http://127.0.0.1:1");
      expect(parsed.id).toBe("machine-1");
      expect(parsed.name).toBe("Test Machine");
      expect(parsed.roots).toBe(path.join(dir, "roots.json"));
      expect(parsed.envKeys).not.toContain("LOXAIC_TEST_SENTINEL");
      for (const key of ["ELECTRON_RUN_AS_NODE", "HOME", "PATH", "NODE_ENV"]) expect(parsed.envKeys).toContain(key);
      // Only what we set, plus whatever the OS itself stamps on every
      // process (macOS adds __CF_USER_TEXT_ENCODING, for one).
      const ours = new Set(["ELECTRON_RUN_AS_NODE", "HOME", "LOXAIC_API_URL", "LOXAIC_EXECUTOR_ID", "LOXAIC_EXECUTOR_NAME", "LOXAIC_EXECUTOR_ROOTS_FILE", "NODE_ENV", "PATH"]);
      expect(parsed.envKeys.filter((k) => !ours.has(k) && !k.startsWith("__"))).toEqual([]);
      await waitFor(() => controller.state.state === "online");
    } finally {
      delete process.env.LOXAIC_TEST_SENTINEL;
    }
  });

  it("tells the executor to re-read its roots over stdin", async () => {
    const { controller, lines } = start(fakeEntry());
    await waitFor(() => controller.state.state === "online");
    controller.reloadRoots();
    const control = await waitFor(() => lines.find((l) => l.includes("CONTROL ")));
    expect(control).toContain('{"type":"roots"}');
  });

  it("does not restart an executor the server rejected", async () => {
    const entry = fakeEntry();
    // A child that reports its session as rejected right after connecting.
    writeFileSync(
      entry,
      `${FAKE_EXECUTOR}\nsetTimeout(() => { process.stdout.write("LOXAIC_EXECUTOR_UNAUTHORIZED\\n"); process.exit(0); }, 50);`,
    );
    const { controller, states } = start(entry);
    await waitFor(() => controller.state.state === "unauthorized");
    // Long enough for a restart to have been scheduled and fired if it were
    // going to be — the base backoff is one second.
    await new Promise((r) => setTimeout(r, 1_300));
    expect(controller.state.state).toBe("unauthorized");
    expect(states.filter((s) => s.state === "starting")).toHaveLength(1);
    expect(states.some((s) => s.state === "connecting")).toBe(false);
  });

  it("reports offline after stop and never restarts", async () => {
    const { controller, states } = start(fakeEntry());
    await waitFor(() => controller.state.state === "online");
    await controller.stop();
    expect(controller.state.state).toBe("offline");
    await new Promise((r) => setTimeout(r, 100));
    expect(states.filter((s) => s.state === "starting")).toHaveLength(1);
  });

  it("restarts with backoff when the process dies on its own", async () => {
    const entry = fakeEntry();
    // A child that exits immediately after the handshake.
    writeFileSync(entry, `${FAKE_EXECUTOR}\nsetTimeout(() => process.exit(3), 50);`);
    const { controller, states } = start(entry);
    await waitFor(() => states.some((s) => s.reason && s.reason.includes("exited with code 3")));
    expect(controller.state.state).toBe("connecting");
    await controller.stop();
  });
});

describe("executor store", () => {
  it("adds roots once, refuses relative paths, removes only what is there, and keeps the file private", () => {
    const store = mkdtempSync(path.join(os.tmpdir(), "loxaic-executor-store-"));
    try {
      expect(loadRoots(store)).toEqual([]);
      expect(addRoot(store, "/tmp/a")).toEqual(["/tmp/a"]);
      expect(addRoot(store, "/tmp/a")).toEqual(["/tmp/a"]);
      expect(addRoot(store, "/tmp/b")).toEqual(["/tmp/a", "/tmp/b"]);
      expect(() => addRoot(store, "relative/dir")).toThrow(/absolute/);
      expect(() => addRoot(store, 42)).toThrow(/absolute/);
      expect(removeRoot(store, "/tmp/nope")).toEqual(["/tmp/a", "/tmp/b"]);
      expect(removeRoot(store, "/tmp/a")).toEqual(["/tmp/b"]);
      expect(JSON.parse(readFileSync(rootsPath(store), "utf8"))).toEqual({ roots: ["/tmp/b"] });
      expect(statSync(rootsPath(store)).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(store, { recursive: true, force: true });
    }
  });

  it("mints a fallback executor id once and keeps it", () => {
    const store = mkdtempSync(path.join(os.tmpdir(), "loxaic-executor-id-"));
    try {
      const first = loadOrCreateExecutorId(store);
      expect(first).toMatch(/^[0-9a-f-]{36}$/);
      expect(loadOrCreateExecutorId(store)).toBe(first);
    } finally {
      rmSync(store, { recursive: true, force: true });
    }
  });
});
