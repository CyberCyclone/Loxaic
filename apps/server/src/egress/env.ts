/**
 * What a sandbox is given to reach GitHub through the egress proxy
 * (proxy.ts): the proxy address with its signed credential, and trust in the
 * proxy's CA — never the GitHub token.
 *
 * Given per command, by wrapping the handle (`withEgress`), not baked into
 * the container: a paused container resumes with the environment it was
 * created with, and the proxy's port can change between server starts. The
 * same wrapper is what the agent's tools, the Inspector's git routes and the
 * terminal panel go through, so all three reach GitHub the same way.
 *
 * Containers reach the proxy at the address boot.ts chose for them (the
 * Docker bridge gateway on Linux, `host.docker.internal` elsewhere;
 * EGRESS_PROXY_HOST overrides both); a host-mode sandbox at the proxy's own
 * loopback address. A local
 * workspace's executor is left alone: on someone's own machine the agent uses
 * their own git and gh login.
 */
import type { SandboxHandle, TerminalSession } from "../sandbox/provider.ts";
import { egressCa } from "./ca.ts";
import { signEgressCredential, type EgressIdentity } from "./credential.ts";

/** A placeholder `gh` sends as its token; the proxy replaces it. `gh` refuses
 * to run without one. */
export const GH_PLACEHOLDER_TOKEN = "loxaic-egress-proxy";

export interface RunningEgressProxy {
  port: number;
  /** An address the proxy listens on that this machine reaches it by — what
   * a host-mode sandbox is given. */
  bind: string;
  /** What a container is given instead, when boot.ts knows better than
   * `host.docker.internal`. */
  containerHost?: string;
}

let running: RunningEgressProxy | null = null;

/** Recorded by the server once the proxy is listening (boot.ts). */
export function setRunningEgressProxy(proxy: RunningEgressProxy | null): void {
  running = proxy;
}

export function runningEgressProxy(): RunningEgressProxy | null {
  return running;
}

function proxyHostFor(kind: SandboxHandle["provider"], proxy: RunningEgressProxy): string {
  if (kind === "host") return proxy.bind === "0.0.0.0" ? "127.0.0.1" : proxy.bind;
  // An empty variable is unset, as for every other address setting.
  const pinned = process.env.EGRESS_PROXY_HOST;
  if (pinned) return pinned;
  return proxy.containerHost ?? "host.docker.internal";
}

const caPaths = (root: string) => ({
  dir: `${root.replace(/\/+$/, "")}/.loxaic`,
  bundle: `${root.replace(/\/+$/, "")}/.loxaic/ca-bundle.pem`,
  ca: `${root.replace(/\/+$/, "")}/.loxaic/egress-ca.pem`,
});

/** Sandboxes whose CA files are written, keyed by ref and CA. */
const prepared = new Map<string, Promise<string | null>>();

/**
 * The proxy is running and this sandbox is meant to reach GitHub through it,
 * but the proxy's CA could not be written into it. Never answered with an
 * empty environment: git would then reach github.com without a credential and
 * report a private repository as not found, which reads as a problem with the
 * person's token.
 */
export class EgressCaError extends Error {
  constructor(reason: string) {
    super(
      `Loxaic could not put its GitHub certificate into this workspace (${reason}), ` +
        "so git and gh cannot reach GitHub through Loxaic from it.",
    );
    this.name = "EgressCaError";
  }
}

/** Writes the proxy's CA, and a bundle of the system's roots plus it, into
 * the sandbox. Once per sandbox per CA; null when done, else why not. A
 * failure is not kept, so the next command tries again. */
function prepareCa(handle: SandboxHandle, certPem: string): Promise<string | null> {
  const key = `${handle.ref}\0${String(certPem.length)}\0${certPem.slice(-64)}`;
  let p = prepared.get(key);
  if (!p) {
    const paths = caPaths(handle.root);
    const script =
      `mkdir -p "${paths.dir}" && ` +
      `{ cat /etc/ssl/certs/ca-certificates.crt 2>/dev/null || cat /etc/ssl/cert.pem 2>/dev/null || true; printf '%s\\n' "$LOXAIC_EGRESS_CA"; } > "${paths.bundle}" && ` +
      `printf '%s\\n' "$LOXAIC_EGRESS_CA" > "${paths.ca}"`;
    p = handle
      .exec(["sh", "-c", script], { env: { LOXAIC_EGRESS_CA: certPem.trim() }, workdir: handle.root })
      .then((r) => (r.exitCode === 0 ? null : (r.stderr.trim().split("\n").at(-1) ?? "") || `exit ${String(r.exitCode)}`))
      .catch((err: unknown) => (err instanceof Error ? err.message : String(err)));
    void p.then((failed) => { if (failed !== null) prepared.delete(key); });
    prepared.set(key, p);
  }
  return p;
}

/**
 * The environment that routes this sandbox's GitHub traffic through the
 * proxy. Empty when the proxy is not running, or for a local workspace — and
 * then git and gh simply reach GitHub (or fail to) as they would anyway.
 * Throws `EgressCaError` when the CA could not be written.
 */
export async function egressEnv(handle: SandboxHandle, identity: EgressIdentity): Promise<Record<string, string>> {
  if (!running || handle.provider === "executor") return {};
  const certPem = egressCa().certPem;
  const failed = await prepareCa(handle, certPem);
  if (failed !== null) throw new EgressCaError(failed);
  const credential = signEgressCredential(identity);
  const proxyUrl = `http://sbx:${credential}@${proxyHostFor(handle.provider, running)}:${String(running.port)}`;
  const paths = caPaths(handle.root);
  return {
    HTTPS_PROXY: proxyUrl,
    https_proxy: proxyUrl,
    HTTP_PROXY: proxyUrl,
    http_proxy: proxyUrl,
    NO_PROXY: "localhost,127.0.0.1,::1",
    no_proxy: "localhost,127.0.0.1,::1",
    SSL_CERT_FILE: paths.bundle,
    GIT_SSL_CAINFO: paths.bundle,
    CURL_CA_BUNDLE: paths.bundle,
    REQUESTS_CA_BUNDLE: paths.bundle,
    NODE_EXTRA_CA_CERTS: paths.ca,
    GH_TOKEN: GH_PLACEHOLDER_TOKEN,
    GH_PROMPT_DISABLED: "1",
    GH_NO_UPDATE_NOTIFIER: "1",
    GIT_TERMINAL_PROMPT: "0",
  };
}

/**
 * The handle, with every command and terminal given `egressEnv`. A caller's
 * own environment wins over it, key by key.
 */
export function withEgress(handle: SandboxHandle, identity: EgressIdentity): SandboxHandle {
  if (handle.provider === "executor") return handle;
  return new Proxy(handle, {
    get(target, prop, receiver) {
      if (prop === "exec") {
        const exec: SandboxHandle["exec"] = async (command, options) => {
          let env: Record<string, string>;
          try {
            env = await egressEnv(target, identity);
          } catch (err) {
            if (!(err instanceof EgressCaError)) throw err;
            // The command still runs: most have nothing to do with GitHub.
            // One that fails is told what is missing, rather than left to
            // GitHub's own words about a repository it could not see.
            const result = await target.exec(command, options);
            if (result.exitCode === 0) return result;
            return { ...result, stderr: `${result.stderr}${result.stderr.endsWith("\n") || !result.stderr ? "" : "\n"}[Loxaic] ${err.message}\n` };
          }
          return target.exec(command, { ...options, env: { ...env, ...options?.env } });
        };
        return exec;
      }
      if (prop === "openTerminal" && target.openTerminal) {
        const original = target.openTerminal.bind(target);
        const open = async (options?: { env?: Record<string, string> }): Promise<TerminalSession> => {
          // A shell opens either way; without the CA it simply has no GitHub
          // through Loxaic, as a command run from it would be told.
          const env = await egressEnv(target, identity).catch((err: unknown) => {
            if (err instanceof EgressCaError) return {};
            throw err;
          });
          return original({ env: { ...env, ...options?.env } });
        };
        return open;
      }
      const value: unknown = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}

/** Test seam. */
export function __forgetPreparedCaForTest(): void {
  prepared.clear();
}
