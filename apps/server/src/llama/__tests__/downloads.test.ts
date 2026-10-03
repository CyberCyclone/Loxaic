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
  backfillHeaderFacts,
  cancelDownload,
  DownloadError,
  liveHeadBytesDone,
  onMtpHeadSettled,
  pauseDownload,
  queueDownload,
  queueMtpHead,
  removeFiles,
  removeMtpHead,
  resumeDownload,
  startDownloadQueue,
  stopDownloads,
} from "../downloads.ts";
import { groupQuants, searchModels } from "../hf.ts";
import { modelFilePath } from "../paths.ts";
import { buildGguf, denseModel } from "./gguf-fixture.ts";

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

/** A head file: `arch`'s keys, one nextn layer and its tensors. */
function headFile(arch: string, opts: { shared?: boolean; pad?: number } = {}): Buffer {
  return buildGguf(
    [
      ["general.architecture", { type: "str", v: arch }],
      [`${arch}.block_count`, { type: "u32", v: 29 }],
      [`${arch}.nextn_predict_layers`, { type: "u32", v: 1 }],
      ...(opts.shared ? [[`${arch}.nextn_shared_target_tensors`, { type: "bool", v: true }] as [string, { type: "bool"; v: boolean }]] : []),
    ],
    opts.pad ?? 0,
    ["token_embd.weight", "blk.28.nextn.eh_proj.weight", "blk.28.nextn.enorm.weight"],
  );
}
const mtpRepo = `tester/Heady-${uuid().slice(0, 6)}-GGUF`;
const head = headFile("qwen3", { pad: 2 * 1024 * 1024 });
const otherArchHead = headFile("llama");
const sharedHead = headFile("qwen3", { shared: true });
const notAHead = denseModel(64 * 1024);

const embRepo = `tester/Emb-${uuid().slice(0, 6)}-GGUF`;
const embedded = headFile("qwen3", { pad: 128 * 1024 });

const repos: Partial<Record<string, Partial<Record<string, FileSpec>>>> = {
  // A model whose own file carries its head (Qwen3.8-27B's layout).
  [embRepo]: { "Emb-Q4_K_M.gguf": { body: embedded, sha: sha256(embedded) } },
  // A model with no head of its own, and the heads its repo publishes beside
  // it, the way unsloth's Qwen3.8-Flash-Next does.
  [mtpRepo]: {
    "Heady-Q4_K_M.gguf": { body: small, sha: sha256(small) },
    "Heady-Q8_0.gguf": { body: small, sha: sha256(small) },
    "MTP/mtp-Heady-Q8_0.gguf": { body: head, sha: sha256(head), slow: true },
    "MTP/mtp-Heady-shared-Q8_0.gguf": { body: sharedHead, sha: sha256(sharedHead) },
    "MTP/mtp-Other-Q4_0.gguf": { body: otherArchHead, sha: sha256(otherArchHead) },
    "MTP/mtp-Empty-Q4_0.gguf": { body: notAHead, sha: sha256(notAHead) },
    // Served whole, then fails its checksum: a download that throws.
    "MTP/mtp-Bad-Q4_0.gguf": { body: head, sha: "c".repeat(64) },
  },
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

  it("reads the attention layout of a model downloaded before it was recorded, once", async () => {
    const id = `${repo}:Q4_K_M`;
    const read = async () => {
      invalidateLocalModelCache();
      const r = await getLocalModelRow(id);
      if (!r) throw new Error("row missing");
      return r;
    };
    // As a row from before the shape was read: no `shape` key at all.
    const { shape: _drop, ...older } = (await read()).meta as Record<string, unknown>;
    await db.update(localModels).set({ meta: older }).where(eq(localModels.id, id));
    expect(await backfillHeaderFacts([await read()])).toBe(1);
    // The fixture describes no attention heads, so it is stored as read-and-
    // absent (null), and the next boot does not read the file again.
    const after = await read();
    expect(after.meta).toMatchObject({ nLayers: 28, shape: null, thinking: null });
    expect(await backfillHeaderFacts([after])).toBe(0);
  });

  it("reads the thinking control of a model downloaded before it was recorded", async () => {
    const id = `${repo}:Q4_K_M`;
    invalidateLocalModelCache();
    const row = await getLocalModelRow(id);
    if (!row) throw new Error("row missing");
    // As a row from before the template was read: `shape` known, no `thinking`.
    const { thinking: _drop, ...older } = row.meta as Record<string, unknown>;
    await db.update(localModels).set({ meta: older }).where(eq(localModels.id, id));
    invalidateLocalModelCache();
    const before = await getLocalModelRow(id);
    if (!before) throw new Error("row missing");
    expect(await backfillHeaderFacts([before])).toBe(1);
    invalidateLocalModelCache();
    // The fixture carries no chat template: read, and found to take no level.
    expect((await getLocalModelRow(id))?.meta).toMatchObject({ thinking: null });
  });

  it("does not read a file it could not read again on the next boot", async () => {
    const id = `${repo}:Q4_K_M`;
    const read = async () => {
      invalidateLocalModelCache();
      const r = await getLocalModelRow(id);
      if (!r) throw new Error("row missing");
      return r;
    };
    const { shape: _drop, ...older } = (await read()).meta as Record<string, unknown>;
    await db.update(localModels).set({ meta: older }).where(eq(localModels.id, id));
    // The file is gone from under the row: the read fails.
    const broken = { ...(await read()), files: [{ path: "no-such-file.gguf", size: 1, sha256: null }] };
    expect(await backfillHeaderFacts([broken])).toBe(0);
    const after = await read();
    expect(after.meta).toMatchObject({ shape: null });
    // Recorded, so the retry is not made — a row with `shape` present is skipped.
    expect(Object.keys(after.meta as object)).toContain("shape");
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

describe("MTP heads", () => {
  const id = `${mtpRepo}:Q4_K_M`;
  const settled = vi.fn();
  beforeAll(() => {
    onMtpHeadSettled(settled);
  });
  const read = async () => {
    invalidateLocalModelCache();
    const row = await getLocalModelRow(id);
    if (!row) throw new Error("row missing");
    return row;
  };
  const headOf = async () => (await read()).mtpHead as { status: string; error: string | null; layers: number | null; revision: string; path: string } | null;
  async function headUntil(pred: (s: string | undefined) => boolean, ms = 15_000) {
    const end = Date.now() + ms;
    for (;;) {
      const h = await headOf();
      if (pred(h?.status)) return h;
      if (Date.now() > end) throw new Error(`timed out; head ${String(h?.status)}`);
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  it("refuses a shared head before downloading anything, and one the repo does not have", async () => {
    await expect(queueDownload({ repo: mtpRepo, quant: "Q4_K_M", mtpHead: "MTP/mtp-Heady-shared-Q8_0.gguf" }, userId)).rejects.toThrow(/shared/);
    await expect(queueDownload({ repo: mtpRepo, quant: "Q4_K_M", mtpHead: "MTP/nope.gguf" }, userId)).rejects.toThrow(/not in this repository/);
  });

  it("downloads a head after its model, while the model stays ready, then reads and keeps it", async () => {
    settled.mockClear();
    await queueDownload({ repo: mtpRepo, quant: "Q4_K_M", mtpHead: "MTP/mtp-Heady-Q8_0.gguf" }, userId);
    await until(id, (s) => s === "ready");
    // The head is slow: caught mid-download, the model is ready all the same.
    const during = await headUntil((s) => s === "downloading" || s === "ready");
    if (during?.status === "downloading") expect((await read()).status).toBe("ready");
    const done = await headUntil((s) => s === "ready");
    expect(done).toMatchObject({ layers: 1, error: null, revision: REV });
    expect(existsSync(modelFilePath(mtpRepo, REV, "MTP/mtp-Heady-Q8_0.gguf"))).toBe(true);
    expect(settled).toHaveBeenCalled();
    await expect(queueMtpHead(id, "MTP/mtp-Other-Q4_0.gguf")).rejects.toThrow(/already has an MTP head/);
  });

  it("removing the head deletes its file and turns MTP off", async () => {
    await db.update(localModels).set({ loadSettings: { mtp: true, mtpDraftMax: 2, ctxSize: 4096 } }).where(eq(localModels.id, id));
    const after = await removeMtpHead(id);
    expect(after?.mtpHead).toBeNull();
    expect(after?.loadSettings).toEqual({ ctxSize: 4096 });
    expect(existsSync(modelFilePath(mtpRepo, REV, "MTP/mtp-Heady-Q8_0.gguf"))).toBe(false);
  });

  it("refuses, after the download, a head for another architecture and a file with no head in it", async () => {
    await queueMtpHead(id, "MTP/mtp-Other-Q4_0.gguf");
    expect((await headUntil((s) => s === "failed"))?.error).toMatch(/head for llama, not qwen3/);
    expect(existsSync(modelFilePath(mtpRepo, REV, "MTP/mtp-Other-Q4_0.gguf"))).toBe(false);
    // A failed head may be replaced without removing it first.
    await queueMtpHead(id, "MTP/mtp-Empty-Q4_0.gguf");
    expect((await headUntil((s) => s === "failed"))?.error).toMatch(/carries no MTP head/);
    expect((await read()).status).toBe("ready");
  });

  it("turns MTP off when its head is refused or fails, so a later save is not refused for it", async () => {
    // MTP may be switched on while a head is on its way. If the head never
    // arrives, a stored `mtp: true` would make every later save of the
    // model's settings fail on a field the admin did not touch.
    const withMtp = async () => {
      await db.update(localModels).set({ loadSettings: { mtp: true, mtpDraftMax: 2, ctxSize: 4096 } }).where(eq(localModels.id, id));
      invalidateLocalModelCache();
    };
    await withMtp();
    await queueMtpHead(id, "MTP/mtp-Other-Q4_0.gguf");
    await headUntil((s) => s === "failed");
    expect((await read()).loadSettings).toEqual({ ctxSize: 4096 });

    await withMtp();
    await queueMtpHead(id, "MTP/mtp-Bad-Q4_0.gguf");
    expect((await headUntil((s) => s === "failed"))?.error).toMatch(/checksum/);
    const row = await read();
    expect(row.loadSettings).toEqual({ ctxSize: 4096 });
    // Its bytes are not still counted live: a retry starts from nothing, in
    // the progress shown and in the disk space reserved for it.
    const retry = { ...row, mtpHead: { ...(row.mtpHead as object), status: "queued", bytesDone: 0 } };
    expect(liveHeadBytesDone(retry)).toBe(0);
  });

  it("refuses a head for a model whose own download failed", async () => {
    // A head only downloads for a ready model: queued on a failed one, it
    // would wait for ever, keeping the screen polling and its bytes reserved.
    await db.update(localModels).set({ status: "failed" }).where(eq(localModels.id, id));
    invalidateLocalModelCache();
    try {
      await expect(queueMtpHead(id, "MTP/mtp-Heady-Q8_0.gguf")).rejects.toMatchObject({ status: 409 });
    } finally {
      await db.update(localModels).set({ status: "ready" }).where(eq(localModels.id, id));
      invalidateLocalModelCache();
    }
  });

  it("leaves nothing behind when a head is cancelled mid-download, or its model deleted", async () => {
    const file = modelFilePath(mtpRepo, REV, "MTP/mtp-Heady-Q8_0.gguf");
    const midway = async () => {
      await headUntil((s) => s === "downloading");
      for (const end = Date.now() + 10_000; !(existsSync(`${file}.part`) && statSync(`${file}.part`).size > 128 * 1024); ) {
        if (Date.now() > end) throw new Error("no progress");
        await new Promise((r) => setTimeout(r, 20));
      }
    };
    await removeMtpHead(id);
    await queueMtpHead(id, "MTP/mtp-Heady-Q8_0.gguf");
    await midway();
    expect((await removeMtpHead(id))?.mtpHead).toBeNull();
    await new Promise((r) => setTimeout(r, 300));
    expect(await headOf()).toBeNull();
    expect(existsSync(file) || existsSync(`${file}.part`)).toBe(false);

    await queueMtpHead(id, "MTP/mtp-Heady-Q8_0.gguf");
    await midway();
    await removeFiles(await read());
    expect(existsSync(file) || existsSync(`${file}.part`)).toBe(false);
  });

  it("keeps a head another quant still uses when one of them is deleted", async () => {
    await removeMtpHead(id);
    const other = `${mtpRepo}:Q8_0`;
    await queueDownload({ repo: mtpRepo, quant: "Q8_0" }, userId);
    await until(other, (s) => s === "ready");
    await queueMtpHead(id, "MTP/mtp-Heady-Q8_0.gguf");
    await queueMtpHead(other, "MTP/mtp-Heady-Q8_0.gguf");
    await headUntil((s) => s === "ready");
    for (const end = Date.now() + 15_000; ; ) {
      invalidateLocalModelCache();
      if ((await getLocalModelRow(other))?.mtpHead && ((await getLocalModelRow(other))?.mtpHead as { status: string }).status === "ready") break;
      if (Date.now() > end) throw new Error("second head never ready");
      await new Promise((r) => setTimeout(r, 25));
    }
    await removeFiles(await read());
    expect(existsSync(modelFilePath(mtpRepo, REV, "MTP/mtp-Heady-Q8_0.gguf"))).toBe(true);
  });

  it("finds a head in a model's own file on download, and on the backfill for a row from before", async () => {
    const emb = `${embRepo}:Q4_K_M`;
    await queueDownload({ repo: embRepo, quant: "Q4_K_M" }, userId);
    const row = await until(emb, (s) => s === "ready");
    expect(row?.meta).toMatchObject({ mtp: { layers: 1 } });
    const { mtp: _drop, ...older } = row?.meta as Record<string, unknown>;
    await db.update(localModels).set({ meta: older }).where(eq(localModels.id, emb));
    invalidateLocalModelCache();
    const before = await getLocalModelRow(emb);
    if (!before) throw new Error("row missing");
    expect(await backfillHeaderFacts([before])).toBe(1);
    invalidateLocalModelCache();
    expect((await getLocalModelRow(emb))?.meta).toMatchObject({ mtp: { layers: 1 } });
  });

  it("refuses a head for a model whose own file carries one", async () => {
    await db.update(localModels).set({ meta: { mtp: { layers: 1 } } }).where(eq(localModels.id, id));
    await expect(queueMtpHead(id, "MTP/mtp-Heady-Q8_0.gguf")).rejects.toThrow(/carries its own/);
  });
});

