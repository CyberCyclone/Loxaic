/**
 * A smart-HTTP git server for tests: `git http-backend` run as CGI behind a
 * plain Node listener, serving the bare repositories under `root` — what
 * `github.com` looks like to `git clone` and `git push`.
 *
 * It requires the Basic credential a real GitHub would want
 * (`x-access-token:<token>`), and records every Authorization it saw, so a
 * test can prove the egress proxy added the owner's token — and that nothing
 * else did.
 */
import http from "node:http";
import { spawn } from "node:child_process";
import type { AddressInfo } from "node:net";

export interface GitHttpServer {
  url: string;
  /** Every Authorization header received, in order. */
  authorizations: (string | undefined)[];
  close(): Promise<void>;
}

export function startGitHttpServer(opts: { root: string; token: string; host?: string; port?: number }): Promise<GitHttpServer> {
  const authorizations: (string | undefined)[] = [];
  const expected = `Basic ${Buffer.from(`x-access-token:${opts.token}`).toString("base64")}`;
  const server = http.createServer((req, res) => {
    authorizations.push(req.headers.authorization);
    if (req.headers.authorization !== expected) {
      res.writeHead(401, { "www-authenticate": 'Basic realm="test"' });
      res.end("bad credentials\n");
      return;
    }
    const url = new URL(req.url ?? "/", "http://git.test");
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      GIT_PROJECT_ROOT: opts.root,
      GIT_HTTP_EXPORT_ALL: "1",
      // http-backend only offers receive-pack to an authenticated user.
      REMOTE_USER: "x-access-token",
      REQUEST_METHOD: req.method ?? "GET",
      PATH_INFO: decodeURIComponent(url.pathname),
      QUERY_STRING: url.search.replace(/^\?/, ""),
      CONTENT_TYPE: req.headers["content-type"] ?? "",
      ...(req.headers["content-length"] ? { CONTENT_LENGTH: req.headers["content-length"] } : {}),
      ...(req.headers["content-encoding"] ? { HTTP_CONTENT_ENCODING: req.headers["content-encoding"] } : {}),
      ...(req.headers["git-protocol"] ? { GIT_PROTOCOL: req.headers["git-protocol"] as string } : {}),
    };
    const cgi = spawn("git", ["-c", "http.receivepack=true", "http-backend"], { env });
    req.pipe(cgi.stdin);
    let headerBuf = Buffer.alloc(0);
    let headersDone = false;
    cgi.stdout.on("data", (chunk: Buffer) => {
      if (headersDone) {
        res.write(chunk);
        return;
      }
      headerBuf = Buffer.concat([headerBuf, chunk]);
      const sep = headerBuf.indexOf("\r\n\r\n");
      if (sep === -1) return;
      headersDone = true;
      let status = 200;
      const headers: Record<string, string> = {};
      for (const line of headerBuf.subarray(0, sep).toString("utf8").split("\r\n")) {
        const colon = line.indexOf(":");
        if (colon === -1) continue;
        const name = line.slice(0, colon).trim();
        const value = line.slice(colon + 1).trim();
        if (name.toLowerCase() === "status") status = Number(value.split(" ")[0]);
        else headers[name] = value;
      }
      res.writeHead(status, headers);
      res.write(headerBuf.subarray(sep + 4));
    });
    cgi.on("close", () => res.end());
    cgi.on("error", () => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  return new Promise((resolve) => {
    server.listen(opts.port ?? 0, opts.host ?? "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://${opts.host ?? "127.0.0.1"}:${String(port)}`,
        authorizations,
        close: () => new Promise<void>((done) => {
          server.closeAllConnections();
          server.close(() => { done(); });
        }),
      });
    });
  });
}
