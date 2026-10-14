/**
 * The egress proxy: how a networked sandbox reaches GitHub without the
 * owner's GitHub token ever entering it.
 *
 * Sandboxes are given `HTTPS_PROXY` pointing here with a signed credential
 * (credential.ts, env.ts). For `github.com` and `api.github.com` the proxy
 * terminates TLS with a certificate from its own CA (ca.ts), applies the
 * rules (rules.ts), adds the token, and forwards — so `git clone`, `git push`
 * and `gh` work as the conversation's owner, and only as far as the rules
 * allow. Every other host is tunnelled byte for byte (a networked sandbox can
 * reach it directly anyway), except loopback, link-local and private
 * addresses, which would otherwise reach this server's own services.
 *
 * A second listener in the server process, bound where sandboxes can reach it
 * and nowhere else: loopback on macOS and Windows (Docker Desktop routes
 * `host.docker.internal` there), the Docker bridge's gateway on Linux. Never
 * a public address.
 */
import http, { type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http";
import https from "node:https";
import net, { type Socket } from "node:net";
import tls from "node:tls";
import dns from "node:dns/promises";
import { createGunzip } from "node:zlib";
import type { Duplex } from "node:stream";
import { loadWorkspace } from "../agent/workspace.ts";
import { isBlockedAddress } from "../agent/executor.ts";
import { getOwnerToken, redactToken } from "../github/connection.ts";
import { egressCa } from "./ca.ts";
import { credentialFromHeader, verifyEgressCredential, type EgressIdentity } from "./credential.ts";
import { parseGraphql } from "./graphql.ts";
import {
  checkGraphql,
  checkPush,
  checkRestWrite,
  classifyGitRequest,
  parseReceivePack,
  rejectedPushResponse,
  type EgressScope,
  type Lookups,
  type PullInfo,
  type ReceivePackCommands,
} from "./rules.ts";

/** The hosts the proxy reads and adds the token to. */
export const GITHUB_WEB_HOST = "github.com";
export const GITHUB_API_HOST = "api.github.com";
const INTERCEPTED = new Set([GITHUB_WEB_HOST, GITHUB_API_HOST]);

const MAX_JSON_BODY = 1024 * 1024;

/** Where each intercepted host is really sent — operator and test seams,
 * read at call time. */
function upstreamFor(host: string): URL {
  const base = host === GITHUB_API_HOST ? (process.env.GITHUB_API_URL ?? "https://api.github.com") : (process.env.GITHUB_WEB_URL ?? "https://github.com");
  return new URL(base.endsWith("/") ? base : `${base}/`);
}

// ── Who is asking, and with what ─────────────────────────────

interface Caller {
  identity: EgressIdentity;
  scope: EgressScope;
  token: string | null;
}

const TOKEN_TTL_MS = 30_000;
const tokens = new Map<string, { token: string | null; at: number }>();

/** Forgets an owner's cached token — after they disconnect GitHub. */
export function forgetEgressToken(ownerId: string): void {
  tokens.delete(ownerId);
}

async function tokenFor(ownerId: string): Promise<string | null> {
  const hit = tokens.get(ownerId);
  if (hit && Date.now() - hit.at < TOKEN_TTL_MS) return hit.token;
  const token = await getOwnerToken(ownerId).catch(() => null);
  tokens.set(ownerId, { token, at: Date.now() });
  return token;
}

function identityFor(header: string | undefined): EgressIdentity | null {
  const credential = credentialFromHeader(header);
  return credential ? verifyEgressCredential(credential) : null;
}

/**
 * Who a request is for, resolved per request — never once per connection.
 * `git` and `gh` keep a connection open across many requests, and a caller
 * kept with the socket would outlive a disconnected token, a deleted
 * conversation and a changed workspace for as long as the client held it.
 */
async function callerFor(identity: EgressIdentity | null): Promise<Caller | null> {
  if (!identity) return null;
  const loaded = await loadWorkspace(identity.conversationId).catch(() => null);
  // The conversation must still exist, still be this owner's, and be a
  // GitHub workspace: only those sandboxes are given the proxy
  // (sandbox-manager.ts's egressFor), and a credential is honoured on the same
  // terms it was handed out.
  if (loaded?.ownerId !== identity.ownerId || loaded.workspace.kind !== "github") return null;
  const scope: EgressScope = { repo: loaded.workspace.repo.toLowerCase(), branch: loaded.workspace.branch };
  return { identity, scope, token: await tokenFor(identity.ownerId) };
}

// ── Talking to GitHub ────────────────────────────────────────

const HOP_BY_HOP = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "proxy-connection",
  "te", "trailer", "transfer-encoding", "upgrade", "host", "authorization",
]);

function forwardHeaders(headers: IncomingHttpHeaders, drop: readonly string[] = []): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || HOP_BY_HOP.has(name) || drop.includes(name)) continue;
    out[name] = value;
  }
  return out;
}

function authHeader(host: string, token: string | null): Record<string, string> {
  if (!token) return {};
  // git over HTTPS authenticates with Basic; the API takes the token as such.
  return host === GITHUB_WEB_HOST
    ? { authorization: `Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}` }
    : { authorization: `token ${token}` };
}

/**
 * The upstream URL for an origin-form request path, built so it cannot leave
 * the upstream's origin. The path is the sandbox's to write: resolved with
 * `new URL(path, base)`, an absolute-form target (`https://elsewhere/`) or one
 * the URL parser reads as protocol-relative (`//elsewhere`, `\\elsewhere`)
 * re-bases onto another host, with the owner's token already attached.
 */
export function upstreamTarget(host: string, path: string): URL {
  const base = upstreamFor(host);
  if (!isOriginForm(path)) throw new Error("not an origin-form request target");
  const parsed = new URL(path, "http://upstream.invalid");
  const target = new URL(base.href);
  target.pathname = `${base.pathname.replace(/\/+$/, "")}${parsed.pathname}`;
  target.search = parsed.search;
  if (target.origin !== base.origin) throw new Error("request target left the upstream");
  return target;
}

/** `/path?query` and nothing else: no scheme, no authority, no backslash. */
export function isOriginForm(path: string): boolean {
  return path.startsWith("/") && !path.startsWith("//") && !path.includes("\\");
}

function upstreamRequest(
  host: string,
  method: string,
  path: string,
  headers: Record<string, string | string[]>,
): http.ClientRequest {
  const target = upstreamTarget(host, path);
  const lib = target.protocol === "https:" ? https : http;
  return lib.request(target, { method, headers: { ...headers, host: target.host } });
}

/** A JSON request to the API with the owner's token, for the rules' lookups. */
async function apiJson(caller: Caller, method: string, path: string, body?: unknown): Promise<unknown> {
  return new Promise((resolve) => {
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const req = upstreamRequest(GITHUB_API_HOST, method, path, {
      accept: "application/vnd.github+json",
      "user-agent": "loxaic-egress",
      ...(payload ? { "content-type": "application/json", "content-length": String(payload.length) } : {}),
      ...authHeader(GITHUB_API_HOST, caller.token),
    });
    req.setTimeout(10_000, () => req.destroy());
    req.on("response", (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        if ((res.statusCode ?? 500) >= 300) { resolve(null); return; }
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch {
          resolve(null);
        }
      });
    });
    req.on("error", () => { resolve(null); });
    req.end(payload);
  });
}

const nodeIds = new Map<string, string>();

function lookupsFor(caller: Caller): Lookups {
  const repo = caller.scope.repo;
  const pullOf = (raw: unknown): PullInfo | null => {
    const p = raw as { base?: { repo?: { full_name?: string } }; head?: { ref?: string; repo?: { full_name?: string } } } | null;
    if (!p?.base?.repo?.full_name || !p.head?.ref || !p.head.repo?.full_name) return null;
    return { repo: p.base.repo.full_name.toLowerCase(), headRef: p.head.ref, headRepo: p.head.repo.full_name.toLowerCase() };
  };
  return {
    async pull(number) {
      if (!repo) return null;
      return pullOf(await apiJson(caller, "GET", `/repos/${repo}/pulls/${String(number)}`));
    },
    async repoNodeId() {
      if (!repo) return null;
      const cached = nodeIds.get(repo);
      if (cached) return cached;
      const r = (await apiJson(caller, "GET", `/repos/${repo}`)) as { node_id?: string } | null;
      if (r?.node_id) nodeIds.set(repo, r.node_id);
      return r?.node_id ?? null;
    },
    async node(id) {
      const query =
        "query($id: ID!) { node(id: $id) { __typename ... on PullRequest { headRefName repository { nameWithOwner } headRepository { nameWithOwner } } ... on Issue { repository { nameWithOwner } } } }";
      const r = (await apiJson(caller, "POST", "/graphql", { query, variables: { id } })) as {
        data?: { node?: { __typename?: string; headRefName?: string; repository?: { nameWithOwner?: string }; headRepository?: { nameWithOwner?: string } } | null };
      } | null;
      const n = r?.data?.node;
      if (!n?.__typename) return null;
      const nodeRepo = n.repository?.nameWithOwner?.toLowerCase();
      if (n.__typename === "PullRequest" && nodeRepo && n.headRefName && n.headRepository?.nameWithOwner) {
        return { type: "PullRequest", pull: { repo: nodeRepo, headRef: n.headRefName, headRepo: n.headRepository.nameWithOwner.toLowerCase() } };
      }
      if (n.__typename === "Issue" && nodeRepo) return { type: "Issue", repo: nodeRepo };
      return { type: "other" };
    },
  };
}

// ── Intercepted requests (github.com, api.github.com) ────────

function refuse(res: ServerResponse, status: number, message: string): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8", "x-loxaic-egress": "refused" });
  res.end(`${message}\n`);
}

/**
 * The request body, or null when it is over `max`. Past the cap the rest is
 * read and dropped rather than the request destroyed: destroying it takes the
 * connection down before the refusal can be written, and the client sees a
 * reset instead of the sentence. A body that keeps coming well past the cap is
 * cut off all the same.
 */
function readBody(req: IncomingMessage, max: number): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > max * 8) {
        req.destroy();
        return;
      }
      if (over) return;
      if (size > max) {
        over = true;
        chunks.length = 0;
        resolve(null);
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => { resolve(Buffer.concat(chunks)); });
    req.on("error", () => { resolve(null); });
  });
}

/** Sends a request on with the token, the body given or piped from `req`. */
function forward(
  host: string,
  caller: Caller,
  req: IncomingMessage,
  res: ServerResponse,
  body: { buffer: Buffer } | { head: Buffer; rest: IncomingMessage } | null,
  dropHeaders: readonly string[] = [],
): void {
  const headers = { ...forwardHeaders(req.headers, dropHeaders), ...authHeader(host, caller.token) };
  if (body && "buffer" in body) {
    delete headers["content-length"];
    headers["content-length"] = String(body.buffer.length);
  }
  const up = upstreamRequest(host, req.method ?? "GET", req.url ?? "/", headers);
  up.on("response", (upRes) => {
    res.writeHead(upRes.statusCode ?? 502, forwardHeaders(upRes.headers));
    upRes.pipe(res);
  });
  up.on("error", (err) => {
    refuse(res, 502, `GitHub could not be reached: ${redactToken(err.message, caller.token ?? "")}`);
  });
  if (!body) {
    req.pipe(up);
  } else if ("buffer" in body) {
    up.end(body.buffer);
  } else {
    up.write(body.head);
    body.rest.pipe(up);
  }
}

/** The commands at the start of a push, reading only as far as they go. */
async function readPushHead(req: IncomingMessage): Promise<{ head: Buffer; commands: ReceivePackCommands } | { error: string }> {
  return new Promise((resolve) => {
    let head = Buffer.alloc(0);
    const onData = (c: Buffer) => {
      head = Buffer.concat([head, c]);
      const parsed = parseReceivePack(head);
      if (parsed === null) return;
      req.off("data", onData);
      req.pause();
      resolve("error" in parsed ? { error: parsed.error } : { head, commands: parsed });
    };
    req.on("data", onData);
    req.on("end", () => { resolve({ error: "the push ended before its commands" }); });
  });
}

/**
 * The commands at the start of a gzipped push, inflating only as far as they
 * go. The rules need nothing past the flush, so nothing past it is inflated or
 * buffered: a small gzip body can inflate to gigabytes, and inflating the
 * whole of it in this process would stall every other user's stream, then run
 * out of memory. The bytes read so far are kept as they arrived, still
 * compressed, and forwarded as they are.
 */
async function readGzipPushHead(req: IncomingMessage): Promise<{ head: Buffer; commands: ReceivePackCommands } | { error: string }> {
  return new Promise((resolve) => {
    const raw: Buffer[] = [];
    let inflated = Buffer.alloc(0);
    let settled = false;
    const gunzip = createGunzip();
    const finish = (result: { head: Buffer; commands: ReceivePackCommands } | { error: string }) => {
      if (settled) return;
      settled = true;
      req.off("data", onData);
      req.off("end", onEnd);
      req.pause();
      gunzip.destroy();
      resolve(result);
    };
    const judge = (final: boolean) => {
      const parsed = parseReceivePack(inflated);
      if (parsed === null) {
        if (final) finish({ error: "the push ended before its commands" });
        return;
      }
      finish("error" in parsed ? { error: parsed.error } : { head: Buffer.concat(raw), commands: parsed });
    };
    const onData = (c: Buffer) => {
      raw.push(c);
      gunzip.write(c);
    };
    const onEnd = () => { gunzip.end(); };
    gunzip.on("data", (c: Buffer) => {
      inflated = Buffer.concat([inflated, c]);
      judge(false);
    });
    gunzip.on("end", () => { judge(true); });
    gunzip.on("error", () => { finish({ error: "it is not valid gzip" }); });
    req.on("data", onData);
    req.on("end", onEnd);
  });
}

async function handleGit(caller: Caller, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", `https://${GITHUB_WEB_HOST}`);
  const kind = classifyGitRequest(req.method ?? "GET", url);
  if (kind.kind === "upload-pack" || (kind.kind === "other" && (req.method === "GET" || req.method === "HEAD"))) {
    forward(GITHUB_WEB_HOST, caller, req, res, null);
    return;
  }
  if (kind.kind === "other") {
    refuse(res, 403, "Loxaic lets a sandbox only read github.com pages, clone, fetch and push its own branch.");
    return;
  }
  if (kind.kind === "receive-pack-advert") {
    const verdict = checkPush([], caller.scope, kind.repo);
    if (!verdict.allow) { refuse(res, 403, verdict.reason); return; }
    forward(GITHUB_WEB_HOST, caller, req, res, null);
    return;
  }
  // The push itself: judge its ref updates before any of the pack goes on.
  const encoding = req.headers["content-encoding"];
  if (encoding !== undefined && encoding !== "gzip" && encoding !== "identity") {
    refuse(res, 400, `Loxaic can't read a push sent as ${encoding}.`);
    return;
  }
  const head = encoding === "gzip" ? await readGzipPushHead(req) : await readPushHead(req);
  if ("error" in head) { refuse(res, 400, `This push could not be read (${head.error}).`); return; }
  const verdict = checkPush(head.commands.updates, caller.scope, kind.repo);
  if (!verdict.allow) {
    req.resume();
    sendRejection(res, head.commands, verdict.reason);
    return;
  }
  forward(GITHUB_WEB_HOST, caller, req, res, { head: head.head, rest: req });
  req.resume();
}

function sendRejection(res: ServerResponse, commands: ReceivePackCommands, reason: string): void {
  res.writeHead(200, { "content-type": "application/x-git-receive-pack-result", "cache-control": "no-cache" });
  res.end(rejectedPushResponse(commands, reason));
}

async function handleApi(caller: Caller, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? "GET";
  const url = new URL(req.url ?? "/", `https://${GITHUB_API_HOST}`);
  if (method === "GET" || method === "HEAD") {
    forward(GITHUB_API_HOST, caller, req, res, null);
    return;
  }
  const raw = await readBody(req, MAX_JSON_BODY);
  if (!raw) { refuse(res, 413, "This request is too large for Loxaic to check."); return; }
  let body: unknown = null;
  try {
    body = raw.length ? JSON.parse(raw.toString("utf8")) : null;
  } catch {
    refuse(res, 400, "Loxaic can only check a JSON request body."); return;
  }
  if (method === "POST" && url.pathname.replace(/\/+$/, "") === "/graphql") {
    const requests = Array.isArray(body) ? body : [body];
    for (const one of requests) {
      const q = one as { query?: unknown; variables?: unknown } | null;
      if (typeof q?.query !== "string") { refuse(res, 400, "A GraphQL request needs a query."); return; }
      const ops = parseGraphql(q.query);
      if ("error" in ops) { refuse(res, 400, `Loxaic could not check this GraphQL request (${ops.error}).`); return; }
      const verdict = await checkGraphql(ops, q.variables, caller.scope, lookupsFor(caller));
      if (!verdict.allow) { refuse(res, 403, verdict.reason); return; }
    }
    forward(GITHUB_API_HOST, caller, req, res, { buffer: raw });
    return;
  }
  const verdict = await checkRestWrite(method, url.pathname, body, caller.scope, lookupsFor(caller));
  if (!verdict.allow) { refuse(res, 403, verdict.reason); return; }
  forward(GITHUB_API_HOST, caller, req, res, { buffer: raw });
}

// ── The listener ─────────────────────────────────────────────

/** What an intercepted TLS socket is for: its host, and who opened it. The
 * caller is resolved again for every request on it (`callerFor`). */
const intercepted = new WeakMap<Duplex, { host: string; identity: EgressIdentity }>();

const mitm = http.createServer((req, res) => {
  const meta = intercepted.get(req.socket);
  if (!meta) {
    res.destroy();
    return;
  }
  // Origin-form only: an absolute-form line (`GET https://elsewhere/`) is
  // legal HTTP/1.1, and is how a sandbox would try to send the token
  // somewhere else. upstreamTarget refuses it too; this says why.
  if (!isOriginForm(req.url ?? "")) {
    refuse(res, 400, "Loxaic only forwards requests for a path on this host.");
    return;
  }
  void (async () => {
    const caller = await callerFor(meta.identity);
    if (!caller) {
      refuse(res, 403, "This sandbox's GitHub access has ended: its conversation is gone or no longer this owner's.");
      return;
    }
    const handle = meta.host === GITHUB_API_HOST ? handleApi : handleGit;
    await handle(caller, req, res).catch((err: unknown) => {
      refuse(res, 502, `Loxaic's proxy failed: ${redactToken((err as Error).message, caller.token ?? "")}`);
    });
  })().catch(() => { refuse(res, 502, "Loxaic's proxy failed."); });
});

const PROXY_AUTH_REQUIRED =
  'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="loxaic"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n';

async function publicAddress(host: string): Promise<{ address: string; family: number } | null> {
  const records = await dns.lookup(host, { all: true }).catch(() => []);
  if (records.length === 0) return null;
  return records.some((r) => isBlockedAddress(r.address, r.family)) ? null : records[0];
}

async function onConnect(req: IncomingMessage, client: Socket, head: Buffer): Promise<void> {
  client.on("error", () => client.destroy());
  const identity = identityFor(req.headers["proxy-authorization"]);
  const caller = await callerFor(identity);
  if (!identity || !caller) {
    client.end(PROXY_AUTH_REQUIRED);
    return;
  }
  const [host, portText] = (req.url ?? "").split(/:(?=\d+$)/);
  const port = Number(portText || 443);
  if (INTERCEPTED.has(host.toLowerCase()) && port === 443) {
    client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    const leaf = egressCa().leafFor(host.toLowerCase());
    const secure = new tls.TLSSocket(client, {
      isServer: true,
      secureContext: tls.createSecureContext({ key: leaf.key, cert: leaf.cert }),
      ALPNProtocols: ["http/1.1"],
    });
    if (head.length) secure.unshift(head);
    secure.on("error", () => secure.destroy());
    intercepted.set(secure, { host: host.toLowerCase(), identity });
    mitm.emit("connection", secure);
    return;
  }
  // Anything else is tunnelled as it is — except to an address that would
  // reach this machine's own services rather than the internet.
  const target = await publicAddress(host);
  if (!target || !Number.isInteger(port) || port <= 0 || port > 65_535) {
    client.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
    return;
  }
  const upstream = net.connect({ host: target.address, port, family: target.family });
  upstream.on("connect", () => {
    client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length) upstream.write(head);
    upstream.pipe(client);
    client.pipe(upstream);
  });
  upstream.on("error", () => client.destroy());
  client.on("close", () => upstream.destroy());
}

/** A plain-http request through the proxy (`GET http://host/…`). */
async function onRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const caller = await callerFor(identityFor(req.headers["proxy-authorization"]));
  if (!caller) {
    res.writeHead(407, { "proxy-authenticate": 'Basic realm="loxaic"' });
    res.end();
    return;
  }
  let url: URL;
  try {
    url = new URL(req.url ?? "");
  } catch {
    refuse(res, 400, "Not a proxy request."); return;
  }
  if (url.protocol !== "http:") { refuse(res, 400, "Only http:// requests can be sent this way."); return; }
  if (INTERCEPTED.has(url.hostname)) { refuse(res, 400, `Use https://${url.hostname}.`); return; }
  const target = await publicAddress(url.hostname);
  if (!target) { refuse(res, 403, "Loxaic does not proxy to private or loopback addresses."); return; }
  const up = http.request({
    host: target.address,
    family: target.family,
    port: Number(url.port || 80),
    method: req.method,
    path: `${url.pathname}${url.search}`,
    headers: { ...forwardHeaders(req.headers), host: url.host },
  });
  up.on("response", (upRes) => {
    res.writeHead(upRes.statusCode ?? 502, forwardHeaders(upRes.headers));
    upRes.pipe(res);
  });
  up.on("error", () => { refuse(res, 502, "The host could not be reached."); });
  req.pipe(up);
}

export interface EgressProxy {
  port: number;
  host: string;
  close(): Promise<void>;
}

export function startEgressProxy(opts: { port: number; host: string }): Promise<EgressProxy> {
  const server = http.createServer((req, res) => {
    onRequest(req, res).catch(() => { refuse(res, 502, "Loxaic's proxy failed."); });
  });
  server.on("connect", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    onConnect(req, socket as Socket, head).catch(() => socket.destroy());
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, opts.host, () => {
      const address = server.address() as net.AddressInfo;
      resolve({
        port: address.port,
        host: opts.host,
        close: () =>
          new Promise<void>((done) => {
            server.closeAllConnections();
            server.close(() => { done(); });
          }),
      });
    });
  });
}
