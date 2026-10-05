import { afterEach, describe, expect, it, vi } from "vitest";
import { allowedBuildUrl, ASSET_SPECS, matchAssets, OFFICIAL_TAG, type ReleaseAsset } from "../runtime-assets.ts";
import { RUNTIME_MANIFEST } from "../runtime-manifest.ts";

/**
 * Which of a release's assets is this machine's build. The table has to
 * answer for releases nobody reviewed, so it is held against the one that was
 * (the pinned manifest) and against the ways names have differed.
 */

const SHA = "a".repeat(64);
const asset = (name: string, digest: string | null = `sha256:${SHA}`, size = 100): ReleaseAsset => ({ name, size, digest });

describe("matching a release's assets", () => {
  it("picks, for every platform the manifest covers, exactly the asset the manifest pins", () => {
    const assets: ReleaseAsset[] = [];
    for (const b of Object.values(RUNTIME_MANIFEST.builds)) {
      for (const a of [b.asset, b.extra]) if (a) assets.push({ name: a.name, size: a.size, digest: `sha256:${a.sha256}` });
    }
    expect(Object.keys(ASSET_SPECS).sort()).toEqual(Object.keys(RUNTIME_MANIFEST.builds).sort());
    for (const [key, build] of Object.entries(RUNTIME_MANIFEST.builds)) {
      expect(matchAssets(RUNTIME_MANIFEST.tag, assets, key), key).toEqual({ status: "ok", build });
    }
  });

  it("follows the CUDA minor in the name, which has changed between releases", () => {
    const match = matchAssets("b5000", [asset("llama-b5000-bin-ubuntu-cuda-12.4-x64.tar.gz")], "linux-x64-cuda12");
    expect(match).toMatchObject({ status: "ok", build: { asset: { name: "llama-b5000-bin-ubuntu-cuda-12.4-x64.tar.gz", sha256: SHA } } });
  });

  it("needs the cudart archive of the same CUDA version on Windows", () => {
    const main = asset("llama-b5000-bin-win-cuda-12.4-x64.zip");
    expect(matchAssets("b5000", [main, asset("cudart-llama-bin-win-cuda-12.8-x64.zip")], "win32-x64-cuda12")).toEqual({ status: "no-build" });
    expect(matchAssets("b5000", [main, asset("cudart-llama-bin-win-cuda-12.4-x64.zip")], "win32-x64-cuda12")).toMatchObject({
      status: "ok",
      build: { extra: { name: "cudart-llama-bin-win-cuda-12.4-x64.zip" } },
    });
    // The runtime libraries are run too: unverifiable is not installable.
    expect(matchAssets("b5000", [main, asset("cudart-llama-bin-win-cuda-12.4-x64.zip", null)], "win32-x64-cuda12")).toEqual({
      status: "no-checksum",
    });
  });

  it("says a build with no published checksum is not installable, rather than that there is none", () => {
    expect(matchAssets("b3000", [asset("llama-b3000-bin-macos-arm64.zip", null)], "darwin-arm64-metal")).toEqual({ status: "no-checksum" });
    expect(matchAssets("b3000", [asset("llama-b3000-bin-macos-arm64.zip", "md5:abc")], "darwin-arm64-metal")).toEqual({ status: "no-checksum" });
  });

  it("offers a Linux machine no zip, which its tar cannot unpack, and a Mac either", () => {
    const zip = [asset("llama-b3000-bin-ubuntu-x64.zip")];
    expect(matchAssets("b3000", zip, "linux-x64-cpu")).toEqual({ status: "no-build" });
    expect(matchAssets("b3000", [asset("llama-b3000-bin-macos-arm64.zip")], "darwin-arm64-metal")).toMatchObject({ status: "ok" });
  });

  it("does not take another backend's or another release's archive", () => {
    const assets = [asset("llama-b3000-bin-ubuntu-vulkan-x64.tar.gz"), asset("llama-b3001-bin-ubuntu-x64.tar.gz")];
    expect(matchAssets("b3000", assets, "linux-x64-cpu")).toEqual({ status: "no-build" });
    expect(matchAssets("b3000", assets, "linux-x64-vulkan")).toMatchObject({ status: "ok" });
    expect(matchAssets("b3000", assets, "plan9-mips-cpu")).toEqual({ status: "no-build" });
  });

  it("accepts only b<number> as a tag", () => {
    for (const ok of ["b1", "b11342"]) expect(OFFICIAL_TAG.test(ok)).toBe(true);
    for (const bad of ["", "b", "B12", "b12/..", "master-abc", "b12 ", "../b12", "b123456789"]) expect(OFFICIAL_TAG.test(bad)).toBe(false);
    expect(matchAssets("b1/../x", [asset("llama-b1/../x-bin-macos-arm64.tar.gz")], "darwin-arm64-metal")).toEqual({ status: "no-build" });
  });
});

describe("where a third-party build may come from", () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it("is https, with no credentials in the address", () => {
    vi.stubEnv("LOXAIC_LLAMA_SERVER_BIN", "");
    expect(allowedBuildUrl("https://example.com/llama.tar.gz")).toBe(true);
    expect(allowedBuildUrl("https://192.168.1.50/llama.tar.gz")).toBe(true);
    for (const bad of [
      "http://example.com/llama.tar.gz",
      "http://127.0.0.1:8080/llama.tar.gz",
      "https://user:pw@example.com/llama.tar.gz",
      "file:///etc/passwd",
      "ftp://example.com/x",
      "not a url",
      "",
    ]) {
      expect(allowedBuildUrl(bad), bad).toBe(false);
    }
  });

  it("lets the test harness alone fetch from loopback over http", () => {
    vi.stubEnv("LOXAIC_LLAMA_SERVER_BIN", "/tmp/fake");
    expect(allowedBuildUrl("http://127.0.0.1:8080/llama.tar.gz")).toBe(true);
    expect(allowedBuildUrl("http://example.com/llama.tar.gz")).toBe(false);
  });
});
