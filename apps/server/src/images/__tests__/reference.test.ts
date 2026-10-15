import { describe, expect, it } from "vitest";
import { formatReference, parseReference, parseRegistry, repositoryName, serverAddress } from "../reference.ts";

const digest = `sha256:${"a".repeat(64)}`;

describe("parseReference", () => {
  it("puts a bare Docker Hub name under library/ with the latest tag", () => {
    const ref = parseReference("ubuntu");
    expect(ref).toEqual({ registry: "docker.io", repository: "library/ubuntu", tag: "latest", digest: null });
    expect(formatReference(ref)).toBe("docker.io/library/ubuntu:latest");
  });

  it("reads every spelling of one Hub image as the same image, so they share one login", () => {
    const forms = ["ubuntu:24.04", "library/ubuntu:24.04", "docker.io/ubuntu:24.04", "index.docker.io/library/ubuntu:24.04"];
    const canonical = forms.map((f) => formatReference(parseReference(f)));
    expect(new Set(canonical)).toEqual(new Set(["docker.io/library/ubuntu:24.04"]));
  });

  it("keeps a Hub user's repository as it is", () => {
    expect(formatReference(parseReference("someone/tool:1.2"))).toBe("docker.io/someone/tool:1.2");
  });

  it("treats a first component with a dot, a port or localhost as the registry", () => {
    expect(parseReference("ghcr.io/owner/image:v1").registry).toBe("ghcr.io");
    expect(parseReference("localhost:5000/team/img").registry).toBe("localhost:5000");
    expect(parseReference("localhost/img").registry).toBe("localhost");
    // A port is not a tag: the colon is before the last slash.
    expect(parseReference("registry.example.com:8443/a/b").tag).toBe("latest");
  });

  it("keeps a digest and needs no tag beside it", () => {
    const ref = parseReference(`ghcr.io/o/i@${digest}`);
    expect(ref.digest).toBe(digest);
    expect(ref.tag).toBeNull();
    expect(formatReference(ref)).toBe(`ghcr.io/o/i@${digest}`);
    expect(repositoryName(ref)).toBe("ghcr.io/o/i");
  });

  it.each([
    ["", "Enter an image reference"],
    ["https://ghcr.io/o/i", "Leave out the scheme"],
    ["ubuntu 24.04", "spaces"],
    ["Ubuntu", "lowercase"],
    ["ubuntu:bad tag", "spaces"],
    ["ubuntu@sha256:short", "digest"],
    ["ghcr.io/", "lowercase"],
  ])("refuses %j", (input, message) => {
    expect(() => parseReference(input)).toThrow(message);
  });

  it("refuses something that is not text", () => {
    expect(() => parseReference(42)).toThrow("must be text");
  });
});

describe("registries", () => {
  it("normalises a login's registry as typed", () => {
    expect(() => parseRegistry("")).toThrow("Name the registry");
    expect(parseRegistry("https://index.docker.io/v1/")).toBe("docker.io");
    expect(parseRegistry("GHCR.io")).toBe("ghcr.io");
    expect(parseRegistry("https://localhost:5000/v2/")).toBe("localhost:5000");
    expect(() => parseRegistry("not a host")).toThrow("not a registry host");
  });

  it("authenticates Docker Hub against its v1 index, everything else by host", () => {
    expect(serverAddress("docker.io")).toBe("https://index.docker.io/v1/");
    expect(serverAddress("ghcr.io")).toBe("ghcr.io");
  });
});
