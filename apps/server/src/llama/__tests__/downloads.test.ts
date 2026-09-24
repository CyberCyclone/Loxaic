import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { v4 as uuid } from "uuid";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { db, eq } from "@loxaic/db";
import { localModels, user } from "@loxaic/db/schema";
import { getLocalModelRow, invalidateLocalModelCache } from "../catalog.ts";
import {
  cancelDownload,
  DownloadError,
  pauseDownload,
  queueDownload,
  resumeDownload,
  startDownloadQueue,
  stopDownloads,
} from "../downloads.ts";
import { groupQuants, searchModels } from "../hf.ts";
import { modelFilePath } from "../paths.ts";
import { denseModel } from "./gguf-fixture.ts";

/**
 * Downloads from a mock HuggingFace (`HF_ENDPOINT`): verified against the
 * LFS sha256, resumable with Range, cancellable, and the GGUF header read into
 * the row once the file is whole.
 */

const dir = mkdtempSync(path.join(os.tmpdir(), "loxaic-dl-"));
const host = `test-dl-${uuid()}`;
const userId = `test-dl-user-${uuid()}`;
const repo = `tester/Mini-${uuid().slice(0, 6)}-GGUF`;
const REV = "a".repeat(40);

// Big enough that a throttled download can be paused part-way.
const good = denseModel(3 * 1024 * 1024);
const goodSha = createHash("sha256").update(good).digest("hex");
const slow = denseModel(4 * 1024 * 1024);
const slowSha = createHash("sha256").update(slow).digest("hex");

interface FileSpec {
  body: Buffer;
  sha: string;
  /** Served 64 KB every 20 ms, so it can be paused part-way. */
  slow?: boolean;
  /** Sends one chunk and then nothing, holding the connection open. */
  stall?: boolean;
  /** The size the tree reports, when it differs from what is served. */
  declared?: number;
}

const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const small = denseModel(256 * 1024);
const projector = denseModel(2 * 1024 * 1024);
const visionRepo = `tester/Vision-${uuid().slice(0, 6)}-GGUF`;

const repos: Partial<Record<string, Partial<Record<string, FileSpec>>>> = {
  [repo]: {
    "Mini-Q4_K_M.gguf": { body: good, sha: goodSha },
    // Served with the right size but recorded under the wrong checksum.
    "Mini-Q5_K_M.gguf": { body: good, sha: "b".repeat(64) },
    "Mini-Q8_0.gguf": { body: slow, sha: slowSha, slow: true },
    // Declared smaller than it is: the response over-serves.
    "Mini-Q2_K.gguf": { body: good, sha: goodSha, declared: 1024 * 1024 },
    // Sends a little, then goes quiet without closing.
    "Mini-Q3_K_M.gguf": { body: good, sha: goodSha, stall: true },
  },
  // Two quants that share one vision projector.
  [visionRepo]: {
    "Vision-Q4_K_M.gguf": { body: small, sha: sha256(small) },
    "Vision-Q8_0.gguf": { body: small, sha: sha256(small) },
    "mmproj-F16.gguf": { body: projector, sha: sha256(projector), slow: true },
  },
};

let server: Server;
const rangeRequests: string[] = [];
const searches: string[] = [];
/** GETs of each file's bytes, by `repo/path`. */
const fetches = new Map<string, number>();

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname === "/api/models") {
      searches.push(url.search);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify([
          { id: repo, author: "tester", downloads: 5, likes: 2, pipeline_tag: "text-generation", gguf: { total: 1e9 } },
          { id: "tester/image-GGUF", pipeline_tag: "text-to-image" },
        ]),
      );
      return;
    }
    const info = /^\/api\/models\/([^/]+\/[^/]+)$/.exec(url.pathname);
    if (info && repos[info[1]]) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: info[1], sha: REV }));
      return;
    }
    const tree = /^\/api\/models\/([^/]+\/[^/]+)\/tree\//.exec(url.pathname);
    if (tree && repos[tree[1]]) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify(
          Object.entries(repos[tree[1]] ?? {}).map(([p, f]) => {
            const size = f?.declared ?? f?.body.length;
            return { type: "file", path: p, size, lfs: { oid: f?.sha, size } };
          }),
        ),
      );
      return;
    }
    const resolve = /^\/([^/]+\/[^/]+)\/resolve\/[0-9a-f]+\/(.+)$/.exec(url.pathname);
    if (resolve) {
      const key = `${resolve[1]}/${decodeURIComponent(resolve[2])}`;
      const f = repos[resolve[1]]?.[decodeURIComponent(resolve[2])];
      if (!f) {
        res.writeHead(404);
        res.end();
        return;
      }
      fetches.set(key, (fetches.get(key) ?? 0) + 1);
      const range = /bytes=(\d+)-/.exec(req.headers.range ?? "");
      const start = range ? Number(range[1]) : 0;
      if (range) rangeRequests.push(req.headers.range ?? "");
      res.writeHead(range ? 206 : 200);
      const body = f.body.subarray(start);
      if (f.stall) {
        res.write(body.subarray(0, 64 * 1024));
        return;
      }
      if (!f.slow) {
        res.end(body);
        return;
      }
      // 64 KB every 20 ms: slow enough to pause mid-file.
      let at = 0;
      const tick = setInterval(() => {
        if (res.destroyed) {
          clearInterval(tick);
          return;
        }
        const next = body.subarray(at, at + 64 * 1024);
        at += next.length;
        if (next.length === 0) {
          clearInterval(tick);
          res.end();
        } else res.write(next);
      }, 20);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  vi.stubEnv("HF_ENDPOINT", `http://127.0.0.1:${String(port)}`);
  vi.stubEnv("LLAMA_DIR", dir);
  vi.stubEnv("LOXAIC_INSTANCE_ID", host);
  await db.insert(user).values({ id: userId, name: userId, email: `${userId}@example.test`, emailVerified: true, createdAt: new Date(), updatedAt: new Date() });
  startDownloadQueue(() => undefined);
});

afterAll(async () => {
  await stopDownloads();
  await db.delete(localModels).where(eq(localModels.hostId, host));
  await db.delete(user).where(eq(user.id, userId));
  vi.unstubAllEnvs();
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => { r(); }));
  rmSync(dir, { recursive: true, force: true });
});

async function until(id: string, pred: (s: string | undefined) => boolean, ms = 15_000) {
  const end = Date.now() + ms;
  for (;;) {
    invalidateLocalModelCache();
    const row = await getLocalModelRow(id);
    if (pred(row?.status)) return row;
    if (Date.now() > end) throw new Error(`timed out; status ${String(row?.status)}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe("HuggingFace search", () => {
  it("splits publisher/name into both filters and drops non-chat pipelines", async () => {
    const results = await searchModels({ q: "tester/mini" });
    expect(searches.at(-1)).toContain("author=tester");
    expect(searches.at(-1)).toContain("search=mini");
    expect(results.map((r) => r.repo)).toEqual([repo]);
    expect(results[0]).toMatchObject({ publisher: "tester", downloads: 5, likes: 2, params: 1e9 });
  });
});

describe("downloads", () => {
  it("downloads, verifies and reads the GGUF header — but does not enable the model", async () => {
    const row = await queueDownload({ repo, quant: "Q4_K_M" }, userId);
    expect(row.status).toBe("queued");
    const done = await until(row.id, (s) => s === "ready");
    expect(done?.enabled).toBe(false);
    expect(done?.meta).toMatchObject({ architecture: "qwen3", nLayers: 28, nCtxTrain: 40960 });
    expect(statSync(modelFilePath(repo, REV, "Mini-Q4_K_M.gguf")).size).toBe(good.length);
    expect(existsSync(`${modelFilePath(repo, REV, "Mini-Q4_K_M.gguf")}.part`)).toBe(false);
  });

  it("refuses the same model twice", async () => {
    await expect(queueDownload({ repo, quant: "Q4_K_M" }, userId)).rejects.toMatchObject({ status: 409 });
  });

  it("discards a file that does not match HuggingFace's checksum", async () => {
    const row = await queueDownload({ repo, quant: "Q5_K_M" }, userId);
    const failed = await until(row.id, (s) => s === "failed");
    expect(failed?.error).toMatch(/did not match HuggingFace's checksum/);
    expect(existsSync(modelFilePath(repo, REV, "Mini-Q5_K_M.gguf"))).toBe(false);
    expect(existsSync(`${modelFilePath(repo, REV, "Mini-Q5_K_M.gguf")}.part`)).toBe(false);
  });

  it("pauses mid-file and resumes from where it stopped", async () => {
    const row = await queueDownload({ repo, quant: "Q8_0" }, userId);
    await until(row.id, (s) => s === "downloading");
    const part = `${modelFilePath(repo, REV, "Mini-Q8_0.gguf")}.part`;
    const end = Date.now() + 10_000;
    while (!(existsSync(part) && statSync(part).size > 256 * 1024)) {
      if (Date.now() > end) throw new Error("no progress");
      await new Promise((r) => setTimeout(r, 20));
    }
    await pauseDownload(row.id);
    const paused = await until(row.id, (s) => s === "paused");
    expect(paused?.bytesDone).toBeGreaterThan(0);
    const partial = statSync(part).size;
    expect(partial).toBeLessThan(slow.length);

    await resumeDownload(row.id);
    await until(row.id, (s) => s === "ready", 20_000);
    expect(rangeRequests.some((r) => r.startsWith("bytes=") && Number(/\d+/.exec(r)?.[0]) > 0)).toBe(true);
    expect(statSync(modelFilePath(repo, REV, "Mini-Q8_0.gguf")).size).toBe(slow.length);
  });

  it("cancel removes the row and its files; a finished model must be deleted instead", async () => {
    const failedId = `${repo}:Q5_K_M`;
    expect(await cancelDownload(failedId)).toBe(true);
    invalidateLocalModelCache();
    expect(await getLocalModelRow(failedId)).toBeNull();
    await expect(cancelDownload(`${repo}:Q4_K_M`)).rejects.toBeInstanceOf(DownloadError);
  });

  it("aborts a transfer that sends more than its declared size, before it lands on disk", async () => {
    const row = await queueDownload({ repo, quant: "Q2_K" }, userId);
    const failed = await until(row.id, (s) => s === "failed");
    expect(failed?.error).toMatch(/larger than HuggingFace said/);
    const part = `${modelFilePath(repo, REV, "Mini-Q2_K.gguf")}.part`;
    expect(existsSync(part)).toBe(false);
    expect(existsSync(modelFilePath(repo, REV, "Mini-Q2_K.gguf"))).toBe(false);
  });

  it("gives up on a transfer that goes quiet, and says so", async () => {
    vi.stubEnv("LLAMA_DOWNLOAD_STALL_MS", "500");
    try {
      const row = await queueDownload({ repo, quant: "Q3_K_M" }, userId);
      const failed = await until(row.id, (s) => s === "failed");
      expect(failed?.error).toMatch(/sent nothing for 0.5 s/);
      // The part it did receive is kept, so Resume continues from it.
      expect(existsSync(`${modelFilePath(repo, REV, "Mini-Q3_K_M.gguf")}.part`)).toBe(true);
    } finally {
      vi.stubEnv("LLAMA_DOWNLOAD_STALL_MS", "");
    }
  });

  it("two quants sharing a vision projector download it once, and both finish", async () => {
    const a = await queueDownload({ repo: visionRepo, quant: "Q4_K_M", mmproj: "mmproj-F16.gguf" }, userId);
    const b = await queueDownload({ repo: visionRepo, quant: "Q8_0", mmproj: "mmproj-F16.gguf" }, userId);
    await until(a.id, (s) => s === "ready", 30_000);
    await until(b.id, (s) => s === "ready", 30_000);
    // The second row waited for the first's projector instead of opening the
    // same `.part` and interleaving into it.
    expect(fetches.get(`${visionRepo}/mmproj-F16.gguf`)).toBe(1);
    expect(statSync(modelFilePath(visionRepo, REV, "mmproj-F16.gguf")).size).toBe(projector.length);
  });

  it("never offers a file HuggingFace publishes no checksum for", () => {
    // Every GGUF on the Hub is an LFS object with an oid; one without is not
    // something this server will mmap and run on length alone.
    const { quants } = groupQuants([
      { type: "file", path: "m-Q4_K_M.gguf", size: 5, lfs: { oid: "a".repeat(64), size: 5 } },
      { type: "file", path: "m-Q8_0.gguf", size: 5 },
    ]);
    expect(quants.map((q) => q.quant)).toEqual(["Q4_K_M"]);
  });

  it("refuses a quant the repo does not have and a repo name that is not one", async () => {
    await expect(queueDownload({ repo, quant: "IQ1_S" }, userId)).rejects.toThrow(/not a quant/);
    await expect(queueDownload({ repo: "../../etc", quant: "Q4_K_M" }, userId)).rejects.toThrow(/not a HuggingFace repository/);
  });
});
