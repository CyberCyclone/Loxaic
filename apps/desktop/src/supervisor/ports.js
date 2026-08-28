import net from "node:net";

/** Ask the OS for a free localhost port. */
export function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => { resolve(port); });
    });
  });
}

/** True if something is accepting connections on host:port. */
export function tcpOpen(host, port, timeoutMs = 1000) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port, timeout: timeoutMs });
    const done = (result) => { socket.destroy(); resolve(result); };
    socket.once("connect", () => { done(true); });
    socket.once("timeout", () => { done(false); });
    socket.once("error", () => { done(false); });
  });
}
