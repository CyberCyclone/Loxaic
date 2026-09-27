/**
 * Stand-ins for what `pnpm dev` starts beside the desktop app: the dev server
 * and Metro, each on a port of the run's own — the real :4000 and :8081 belong
 * to whoever is running the suite, and are very likely in use.
 *
 * Both forward to the run's real server (`BASE_URL`), which serves the API and
 * the web export same-origin, so the app they lead to is the real one.
 *
 * - The dev server stand-in refuses `/health` for its first few seconds of
 *   being asked, counted from the first probe — so it is exactly as late as a
 *   `tsx` server still booting under turbo, measured from the app's launch,
 *   whatever the machine's speed. That is the race the desktop used to lose.
 * - The Metro stand-in answers `/status` as Metro does and forwards the rest,
 *   and the spec starts and stops it on the same port, which is what Metro
 *   coming up late, or restarting, looks like to the app.
 */
import http from 'node:http';
import net from 'node:net';

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => { resolve(port); });
    });
  });
}

/** Forwards one request to `target`, streaming both ways. */
function forward(req: http.IncomingMessage, res: http.ServerResponse, target: string): void {
  const url = new URL(req.url ?? '/', target);
  const upstream = http.request(
    url,
    { method: req.method, headers: { ...req.headers, host: url.host } },
    (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res);
    },
  );
  upstream.on('error', () => {
    if (!res.headersSent) res.writeHead(502);
    res.end();
  });
  req.pipe(upstream);
}

function listen(server: http.Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => { resolve(); });
  });
}

function close(server: http.Server): Promise<void> {
  return new Promise((resolve) => {
    server.closeAllConnections();
    server.close(() => { resolve(); });
  });
}

export interface DevServerStandIn {
  url: string;
  /** How many /health probes were refused before it started answering. */
  refusedProbes: () => number;
  stop: () => Promise<void>;
}

export async function startDevServerStandIn(
  target: string,
  port: number,
  lateByMs: number,
): Promise<DevServerStandIn> {
  let firstProbeAt: number | null = null;
  let refused = 0;
  const server = http.createServer((req, res) => {
    if (req.url === '/health') {
      firstProbeAt ??= Date.now();
      if (Date.now() - firstProbeAt < lateByMs) {
        refused++;
        res.writeHead(503).end('still starting');
        return;
      }
    }
    forward(req, res, target);
  });
  await listen(server, port);
  return { url: `http://127.0.0.1:${String(port)}`, refusedProbes: () => refused, stop: () => close(server) };
}

export interface MetroStandIn {
  url: string;
  start: () => Promise<void>;
  stop: () => Promise<void>;
}

export function metroStandIn(target: string, port: number): MetroStandIn {
  let server: http.Server | null = null;
  return {
    url: `http://127.0.0.1:${String(port)}`,
    async start() {
      if (server) return;
      server = http.createServer((req, res) => {
        if (req.url === '/status') {
          res.writeHead(200, { 'content-type': 'text/plain' }).end('packager-status:running');
          return;
        }
        forward(req, res, target);
      });
      await listen(server, port);
    },
    async stop() {
      if (!server) return;
      const s = server;
      server = null;
      await close(s);
    },
  };
}
