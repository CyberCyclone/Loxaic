import { afterEach, describe, expect, it } from "vitest";
import { getProviderByKind, getSandboxMode, getSandboxProvider } from "../provider.ts";

describe("sandbox mode selection", () => {
  afterEach(() => {
    delete process.env.SANDBOX_MODE;
  });

  it("defaults to container when SANDBOX_MODE is unset", () => {
    expect(getSandboxMode()).toBe("container");
  });

  it("reads SANDBOX_MODE=host", () => {
    process.env.SANDBOX_MODE = "host";
    expect(getSandboxMode()).toBe("host");
  });

  it("reads SANDBOX_MODE=off", () => {
    process.env.SANDBOX_MODE = "off";
    expect(getSandboxMode()).toBe("off");
  });

  it("falls back to container for an unrecognized value", () => {
    process.env.SANDBOX_MODE = "nonsense";
    expect(getSandboxMode()).toBe("container");
  });

  it("getSandboxProvider() returns null when SANDBOX_MODE=off", async () => {
    process.env.SANDBOX_MODE = "off";
    await expect(getSandboxProvider()).resolves.toBeNull();
  });

  it("getSandboxProvider() returns the host provider for SANDBOX_MODE=host", async () => {
    process.env.SANDBOX_MODE = "host";
    const provider = await getSandboxProvider();
    expect(provider?.kind).toBe("host");
  });

  it("getSandboxProvider() returns the container provider by default", async () => {
    const provider = await getSandboxProvider();
    expect(provider?.kind).toBe("container");
  });

  it("getProviderByKind() ignores the current SANDBOX_MODE — the caller picks explicitly", async () => {
    process.env.SANDBOX_MODE = "container";
    const host = await getProviderByKind("host");
    expect(host.kind).toBe("host");
  });

  it("provider singletons are stable across repeated calls", async () => {
    const a = await getProviderByKind("host");
    const b = await getProviderByKind("host");
    expect(a).toBe(b);
  });
});
