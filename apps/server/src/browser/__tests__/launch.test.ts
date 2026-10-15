import { describe, expect, it } from "vitest";
import { BROWSER_PROFILE_DIR, CDP_PORT, chromiumArgs, chromiumEnv } from "../launch.ts";

/**
 * The Chromium command line (#281). These flags are the browser half of the
 * containment story, so each one is asserted by what it *prevents* rather than
 * by its text: a dropped flag here is a hole, and the only thing that would say
 * so is this file.
 */

const args = chromiumArgs({ proxyUrl: "http://172.30.0.1:41000" });

describe("chromiumArgs", () => {
  it("proxies everything, including requests to loopback", () => {
    expect(args).toContain("--proxy-server=http://172.30.0.1:41000");
    // Chromium's built-in "never proxy localhost" rule is the easiest way out of
    // the SSRF guard: a page navigating to http://127.0.0.1:4000 would reach the
    // server without ever meeting it. `<-loopback>` is what sends those too.
    expect(args).toContain('--proxy-bypass-list="<-loopback>"');
  });

  it("resolves nothing itself, so the proxy is the only thing that decides where a name goes", () => {
    expect(args).toContain("--host-resolver-rules=MAP * ~NOTFOUND");
  });

  it("keeps the profile on the tmpfs path the container mounts", () => {
    expect(args).toContain(`--user-data-dir=${BROWSER_PROFILE_DIR}`);
  });

  it("publishes CDP on the session network and on no host port", () => {
    expect(args).toContain(`--remote-debugging-port=${String(CDP_PORT)}`);
    expect(args).toContain("--remote-debugging-address=0.0.0.0");
    // A published port is a container flag, not a browser one; asserting it here
    // would be meaningless. What *is* asserted is that nothing in the browser
    // args opens a second control surface (a debugging pipe, a remote shell).
    expect(args.join(" ")).not.toMatch(/remote-debugging-pipe|inspect=/);
  });

  it("makes no background requests of its own", () => {
    for (const flag of ["--disable-background-networking", "--disable-component-update", "--disable-sync"]) {
      expect(args).toContain(flag);
    }
    // Casting and route discovery are multicast, which a CONNECT proxy cannot
    // police because that traffic is never proxied.
    expect(args).toContain("--disable-features=MediaRouter,DialMediaRouteProvider");
  });

  it("runs headless and writes nothing outside the tmpfs", () => {
    expect(args).toContain("--headless=new");
    expect(args).toContain("--disable-dev-shm-usage");
    expect(args.filter((a) => /^--download-|--user-data-dir=(?!\/home\/loxaic\/profile)/.test(a))).toEqual([]);
  });

  it("runs with Chromium's own sandbox off, which is the container's job", () => {
    // The default. `CapDrop: ALL` + `no-new-privileges` mean the SUID helper
    // cannot do its work, so a session that tried to keep it would fail to start
    // rather than run unprotected.
    expect(args).toContain("--no-sandbox");
    expect(chromiumArgs({ proxyUrl: "http://x:1", chromiumSandbox: true })).not.toContain("--no-sandbox");
  });

  it("takes the screenshot viewport from the caller", () => {
    const sized = chromiumArgs({ proxyUrl: "http://x:1", viewport: { width: 800, height: 600 } });
    expect(sized).toContain("--window-size=800,600");
  });

  it("env carries no credential, no inherited proxy, and nothing else", () => {
    const env = chromiumEnv();
    expect(Object.keys(env).sort()).toEqual(["HOME"]);
  });
});
