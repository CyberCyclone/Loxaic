import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";

const STOP_GRACE_MS = 5_000;

/**
 * How long to wait for the sidecar to come up before giving up on it.
 *
 * Not five seconds any more. The old client path had that, and it was the
 * right number for a node that had already been approved — with stored state
 * tsnet joins in about a second. But a *first* run blocks until a person has
 * opened the auth URL in a browser and clicked approve, and five seconds is
 * shorter than it takes to read the prompt. Ten minutes is the outer bound on
 * "went to get a coffee first"; a parent that wants to stop sooner calls
 * stop().
 */
const START_TIMEOUT_MS = 10 * 60 * 1000;

/** How many stderr lines to keep for an error message. */
const STDERR_TAIL = 30;

/**
 * Runs the tsnet sidecar (infra/tsnet-proxy) as a child of this process and
 * turns its stdout handshake into a state the renderer can show.
 *
 * Two directions, same supervisor: `serve` publishes the local server on the
 * tailnet (a Host), `client` proxies a local port to a remote one (a Client).
 * The sidecar itself documents the line protocol; what this adds is the state
 * machine around it —
 *
 *   starting → needs-auth → up
 *            ↘ error       ↗
 *   off (after stop)
 *
 * — where `needs-auth` carries the URL a person has to open, `up` carries the
 * address the node is reachable at, and `error` carries a sentence. `ready`
 * resolves with that address, or rejects with the sentence.
 *
 * An auth key travels on stdin, first line, and nowhere else — not argv,
 * which any process can read through `ps`; not env, which a child could dump
 * into a log. Same rule as the executor's session token, same mechanism.
 *
 * No automatic restart. Every way the sidecar dies after starting is a
 * configuration problem — a tailnet with certificates switched off, a policy
 * with no Funnel grant, a revoked node — and restarting into the same
 * configuration would loop on the same failure while the message a person
 * could act on scrolled away. The error state carries it instead, and the
 * desktop offers a retry.
 */
export function startTsnet({
  bin,
  mode,
  target,
  tls = true,
  upstream,
  funnel = false,
  hostname,
  stateDir,
  controlUrl,
  authKey,
  startTimeoutMs = START_TIMEOUT_MS,
  log = console.log,
  onState = () => {},
}) {
  if (mode !== "serve" && mode !== "client") throw new Error(`tsnet: unknown mode ${String(mode)}`);
  if (!hostname) throw new Error("tsnet: hostname is required");
  if (!stateDir) throw new Error("tsnet: stateDir is required");
  if (mode === "serve" && !upstream) throw new Error("tsnet: serve mode needs an upstream");
  if (mode === "client" && !target) throw new Error("tsnet: client mode needs a target");

  let state = { state: "starting", mode, funnel, authUrl: null, url: null, status: null, error: null };
  let child = null;
  let stopped = false;
  let settled = false;
  const stderrTail = [];

  let resolveReady;
  let rejectReady;
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  // A caller that only ever reads `state` and never awaits `ready` must not
  // turn a sidecar failure into an unhandled rejection.
  ready.catch(() => undefined);

  const setState = (patch) => {
    state = { ...state, ...patch };
    onState(state);
  };

  const fail = (message) => {
    if (settled) return;
    settled = true;
    setState({ state: "error", error: message });
    rejectReady(new Error(message));
  };

  const succeed = (url) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    setState({ state: "up", url, authUrl: null, error: null });
    resolveReady(url);
  };

  const args = ["--mode", mode, "--hostname", hostname, "--state-dir", stateDir];
  if (mode === "serve") {
    args.push("--upstream", upstream);
    if (funnel) args.push("--funnel");
  } else {
    args.push("--target", target);
    // Go's flag package takes a boolean only as --name=value; "--tls false"
    // would leave --tls true and treat "false" as a stray argument.
    if (!tls) args.push("--tls=false");
  }
  if (controlUrl) args.push("--control-url", controlUrl);
  if (authKey) args.push("--auth-key-stdin");

  const timer = setTimeout(() => {
    if (settled) return;
    fail(
      state.state === "needs-auth"
        ? "This machine was not approved on the tailnet in time. Open the approval link and try again."
        : "The tailnet did not come up in time.",
    );
    void stopChild();
  }, startTimeoutMs);

  if (!existsSync(bin)) {
    clearTimeout(timer);
    fail(`The embedded Tailscale sidecar is missing from this install (expected at ${bin}).`);
    onState(state);
    return { get state() { return state; }, ready, stop: async () => undefined };
  }

  child = spawn(bin, args, {
    env: {
      // Deliberately not `...process.env`: the sidecar needs nothing this
      // process happens to hold, and it must never inherit anything that
      // looks like a credential.
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      // Test harness only: the fake sidecar's chosen client port. It could
      // never have been set before — this env is built from scratch, which
      // is right, but the fixture documented a knob nothing could reach.
      ...(process.env.FAKE_TSNET_CLIENT_PORT ? { FAKE_TSNET_CLIENT_PORT: process.env.FAKE_TSNET_CLIENT_PORT } : {}),
      ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
    },
    stdio: [authKey ? "pipe" : "ignore", "pipe", "pipe"],
  });
  const spawned = child;

  if (authKey) {
    // A child that died between spawn and this write emits `error` on stdin,
    // and an `error` with no listener is an uncaught exception in the main
    // process. The exit handler deals with the death itself.
    spawned.stdin.on("error", () => undefined);
    spawned.stdin.end(`${authKey}\n`);
  }

  createInterface({ input: spawned.stdout }).on("line", (raw) => {
    const line = raw.trim();
    const [keyword, ...rest] = line.split(" ");
    const payload = rest.join(" ");
    switch (keyword) {
      case "AUTH_URL":
        // After the node has come up, a fresh AUTH_URL means its key has
        // expired and the backend is asking again. That has to reach the
        // card — `openAuthUrl` only opens the link in needs-auth — rather
        // than leaving the renderer on "up" with an address that has died.
        setState({ state: "needs-auth", authUrl: payload });
        break;
      case "LISTENING":
        succeed(`http://${payload}`);
        break;
      case "SERVING":
        succeed(payload);
        break;
      case "STATUS": {
        let status = null;
        try {
          status = JSON.parse(payload);
        } catch {
          log(`[tsnet:${mode}] unparseable STATUS line: ${payload}`);
        }
        if (status) setState({ status });
        break;
      }
      default:
        log(`[tsnet:${mode}] ${line}`);
    }
  });

  createInterface({ input: spawned.stderr }).on("line", (line) => {
    stderrTail.push(line);
    if (stderrTail.length > STDERR_TAIL) stderrTail.shift();
    log(`[tsnet:${mode}] ${line}`);
  });

  spawned.on("error", (err) => {
    clearTimeout(timer);
    fail(`The embedded Tailscale sidecar could not start: ${err.message}`);
  });

  spawned.on("exit", (code, signal) => {
    clearTimeout(timer);
    if (child === spawned) child = null;
    if (stopped) {
      setState({ state: "off", authUrl: null, url: null });
      return;
    }
    const why = signal ? `stopped by ${signal}` : `exited with code ${String(code)}`;
    const message = explainExit(stderrTail, why);
    if (settled && state.state === "up") {
      // It came up and then died. Nothing pending to reject; the state is
      // what the renderer will see, and it can offer a retry.
      setState({ state: "error", url: null, error: message });
      return;
    }
    fail(message);
  });

  const stopChild = () =>
    new Promise((resolve) => {
      const current = child;
      if (!current || current.exitCode !== null) {
        resolve();
        return;
      }
      const killTimer = setTimeout(() => { current.kill("SIGKILL"); }, STOP_GRACE_MS);
      current.once("exit", () => {
        clearTimeout(killTimer);
        resolve();
      });
      current.kill("SIGTERM");
    });

  onState(state);

  return {
    get state() {
      return state;
    },
    ready,
    async stop() {
      stopped = true;
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        rejectReady(new Error("stopped"));
      }
      await stopChild();
      setState({ state: "off", authUrl: null, url: null });
    },
  };
}

/**
 * Turns a dead sidecar's stderr into one sentence a person can act on. The
 * sidecar's own fatal lines start with `tsnet-proxy:` and the last of those
 * is the reason; tsnet's own health warnings are the most useful thing
 * before that; otherwise the exit status is all there is.
 */
export function explainExit(stderrTail, why) {
  // The sidecar's own voice, minus the two informational lines it prints on
  // a clean start ("forwarding …", "serving …"): those matched, and since
  // the *last* match wins, a sidecar killed after a clean start reported its
  // forwarding line as the error and threw away `why`.
  const own = stderrTail.filter((l) => /^(?:\S+ \S+ )?tsnet-proxy: (?!\[|forwarding |serving )/.test(l));
  if (own.length > 0) {
    // log.Fatalf prints a timestamp first; drop it, and the prefix.
    return own[own.length - 1].replace(/^(?:\S+ \S+ )?tsnet-proxy: /, "");
  }
  const health = stderrTail.filter((l) => l.includes("health(") && l.includes("error"));
  if (health.length > 0) {
    // `health(warnable=x): error: <reason>` — the reason is the sentence.
    return health[health.length - 1].replace(/^.*?health\([^)]*\): (?:error: )?/, "");
  }
  // Nothing the sidecar said in its own voice. Whatever the shell or the OS
  // said last is the only clue there is — "Permission denied", "not found"
  // — and an exit code alone sends a person to a search engine.
  // Anything the sidecar itself said has been considered above; what is left
  // of its own output is informational and must not be reported as the
  // reason either. Only a line from the shell or the OS counts here.
  const last = [...stderrTail].reverse().find((l) => l.trim() && !l.includes("tsnet-proxy: "));
  return last ? `The embedded Tailscale sidecar ${why}: ${last.trim()}` : `The embedded Tailscale sidecar ${why}.`;
}
