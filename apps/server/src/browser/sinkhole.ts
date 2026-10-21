/**
 * Where the browser's own network goes: nowhere.
 *
 * Every Chromium the fallback launches is pointed at this listener as its
 * proxy, with the loopback bypass removed, and this listener destroys every
 * connection it accepts. Requests the interception answers (intercept.ts) never
 * reach a proxy at all; anything else Chromium tries on its own fails here
 * instead of going out from the server's host unchecked. One per process,
 * owned by the server, so nothing else can be listening on the port.
 */
import net from "node:net";

let listening: Promise<number> | null = null;
let server: net.Server | null = null;
let hits = 0;

export function sinkholePort(): Promise<number> {
  if (listening) return listening;
  const promise = new Promise<number>((resolve, reject) => {
    const s = net.createServer((socket) => {
      hits++;
      socket.destroy();
    });
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      server = s;
      s.unref();
      resolve((s.address() as net.AddressInfo).port);
    });
  });
  listening = promise;
  promise.catch(() => {
    if (listening === promise) listening = null;
  });
  return promise;
}

/** Connections the sinkhole has refused, for tests that prove a path escaped
 * interception and died here. */
export function sinkholeHits(): number {
  return hits;
}

export async function closeSinkhole(): Promise<void> {
  const s = server;
  server = null;
  listening = null;
  if (s) await new Promise<void>((resolve) => s.close(() => { resolve(); }));
}
