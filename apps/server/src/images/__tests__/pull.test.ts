import { describe, expect, it } from "vitest";
import { chooseDigest, describePullFailure } from "../pull.ts";

const repo = "ghcr.io/o/i";
const a = `sha256:${"a".repeat(64)}`;
const b = `sha256:${"b".repeat(64)}`;

describe("chooseDigest", () => {
  it("takes the pull's own Digest line over anything the image carries", () => {
    expect(chooseDigest(repo, ["Pulling from o/i", `Digest: ${a}`, "Status: Downloaded"], [`${repo}@${b}`])).toBe(`${repo}@${a}`);
  });

  it("falls back to RepoDigests only when exactly one is for this repository", () => {
    expect(chooseDigest(repo, [], [`${repo}@${a}`, `other/x@${b}`])).toBe(`${repo}@${a}`);
    // An image id can carry several; guessing could name one this pull never proved.
    expect(chooseDigest(repo, [], [`${repo}@${a}`, `${repo}@${b}`])).toBeNull();
    expect(chooseDigest(repo, [], [])).toBeNull();
  });

  it("reads Docker Hub's unqualified repo digests, and answers with the qualified name", () => {
    expect(chooseDigest("docker.io/library/ubuntu", [], [`ubuntu@${a}`])).toBe(`docker.io/library/ubuntu@${a}`);
    expect(chooseDigest("docker.io/someone/tool", [], [`someone/tool@${a}`])).toBe(`docker.io/someone/tool@${a}`);
    // A different repository's short form is not this one's.
    expect(chooseDigest("docker.io/library/ubuntu", [], [`debian@${a}`])).toBeNull();
  });
});

describe("describePullFailure", () => {
  it("names the login as the thing to fix when the registry refuses, with the secret scrubbed", () => {
    const text = describePullFailure("unauthorized: authentication required for hunter2", "ghcr.io/o/i:1", "ghcr.io", "hunter2");
    expect(text).toMatch(/ghcr.io refused/);
    expect(text).not.toContain("hunter2");
  });

  it("reads Docker's answer to a pull with no login as a refusal too", () => {
    const raw = '(HTTP code 500) server error - Head "http://localhost:5055/v2/a/b/manifests/1": no basic auth credentials';
    expect(describePullFailure(raw, "localhost:5055/a/b:1", "localhost:5055", null)).toMatch(/localhost:5055 refused/);
  });

  it("does not read a 401 or 403 inside a digest as a refusal", () => {
    const digestWith401 = `sha256:${"0".repeat(20)}401${"0".repeat(41)}`;
    expect(describePullFailure(`manifest unknown: ${digestWith401}`, "x", "ghcr.io", null)).toMatch(/was not found/);
    expect(describePullFailure("unexpected status 403 Forbidden", "x", "ghcr.io", null)).toMatch(/refused/);
  });

  it("says when the image has no build for this platform, or does not exist", () => {
    expect(describePullFailure("no matching manifest for linux/arm64", "x", "docker.io", null)).toMatch(/no build for this server's platform/);
    expect(describePullFailure("manifest unknown", "x", "docker.io", null)).toMatch(/was not found/);
  });

  it("keeps the engine's own words for anything else, scrubbed", () => {
    const text = describePullFailure("connection reset while sending s3cret", "x", "docker.io", "s3cret");
    expect(text).toBe("Pulling x failed: connection reset while sending [redacted]");
  });
});
