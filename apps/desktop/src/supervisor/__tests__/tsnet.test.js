import { describe, it, expect, afterEach } from "vitest";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { explainExit, startTsnet } from "../tsnet.js";

/**
 * A stand-in for the tsnet-proxy binary that speaks its stdout protocol and
 * reports where its auth key arrived, so the test can assert it was stdin
 * and nowhere else. Driven by its own argv, exactly as the supervisor drives
 * the real one — the hostname picks the script it plays.
 */
const FAKE_TSNET = `#!/usr/bin/env node
const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i === -1 ? null : args[i + 1]; };
const has = (name) => args.includes(name);
const mode = flag("--mode");
const hostname = flag("--hostname");
const report = (extra) => process.stdout.write("REPORT " + JSON.stringify({
  args, envKeys: Object.keys(process.env).sort(), ...extra,
}) + "\\n");

async function main() {
  let key = null;
  if (has("--auth-key-stdin")) {
    key = await new Promise((resolve) => {
      let buf = "";
      process.stdin.on("data", (d) => { buf += d; const nl = buf.indexOf("\\n"); if (nl !== -1) resolve(buf.slice(0, nl)); });
      process.stdin.on("end", () => resolve(buf));
    });
  }
  const leakedEnv = key ? Object.entries(process.env).filter(([, v]) => v && v.includes(key)).map(([k]) => k) : [];
  const inArgv = key ? args.some((a) => a.includes(key)) : false;
  report({ key, leakedEnv, inArgv });

  if (hostname.includes("fail")) {
    process.stderr.write("tsnet-proxy: [backend] health(warnable=tls-cert): error: certificate not available\\n");
    process.stderr.write("2026/01/01 00:00:00 tsnet-proxy: listening on the tailnet at :443: no certificate\\n");
    process.exit(1);
  }
  if (hostname.includes("dies-later")) {
    process.stdout.write("SERVING https://" + hostname + ".tail1234.ts.net\\n");
    setTimeout(() => { process.stderr.write("tsnet-proxy: [backend] health(warnable=login-state): error: node was removed\\n"); process.exit(1); }, 150);
    return;
  }
  process.stdout.write("AUTH_URL https://login.tailscale.com/a/abc123\\n");
  const delay = hostname.includes("slow") ? 2000 : 50;
  setTimeout(() => {
    if (mode === "serve") {
      process.stdout.write("SERVING https://" + hostname + ".tail1234.ts.net\\n");
      process.stdout.write("STATUS " + JSON.stringify({ mode, hostname, ips: ["100.1.2.3"], certDomain: hostname + ".tail1234.ts.net", url: "https://" + hostname + ".tail1234.ts.net", funnel: has("--funnel") }) + "\\n");
    } else {
      process.stdout.write("LISTENING 127.0.0.1:45678\\n");
      process.stdout.write("STATUS " + JSON.stringify({ mode, hostname, ips: ["100.1.2.4"], funnel: false }) + "\\n");
    }
  }, delay);
  setInterval(() => {}, 1000); // stay up until killed
}
main();
`;

let dir;
const running = [];

afterEach(async () => {
  for (const r of running.splice(0)) await r.stop();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function fakeBin() {
  dir = mkdtempSync(path.join(os.tmpdir(), "loxaic-tsnet-sup-"));
  const bin = path.join(dir, "tsnet-proxy");
  writeFileSync(bin, FAKE_TSNET);
  chmodSync(bin, 0o755);
  return bin;
}

function start(overrides = {}) {
  const lines = [];
  const states = [];
  const handle = startTsnet({
    bin: fakeBin(),
    mode: "serve",
    upstream: "http://127.0.0.1:4100",
    hostname: "loxaic-test",
    stateDir: path.join(dir, "state"),
    log: (line) => lines.push(line),
    onState: (s) => states.push({ ...s }),
    ...overrides,
  });
  running.push(handle);
  return { handle, lines, states };
}

function reportFrom(lines) {
  const line = lines.find((l) => l.includes("REPORT "));
  if (!line) throw new Error(`no REPORT line in ${JSON.stringify(lines)}`);
  return JSON.parse(line.slice(line.indexOf("REPORT ") + "REPORT ".length));
}

describe("startTsnet", () => {
  it("walks starting → needs-auth → up, and resolves ready with the served URL", async () => {
    const { handle, states } = start();
    const url = await handle.ready;
    expect(url).toBe("https://loxaic-test.tail1234.ts.net");
    // STATUS follows SERVING on the pipe and may land a tick after `ready`
    // resolves, so wait for it rather than assert on the race.
    await waitFor(() => handle.state.status !== null);
    expect(states.map((s) => s.state)).toEqual(["starting", "needs-auth", "up", "up"]);
    const needsAuth = states.find((s) => s.state === "needs-auth");
    expect(needsAuth.authUrl).toBe("https://login.tailscale.com/a/abc123");
    // Once up, the auth URL is gone — there is nothing left to approve.
    expect(handle.state.authUrl).toBeNull();
    expect(handle.state.status).toMatchObject({ mode: "serve", certDomain: "loxaic-test.tail1234.ts.net" });
  });

  it("resolves a client's local proxy address from LISTENING", async () => {
    const { handle, lines } = start({ mode: "client", upstream: undefined, target: "box.tail1234.ts.net:443" });
    expect(await handle.ready).toBe("http://127.0.0.1:45678");
    const report = reportFrom(lines);
    expect(report.args).toEqual(expect.arrayContaining(["--mode", "client", "--target", "box.tail1234.ts.net:443"]));
    expect(report.args).not.toContain("--tls=false");
  });

  it("passes --tls=false as one argument, the only form Go's flag package accepts", async () => {
    const { handle, lines } = start({ mode: "client", upstream: undefined, target: "100.1.2.3:4100", tls: false });
    await handle.ready;
    expect(reportFrom(lines).args).toContain("--tls=false");
  });

  it("sends the auth key on stdin and nowhere else", async () => {
    const { handle, lines } = start({ authKey: "tskey-auth-sekrit-value" });
    await handle.ready;
    const report = reportFrom(lines);
    expect(report.key).toBe("tskey-auth-sekrit-value");
    expect(report.inArgv).toBe(false);
    expect(report.leakedEnv).toEqual([]);
    expect(report.args).toContain("--auth-key-stdin");
    // The child env is built from scratch, not spread from this process's:
    // nothing this test runner holds (vitest's own variables, the shell's)
    // reaches the sidecar. Checked against the parent's actual keys rather
    // than an allowlist. __CF_USER_TEXT_ENCODING is macOS stamping every
    // process it starts, present in the parent for the same reason — not a
    // leak, and not something spawn() can withhold.
    const allowed = new Set(["PATH", "HOME", "TMPDIR", "__CF_USER_TEXT_ENCODING"]);
    const inherited = Object.keys(process.env).filter((k) => !allowed.has(k) && report.envKeys.includes(k));
    expect(inherited).toEqual([]);
  });

  it("passes --funnel and --control-url through", async () => {
    const { handle, lines } = start({ funnel: true, controlUrl: "https://headscale.example.com" });
    await handle.ready;
    const report = reportFrom(lines);
    expect(report.args).toContain("--funnel");
    expect(report.args).toEqual(expect.arrayContaining(["--control-url", "https://headscale.example.com"]));
    expect(handle.state.funnel).toBe(true);
  });

  it("does not give up on a first login within the old five-second limit", async () => {
    // "slow" delays the address for longer than the old client path waited,
    // scaled down for a unit test — the point is that the timeout is the
    // caller's, not a hard-coded five seconds, and here it is ten minutes.
    const { handle, states } = start({ hostname: "loxaic-slow" });
    expect(await handle.ready).toBe("https://loxaic-slow.tail1234.ts.net");
    expect(states.some((s) => s.state === "error")).toBe(false);
  });

  it("times out with a sentence about approval when the node was never approved", async () => {
    const { handle, states } = start({ hostname: "loxaic-slow", startTimeoutMs: 800 });
    await expect(handle.ready).rejects.toThrow(/not approved on the tailnet in time/);
    expect(handle.state.state).toBe("error");
    expect(states.some((s) => s.state === "needs-auth")).toBe(true);
  });

  it("reports a sidecar that exits before coming up, with its own last word", async () => {
    const { handle } = start({ hostname: "loxaic-fail" });
    await expect(handle.ready).rejects.toThrow(/no certificate/);
    expect(handle.state.state).toBe("error");
    expect(handle.state.error).toBe("listening on the tailnet at :443: no certificate");
  });

  it("reports a sidecar that came up and then died, without rejecting ready twice", async () => {
    const { handle, states } = start({ hostname: "loxaic-dies-later" });
    expect(await handle.ready).toBe("https://loxaic-dies-later.tail1234.ts.net");
    await new Promise((r) => setTimeout(r, 400));
    expect(handle.state.state).toBe("error");
    expect(handle.state.error).toBe("node was removed");
    expect(handle.state.url).toBeNull();
    expect(states.map((s) => s.state)).toEqual(["starting", "up", "error"]);
  });

  it("reports a missing binary as an error without spawning anything", async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "loxaic-tsnet-sup-"));
    const handle = startTsnet({
      bin: path.join(dir, "does-not-exist"),
      mode: "serve",
      upstream: "http://127.0.0.1:4100",
      hostname: "x",
      stateDir: dir,
      log: () => {},
    });
    running.push(handle);
    await expect(handle.ready).rejects.toThrow(/sidecar is missing/);
    expect(handle.state.state).toBe("error");
  });

  it("stop() kills the child and settles as off", async () => {
    const { handle, states } = start();
    await handle.ready;
    await handle.stop();
    expect(handle.state.state).toBe("off");
    expect(states[states.length - 1].state).toBe("off");
  });

  it("stop() before ready rejects ready as stopped, not as an error", async () => {
    const { handle } = start({ hostname: "loxaic-slow" });
    await new Promise((r) => setTimeout(r, 80));
    await handle.stop();
    await expect(handle.ready).rejects.toThrow(/stopped/);
    expect(handle.state.state).toBe("off");
  });
});

describe("explainExit", () => {
  it("prefers the sidecar's own fatal line, stripped of its timestamp and prefix", () => {
    const tail = [
      "tsnet-proxy: [backend] magicsock: something",
      "2026/01/01 00:00:00 tsnet-proxy: listening on the tailnet at :443: no cert",
      "tsnet-proxy: this usually means MagicDNS and HTTPS certificates are not enabled for this tailnet",
    ];
    expect(explainExit(tail, "exited with code 1")).toBe(
      "this usually means MagicDNS and HTTPS certificates are not enabled for this tailnet",
    );
  });

  it("falls back to a health warning, then to the exit status", () => {
    expect(explainExit(["tsnet-proxy: [backend] health(warnable=x): error: node was removed"], "exited with code 1")).toBe(
      "node was removed",
    );
    expect(explainExit(["tsnet-proxy: [backend] chatter"], "stopped by SIGKILL")).toBe(
      "The embedded Tailscale sidecar stopped by SIGKILL.",
    );
  });
});

async function waitFor(fn, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (fn()) return;
    if (Date.now() > deadline) throw new Error("waitFor: condition not met in time");
    await new Promise((r) => setTimeout(r, 20));
  }
}
