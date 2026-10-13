import { afterEach, describe, expect, it } from "vitest";
import net from "node:net";
import { bootEgressProxy } from "../boot.ts";
import { runningEgressProxy, setRunningEgressProxy } from "../env.ts";
import type { EgressProxy } from "../proxy.ts";

process.env.MCP_ENCRYPTION_KEY ??= "egress-boot-test-key";

let started: EgressProxy[] = [];

afterEach(async () => {
  await Promise.all(started.map((p) => p.close()));
  started = [];
  setRunningEgressProxy(null);
  Reflect.deleteProperty(process.env, "EGRESS_PROXY_BIND");
  Reflect.deleteProperty(process.env, "EGRESS_PROXY_PORT");
});

const free = () =>
  new Promise<number>((resolve) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => { resolve(port); });
    });
  });

describe("bootEgressProxy", () => {
  it("listens on every address on one port, and records the first for host sandboxes", async () => {
    process.env.EGRESS_PROXY_BIND = "127.0.0.1, ::1";
    const lines: string[] = [];
    started = await bootEgressProxy((m) => lines.push(m));
    expect(started.map((p) => p.host)).toEqual(["127.0.0.1", "::1"]);
    expect(new Set(started.map((p) => p.port)).size).toBe(1);
    expect(runningEgressProxy()).toEqual({ port: started[0].port, bind: "127.0.0.1" });
    expect(lines[0]).toContain(`::1:${String(started[0].port)}`);
  });

  it("honours a pinned port", async () => {
    process.env.EGRESS_PROXY_BIND = "127.0.0.1";
    process.env.EGRESS_PROXY_PORT = String(await free());
    started = await bootEgressProxy(() => undefined);
    expect(started[0].port).toBe(Number(process.env.EGRESS_PROXY_PORT));
  });

  it("refuses a port that is not one, and records nothing when it cannot listen", async () => {
    process.env.EGRESS_PROXY_PORT = "http";
    await expect(bootEgressProxy(() => undefined)).rejects.toThrow("EGRESS_PROXY_PORT");

    // The second address cannot be bound: the first listener is closed again.
    process.env.EGRESS_PROXY_PORT = "0";
    process.env.EGRESS_PROXY_BIND = "127.0.0.1,192.0.2.1";
    await expect(bootEgressProxy(() => undefined)).rejects.toThrow();
    expect(runningEgressProxy()).toBeNull();
  });
});
