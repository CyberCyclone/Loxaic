import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetReleasesForTest, findRelease, listReleases, releaseBuild, ReleasesError } from "../releases.ts";
import { RUNTIME_MANIFEST } from "../runtime-manifest.ts";

/**
 * The official release list, against a stand-in for GitHub's API
 * (`LLAMA_RELEASES_API_URL`). The fake hardware seam is on, so the machine is
 * the fixed `linux-x64-vulkan` one whatever this suite runs on.
 */

const SHA = "b".repeat(64);
const vulkan = (tag: string, digest: string | null = `sha256:${SHA}`) => ({
  name: `llama-${tag}-bin-ubuntu-vulkan-x64.tar.gz`,
  size: 1234,
  digest,
});

let server: Server;
let handler: (req: IncomingMessage, res: ServerResponse) => void = (_req, res) => { res.writeHead(500).end(); };
const seen: { url: string; ifNoneMatch: string | undefined }[] = [];

function json(res: ServerResponse, body: unknown, headers: Record<string, string> = {}, status = 200): void {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

beforeAll(async () => {
  server = createServer((req, res) => {
    seen.push({ url: req.url ?? "", ifNoneMatch: req.headers["if-none-match"] });
    handler(req, res);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  vi.stubEnv("LLAMA_RELEASES_API_URL", `http://127.0.0.1:${String(typeof addr === "object" && addr ? addr.port : 0)}/repo`);
  vi.stubEnv("LOXAIC_LLAMA_SERVER_BIN", "/tmp/fake-llama");
  vi.stubEnv("LOXAIC_FAKE_HARDWARE", "gpu");
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await new Promise<void>((r) => server.close(() => { r(); }));
});

beforeEach(() => {
  __resetReleasesForTest();
  seen.length = 0;
  vi.useRealTimers();
});

describe("listing llama.cpp's releases", () => {
  it("says for each release whether it is a pre-release and whether this machine can install it", async () => {
    handler = (_req, res) => {
      json(res, [
        { tag_name: "b9003", prerelease: true, published_at: "2026-10-01T00:00:00Z", assets: [vulkan("b9003")] },
        { tag_name: "b9002", prerelease: false, published_at: "2026-09-30T00:00:00Z", assets: [{ name: "llama-b9002-bin-macos-arm64.tar.gz", size: 5, digest: `sha256:${SHA}` }] },
        { tag_name: "b9001", prerelease: false, published_at: null, assets: [vulkan("b9001", null)] },
        { tag_name: RUNTIME_MANIFEST.tag, assets: [vulkan(RUNTIME_MANIFEST.tag)] },
        // Not ours to offer: a draft, and tags that are not b<number>.
        { tag_name: "b9000", draft: true, assets: [vulkan("b9000")] },
        { tag_name: "master-abc123", assets: [] },
        { tag_name: "../b1", assets: [] },
      ]);
    };
    const page = await listReleases(1, "vulkan");
    expect(seen[0].url).toBe("/repo/releases?per_page=30&page=1");
    expect(page.stale).toBeNull();
    expect(page.hasMore).toBe(false);
    expect(page.releases).toEqual([
      { tag: "b9003", publishedAt: "2026-10-01T00:00:00Z", prerelease: true, availability: "ok", sizeBytes: 1234, bundled: false },
      { tag: "b9002", publishedAt: "2026-09-30T00:00:00Z", prerelease: false, availability: "no-build", sizeBytes: null, bundled: false },
      { tag: "b9001", publishedAt: null, prerelease: false, availability: "no-checksum", sizeBytes: null, bundled: false },
      { tag: RUNTIME_MANIFEST.tag, publishedAt: null, prerelease: false, availability: "ok", sizeBytes: 1234, bundled: true },
    ]);
  });

  it("says there may be more after a full page, whatever was kept of it", async () => {
    handler = (_req, res) => {
      json(res, Array.from({ length: 30 }, (_, i) => ({ tag_name: i === 0 ? "b9100" : `odd-${String(i)}`, assets: [] })));
    };
    const page = await listReleases(3, "vulkan");
    expect(seen[0].url).toBe("/repo/releases?per_page=30&page=3");
    expect(page.releases.map((r) => r.tag)).toEqual(["b9100"]);
    expect(page.hasMore).toBe(true);
  });

  it("does not ask again inside ten minutes, then revalidates with the ETag", async () => {
    let etagHits = 0;
    handler = (req, res) => {
      if (req.headers["if-none-match"] === '"v1"') {
        etagHits++;
        res.writeHead(304).end();
        return;
      }
      json(res, [{ tag_name: "b9200", assets: [vulkan("b9200")] }], { etag: '"v1"' });
    };
    vi.useFakeTimers({ toFake: ["Date"] });
    await listReleases(1, "vulkan");
    await listReleases(1, "vulkan");
    expect(seen).toHaveLength(1);
    vi.setSystemTime(Date.now() + 11 * 60_000);
    const again = await listReleases(1, "vulkan");
    expect(seen).toHaveLength(2);
    expect(etagHits).toBe(1);
    expect(again.releases.map((r) => r.tag)).toEqual(["b9200"]);
    expect(again.stale).toBeNull();
    // The 304 made it fresh again.
    await listReleases(1, "vulkan");
    expect(seen).toHaveLength(2);
  });

  it("serves the last answer, and says when to retry, once GitHub rate-limits", async () => {
    handler = (_req, res) => { json(res, [{ tag_name: "b9300", assets: [vulkan("b9300")] }]); };
    vi.useFakeTimers({ toFake: ["Date"] });
    await listReleases(1, "vulkan");
    vi.setSystemTime(Date.now() + 11 * 60_000);
    const reset = Math.floor(Date.now() / 1000) + 1800;
    handler = (_req, res) => { json(res, { message: "API rate limit exceeded" }, { "x-ratelimit-reset": String(reset) }, 403); };
    const page = await listReleases(1, "vulkan");
    expect(page.releases.map((r) => r.tag)).toEqual(["b9300"]);
    expect(page.stale).toMatchObject({ retryAt: new Date(reset * 1000).toISOString() });
  });

  it("is an error, not an empty list, when GitHub refuses and nothing was kept", async () => {
    handler = (_req, res) => { json(res, { message: "API rate limit exceeded" }, {}, 429); };
    await expect(listReleases(1, "vulkan")).rejects.toMatchObject({ name: "ReleasesError", status: 429 });
    handler = (_req, res) => { res.writeHead(200, { "content-type": "application/json" }).end("<html>"); };
    await expect(listReleases(2, "vulkan")).rejects.toBeInstanceOf(ReleasesError);
  });

  it("finds one release by its tag, and says so when there is none", async () => {
    handler = (req, res) => {
      if (req.url === "/repo/releases/tags/b9400") json(res, { tag_name: "b9400", prerelease: true, assets: [vulkan("b9400")] });
      else json(res, { message: "Not Found" }, {}, 404);
    };
    expect((await findRelease("b9400", "vulkan")).row).toMatchObject({ tag: "b9400", prerelease: true, availability: "ok" });
    expect((await findRelease("b9401", "vulkan")).row).toBeNull();
    // Never asked: not a tag.
    const before = seen.length;
    expect((await findRelease("b94/../x", "vulkan")).row).toBeNull();
    expect(seen).toHaveLength(before);
  });
});

describe("what to download for a release", () => {
  it("is the asset for this machine with GitHub's digest", async () => {
    handler = (_req, res) => { json(res, { tag_name: "b9500", assets: [vulkan("b9500"), { name: "llama-b9500-bin-ubuntu-x64.tar.gz", size: 9, digest: `sha256:${SHA}` }] }); };
    expect(await releaseBuild("b9500", "vulkan")).toEqual({ asset: { name: "llama-b9500-bin-ubuntu-vulkan-x64.tar.gz", sha256: SHA, size: 1234 } });
    expect(await releaseBuild("b9500", "cpu")).toMatchObject({ asset: { name: "llama-b9500-bin-ubuntu-x64.tar.gz" } });
  });

  it("refuses a release with no build here, with no checksum, or that does not exist", async () => {
    handler = (req, res) => {
      if (req.url?.endsWith("/b9600")) json(res, { tag_name: "b9600", assets: [vulkan("b9600", null)] });
      else if (req.url?.endsWith("/b9601")) json(res, { tag_name: "b9601", assets: [] });
      else json(res, {}, {}, 404);
    };
    await expect(releaseBuild("b9600", "vulkan")).rejects.toThrow(/no checksum/);
    await expect(releaseBuild("b9601", "vulkan")).rejects.toThrow(/no vulkan build for this machine/);
    await expect(releaseBuild("b9602", "vulkan")).rejects.toMatchObject({ status: 404 });
    await expect(releaseBuild("latest", "vulkan")).rejects.toMatchObject({ status: 400 });
  });
});
