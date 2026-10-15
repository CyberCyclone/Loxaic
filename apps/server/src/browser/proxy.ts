/**
 * The browser's egress proxy (#281) — the only thing in this design that
 * resolves a name or opens an outbound connection on a page's behalf.
 *
 * A browser container is `Internal: true` with no DNS (`--host-resolver-rules`
 * in launch.ts), so it can address exactly two things: another container on its
 * own session network, and this proxy on the bridge gateway. Everything else on
 * the internet happens because a request arrived here and was let go. That makes
 * this file the SSRF boundary for browsing, and it is why the guard is the *same*
 * one `web_fetch` uses (`isBlockedAddress` in agent/executor.ts) rather than a
 * second list that can drift: a page is as hostile as a model-directed URL and
 * better armed, because it can make hundreds of requests and follow its own
 * redirects without ever coming back through our tool layer.
 *
 * Per-hop enforcement is structural rather than a loop we run: every redirect,
 * every subresource, every `fetch()` from page script is a fresh request to this
 * proxy, checked afresh. There is no "first URL checked, rest assumed" window,
 * which is the failure mode a hand-followed redirect loop has when something
 * below it caches a connection.
 *
 * ## Which listener a session gets
 *
 * **Preferred — one listener per session**, bound to that session's own bridge
 * gateway address. The listener *is* the session identity: on an `Internal`
 * network the only thing that can reach that gateway is a container on that
 * network, so a request cannot arrive at the wrong policy, and no credential,
 * token or Origin check is needed (there is nothing to spoof on a network with
 * one browser on it, and nothing to steal because the address is not routable
 * from anywhere else).
 *
 * **Fallback — one shared listener**, used when the gateway address cannot be
 * bound on the host, which is the normal case on Docker Desktop (macOS and
 * Windows) where the gateway lives in a VM. There the session is identified by
 * the **source address** of the incoming connection, matched against the one
 * network's CIDR that contains it, and **a request from an address in no live
 * session's subnet is destroyed rather than served** — fail closed. The
 * isolation that remains is the same structural kind (separate internal network
 * per chat, tmpfs profile, destroy with the conversation); what the fallback
 * mode gives up is the guarantee that no other session can send a request
 * through a socket that has its allowances, since that now depends on a
 * container not spoofing its source address. `mode` on the handle says which one
 * a deployment is in, and the admin view shows it.
 */
import net from "node:net";
import { isIP, isIPv4 } from "node:net";
import { promises as dns } from "node:dns";
import { isBlockedAddress } from "../agent/executor.ts";

/** Longest a tunnel stays open with nothing on it. A page that opened a socket
 * and went away should not hold one; reconnecting is cheap. */
const IDLE_TUNNEL_MS = 5 * 60_000;
/** Longest to wait for a target to answer a new connection. */
const CONNECT_TIMEOUT_MS = 15_000;
/** Header-block ceiling on a proxied request. A browser's CONNECT is a few
 * hundred bytes; a client that streams without ever finishing a header block is
 * holding our memory. */
const MAX_HEADER_BYTES = 64 * 1024;
/** Concurrent tunnels one session may hold. Chromium pools per origin, so a
 * page with many origins multiplies its socket count eagerly; this bounds the
 * server's fd count per user. */
const MAX_TUNNELS_PER_SESSION = 48;

export type ProxyMode = "per-session" | "shared";

export interface SessionEgressPolicy {
  /** When set, a target naming **loopback** is dialed at this address instead,
   * for this session only.
   *
   * This is what makes an agent's own end-to-end test work: the model writes
   * `page.goto("http://localhost:3000")`, the dev server runs in the
   * conversation's *workspace sandbox*, and the browser is a different container
   * where `localhost` is its own loopback. Mapping loopback to the sandbox's
   * address on the shared session network joins them.
   *
   * Only loopback is rewritten — never a name that resolves privately, never a
   * literal private address, both of which stay blocked. Set only on the agent
   * surface, only when this conversation's own sandbox is joined to the session
   * network, and the address comes from the engine (`containerIpOn`), never from
   * the model or a client. */
  loopbackTarget?: string;
  /** Identity a shared-mode listener matches on: the session's network CIDR.
   * Ignored in per-session mode, where the bound address carries it. */
  subnet?: string | null;
}

export interface ProxyHandle {
  /** What the browser is told to proxy through, as a Chromium `--proxy-server`
   * value: an IP:port, so the browser needs no DNS of its own. */
  proxyUrl: string;
  mode: ProxyMode;
  port: number;
}

export type ProxyLog = (message: string) => void;

/** A refusal. The sentence is what the tool hands back to the model: short and
 * uninformative on purpose — a blocked internal address should not report what
 * it found there. */
class Blocked extends Error {}

function refuse(message: string): never {
  throw new Blocked(message);
}

/** Is a request from `source` the one session `subnet` covers? Fail-closed: a
 * source we cannot place belongs to no session. */
export function sourceMatchesSubnet(source: string, subnet: string | null | undefined): boolean {
  if (!subnet || !source) return false;
  const [base, bitsRaw] = subnet.split("/");
  const bits = Number(bitsRaw);
  if (!base || !Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  if (!isIPv4(source) || !isIPv4(base)) return false;
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (ipv4ToLong(source) & mask) >>> 0 === (ipv4ToLong(base) & mask) >>> 0;
}

function ipv4ToLong(value: string): number {
  const parts = value.split(".");
  let out = 0;
  for (const part of parts) out = (out << 8) | (Number(part) & 0xff);
  return out >>> 0;
}

/**
 * Where a request may go: resolve it, and require **every** answer to be public.
 *
 * One private record among several is a refusal, not a choice: a name with both
 * a public and a `127.0.0.1` answer is a rebinding setup, and taking the safe
 * answer would mean the next resolution differs from the one we checked.
 */
async function resolveTarget(host: string): Promise<string> {
  const literal = isIP(host);
  if (literal !== 0) {
    if (isBlockedAddress(host, literal)) refuse("That address is not reachable from here.");
    return host;
  }
  let records: { address: string; family: number }[];
  try {
    records = await dns.lookup(host, { all: true, verbatim: true });
  } catch {
    refuse("That host does not resolve.");
  }
  if (records.length === 0) refuse("That host does not resolve.");
  for (const record of records) {
    if (isBlockedAddress(record.address, record.family === 6 ? 6 : 4)) {
      refuse("That host resolves to a private address, which browsing will not reach.");
    }
  }
  return records[0].address;
}

/** The host:port a CONNECT is aimed at. */
export function parseAuthority(authority: string, defaultPort: number): { host: string; port: number } {
  const trimmed = authority.trim();
  if (!trimmed) refuse("No target.");
  if (trimmed.startsWith("[")) {
    const end = trimmed.indexOf("]");
    if (end < 0) refuse("Malformed address.");
    const host = trimmed.slice(1, end);
    const rest = trimmed.slice(end + 1);
    const port = rest.startsWith(":") ? Number(rest.slice(1)) : defaultPort;
    assertPort(port);
    return { host, port };
  }
  const colon = trimmed.lastIndexOf(":");
  const maybePort = colon >= 0 ? trimmed.slice(colon + 1) : "";
  if (maybePort && !/^\d+$/.test(maybePort)) refuse("Malformed port.");
  const host = colon >= 0 ? trimmed.slice(0, colon) : trimmed;
  // A bare host containing a colon is not a hostname: an IPv6 literal has to be
  // bracketed, and `a:b:8443` would otherwise be read as host `a:b`.
  if (host.includes(":")) refuse("Malformed address.");
  const port = maybePort ? Number(maybePort) : defaultPort;
  assertPort(port);
  return { host, port };
}

function assertPort(port: number): void {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) refuse("Malformed port.");
}

/** Where an absolute-URI request line is aimed, or null for an origin-form one
 * (a client that is not talking to a proxy; guessing a host for it would send an
 * unchecked request). */
export function parseAbsoluteTarget(
  raw: string,
): { host: string; port: number; path: string; secure: boolean } | null {
  // A scheme we can name but not serve is a refusal with a sentence worth
  // showing, not a null: null means "this is not a proxied request at all", and
  // `ftp://…` is a request whose scheme the model should be told about.
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//.exec(raw)?.[1]?.toLowerCase();
  if (scheme !== undefined && scheme !== "http" && scheme !== "https") {
    refuse(`only http and https can be browsed (got ${scheme}://)`);
  }
  if (scheme === undefined) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    refuse("Malformed URL.");
  }
  const secure = url.protocol === "https:";
  const port = url.port ? Number(url.port) : secure ? 443 : 80;
  assertPort(port);
  return { host: url.hostname, port, path: `${url.pathname}${url.search}` || "/", secure };
}

/**
 * The session's loopback rewrite. Returns what to dial plus the `Host` value to
 * preserve, which stays the **original** name so TLS SNI, virtual hosts and
 * cookies still behave: only the address we dial changes, never the identity the
 * request carries.
 */
export function rewriteLoopback(
  host: string,
  policy: SessionEgressPolicy,
): { dialHost: string; rewritten: boolean } {
  // Chromium lowercases a hostname before it reaches a proxy, but the guard does
  // not depend on that: `LOCALHOST` and `127.0.0.1` must be the same target.
  const name = host.toLowerCase();
  if (!policy.loopbackTarget) return { dialHost: name, rewritten: false };
  const loopback =
    name === "localhost" ||
    name.endsWith(".localhost") ||
    name === "::1" ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(name);
  return loopback ? { dialHost: policy.loopbackTarget, rewritten: true } : { dialHost: name, rewritten: false };
}

/**
 * Decides the destination of one request: rewrite, then guard.
 *
 * The whole SSRF decision for browsing is these lines, on both methods' paths,
 * which is what makes "could a page have reached 169.254.169.254?" a question
 * with one answer. A rewritten loopback target is the single private address
 * ever allowed, and it is only ever the engine-reported address of *this
 * conversation's own* sandbox container.
 *
 * A non-literal host is returned unresolved; `dial` resolves and checks it, so
 * no caller can forget that a name still needs the guard.
 */
export function decideTarget(host: string, port: number, policy: SessionEgressPolicy): { host: string; port: number } {
  const { dialHost, rewritten } = rewriteLoopback(host, policy);
  // The *name* `localhost` is refused without waiting for a resolution. Left to
  // DNS it would usually be caught anyway (127.0.0.1 is blocked), but "usually"
  // is a dependency on this machine's resolver: an `/etc/hosts` entry or a
  // resolver that answers a public address for it would make the guard depend on
  // configuration rather than on the policy.
  if (!rewritten && (dialHost === "localhost" || dialHost.endsWith(".localhost"))) {
    refuse("That address is not reachable from here.");
  }
  const family = isIP(dialHost);
  if (family !== 0 && !rewritten && isBlockedAddress(dialHost, family)) {
    refuse("That address is not reachable from here.");
  }
  return { host: dialHost, port };
}

async function dial(target: { host: string; port: number }): Promise<net.Socket> {
  const address = isIP(target.host) ? target.host : await resolveTarget(target.host);
  return await new Promise<net.Socket>((resolve, reject) => {
    const socket = net.connect({ host: address, port: target.port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("timed out"));
    }, CONNECT_TIMEOUT_MS);
    socket.once("connect", () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function writeSimple(client: net.Socket, status: number, reason: string): void {
  client.write(`HTTP/1.1 ${String(status)} ${sanitizeHeader(reason)}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
}

/** A header value can carry anything a page put in a hostname; strip what would
 * let one inject a second response line into our own 502. */
export function sanitizeHeader(value: string): string {
  return value.replace(/[\r\n]/g, "").slice(0, 200);
}

/**
 * One accepted client connection, handled against one session's policy.
 *
 * Exported for the same reason the decision functions are: it is testable
 * against a real loopback origin server without any container.
 */
export function handleProxiedClient(client: net.Socket, policy: SessionEgressPolicy, log: ProxyLog): void {
  client.setTimeout(0);
  let buffer = Buffer.alloc(0);
  const onData = (chunk: Buffer): void => {
    buffer = Buffer.concat([buffer, chunk]);
    if (buffer.length > MAX_HEADER_BYTES) {
      writeSimple(client, 431, "Request header too large.");
      client.destroy();
      return;
    }
    const end = buffer.indexOf("\r\n\r\n");
    if (end < 0) return;
    client.off("data", onData);
    void dispatch(client, buffer.subarray(0, end).toString("latin1"), buffer.subarray(end + 4), policy, log);
  };
  client.on("data", onData);
  client.once("error", () => client.destroy());
}

async function dispatch(
  client: net.Socket,
  headerBlock: string,
  rest: Buffer,
  policy: SessionEgressPolicy,
  log: ProxyLog,
): Promise<void> {
  const [requestLine = "", ...headerLines] = headerBlock.split("\r\n");
  const [methodRaw = "", targetRaw = ""] = requestLine.split(/\s+/);
  const method = methodRaw.toUpperCase();

  let target: { host: string; port: number; path?: string };
  if (method === "CONNECT") {
    target = parseAuthority(targetRaw, 443);
  } else {
    let absolute: ReturnType<typeof parseAbsoluteTarget>;
    try {
      absolute = parseAbsoluteTarget(targetRaw);
    } catch (err) {
      writeSimple(client, 400, err instanceof Blocked ? err.message : "Malformed request.");
      client.destroy();
      return;
    }
    if (!absolute) {
      writeSimple(client, 400, "Expected an absolute URL.");
      client.destroy();
      return;
    }
    // A plain proxied request is never TLS; the port is the destination port.
    target = { host: absolute.host, port: absolute.port, path: absolute.path };
  }

  let decided: { host: string; port: number };
  try {
    decided = decideTarget(target.host, target.port, policy);
  } catch (err) {
    writeSimple(client, 403, err instanceof Blocked ? err.message : "Refused.");
    client.destroy();
    return;
  }

  let upstream: net.Socket;
  try {
    upstream = await dial(decided);
  } catch (err) {
    const reason = err instanceof Blocked ? err.message : "The site could not be reached.";
    if (method === "CONNECT") {
      client.write(`HTTP/1.1 502 Bad Gateway\r\nX-Loxaic-Reason: ${sanitizeHeader(reason)}\r\nConnection: close\r\n\r\n`);
    } else {
      writeSimple(client, 502, reason);
    }
    client.destroy();
    return;
  }

  if (method === "CONNECT") {
    // No TLS interception. The egress proxy terminates TLS because it must read
    // a request and add a token; here there is nothing to add and nothing to
    // read — the decision is *where*, and the CONNECT authority says it.
    // Intercepting would mean a CA the browser trusts and the ability to read a
    // person's logged-in session on every site they browse from their own chat.
    client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (rest.length > 0) upstream.write(rest);
  } else {
    const kept = headerLines.filter((line) => !/^(connection|proxy-connection|host):/i.test(line));
    const request = [
      `${method} ${target.path ?? "/"} HTTP/1.1`,
      // The *original* host, so a virtual-hosted origin and its cookies behave
      // as they would without us in the middle.
      `Host: ${target.host}:${String(target.port)}`,
      ...kept,
      "Connection: keep-alive",
      "",
      "",
    ].join("\r\n");
    upstream.write(request);
    if (rest.length > 0) upstream.write(rest);
  }

  track(client);
  track(upstream);
  client.pipe(upstream);
  upstream.pipe(client);
  log(`browser → ${target.host}:${String(target.port)}`);
}

function track(socket: net.Socket): void {
  socket.setTimeout(IDLE_TUNNEL_MS);
  socket.once("timeout", () => socket.destroy());
  socket.once("error", () => socket.destroy());
  socket.once("close", () => socket.destroy());
}

/**
 * The proxy: a per-session listener where the engine allows it, one shared
 * listener otherwise. See the module docblock for what each mode guarantees.
 */
export class BrowserProxy {
  private readonly byGateway = new Map<string, net.Server>();
  /** Per-session mode: where a session's live policy lives, so `setPolicy` can
   * change what an already-bound listener decides without rebinding it. */
  private readonly policies = new Map<string, { set: (policy: SessionEgressPolicy) => void; subnet: string | null }>();
  private shared: net.Server | null = null;
  private sharedPort = 0;
  /** Shared mode only: the live sessions a source address is matched against. */
  private readonly sessions = new Map<string, SessionEgressPolicy & { subnet: string | null }>();
  private readonly tunnelCounts = new Map<string, number>();

  constructor(private readonly log: ProxyLog = () => undefined) {}

  /**
   * Gives a session its proxy. `gateway` is the session network's gateway (how
   * a container reaches this host); `subnet` is that network's CIDR, needed only
   * if the gateway turns out not to be bindable here.
   */
  async attach(gateway: string, subnet: string | null, policy: SessionEgressPolicy = {}): Promise<ProxyHandle> {
    // A mutable holder so the handler can exist *before* the socket does: a
    // connection that arrives between `listen()` and attaching a handler would
    // otherwise sit unread.
    let current = policy;
    const dedicated = await this.listenOn(gateway, () => current);
    if (dedicated) {
      this.byGateway.set(gateway, dedicated);
      const port = portOf(dedicated);
      const handle: ProxyHandle = { proxyUrl: `http://${gateway}:${String(port)}`, mode: "per-session", port };
      // The policy is per-listener in this mode: nothing else can be served by
      // this socket, so it needs no identity of its own.
      this.policies.set(gateway, {
        set: (next) => {
          current = next;
        },
        subnet,
      });
      return handle;
    }
    // Fallback: one listener, sessions told apart by source address.
    const server = await this.ensureShared();
    this.sessions.set(gateway, { ...policy, subnet });
    return { proxyUrl: `http://${gateway}:${String(this.sharedPort)}`, mode: "shared", port: this.sharedPort };
  }

  /** Updates a live session's policy — the agent surface attaches the
   * workspace sandbox's address after the browser may already be running. */
  setPolicy(gateway: string, policy: SessionEgressPolicy): void {
    const dedicated = this.policies.get(gateway);
    if (dedicated) {
      dedicated.set(policy);
      return;
    }
    const existing = this.sessions.get(gateway);
    if (existing) this.sessions.set(gateway, { ...existing, ...policy });
  }

  detach(gateway: string): void {
    const dedicated = this.byGateway.get(gateway);
    if (dedicated) {
      this.byGateway.delete(gateway);
      this.policies.delete(gateway);
      dedicated.close();
      for (const socket of socketsOf(dedicated)) socket.destroy();
      return;
    }
    this.sessions.delete(gateway);
  }

  /** Live sessions, for the admin status view and shutdown. */
  live(): { gateway: string; mode: ProxyMode }[] {
    const dedicated = [...this.byGateway.keys()].map((gateway) => ({ gateway, mode: "per-session" as const }));
    const shared = [...this.sessions.keys()].map((gateway) => ({ gateway, mode: "shared" as const }));
    return [...dedicated, ...shared];
  }

  detachAll(): void {
    for (const gateway of [...this.byGateway.keys()]) this.detach(gateway);
    this.sessions.clear();
    this.shared?.close();
    this.shared = null;
  }

  /** Binds `address` exclusively with its handler already attached, or returns
   * null when the host has no such address to bind (Docker Desktop's gateway
   * lives in a VM, so binding it fails with EADDRNOTAVAIL). */
  private async listenOn(address: string, policyFor: () => SessionEgressPolicy): Promise<net.Server | null> {
    const server = net.createServer();
    server.on("connection", (client) => this.accept(client, policyFor(), address));
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (err: Error): void => reject(err);
        server.once("error", onError);
        server.listen({ host: address, port: 0, exclusive: true }, () => {
          server.off("error", onError);
          resolve();
        });
      });
      return server;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      server.close();
      // EADDRNOTAVAIL: not one of our addresses. EACCES/EPERM: not ours to bind.
      // Anything else is a real failure and must not silently downgrade mode.
      if (code === "EADDRNOTAVAIL" || code === "EACCES" || code === "EPERM") return null;
      throw err;
    }
  }

  private async ensureShared(): Promise<net.Server> {
    if (this.shared) return this.shared;
    const server = net.createServer();
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error): void => reject(err);
      server.once("error", onError);
      // Bound on all interfaces *of this process's network namespace*: the only
      // thing that can reach it from a container is the bridge gateway, and the
      // source-address check decides which session (if any) it belongs to.
      server.listen({ host: "0.0.0.0", port: 0 }, () => {
        server.off("error", onError);
        resolve();
      });
    });
    this.shared = server;
    this.sharedPort = portOf(server);
    server.on("connection", (client) => {
      const source = client.remoteAddress ?? "";
      const session = this.sessionFor(source);
      if (!session) {
        // Fail closed: a source in no live session's subnet gets nothing.
        this.log(`browser proxy: request from ${source || "unknown"} belongs to no session`);
        client.destroy();
        return;
      }
      this.accept(client, session, source);
    });
    return server;
  }

  private sessionFor(source: string): SessionEgressPolicy | null {
    // A host-side connection (a test, a health check) has a loopback source and
    // belongs to no browser session; it is refused along with everything else
    // that cannot be placed.
    for (const session of this.sessions.values()) {
      if (sourceMatchesSubnet(normalizeSource(source), session.subnet)) return session;
    }
    return null;
  }

  private accept(client: net.Socket, policy: SessionEgressPolicy, key: string): void {
    const used = this.tunnelCounts.get(key) ?? 0;
    if (used >= MAX_TUNNELS_PER_SESSION) {
      this.log(`browser session ${key} hit its connection cap`);
      client.write("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
      client.destroy();
      return;
    }
    this.tunnelCounts.set(key, used + 1);
    client.once("close", () => {
      const now = this.tunnelCounts.get(key) ?? 0;
      if (now <= 1) this.tunnelCounts.delete(key);
      else this.tunnelCounts.set(key, now - 1);
    });
    handleProxiedClient(client, policy, this.log);
  }
}

/** `::ffff:172.20.0.2` → `172.20.0.2`: the address as the subnet math wants it. */
export function normalizeSource(source: string): string {
  if (source.startsWith("::ffff:")) return source.slice(7);
  return source;
}

function portOf(server: net.Server): number {
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("proxy did not bind a TCP port");
  return address.port;
}

/** Sockets currently attached to a server, for a hard teardown. */
function socketsOf(server: net.Server): net.Socket[] {
  const out: net.Socket[] = [];
  // `forEachConnection` exists on net.Server (Node 19+); the cast keeps the
  // type honest without pulling in a newer lib than the repo targets.
  const each = (server as unknown as { forEachConnection?: (fn: (c: net.Socket) => void) => void }).forEachConnection;
  each?.call(server, (connection) => out.push(connection));
  return out;
}

