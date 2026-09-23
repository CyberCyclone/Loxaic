import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createWriteStream, existsSync } from "node:fs";
import { chmod, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { buildKey, type BuildFlavour } from "./hardware.ts";
import { runtimeDir } from "./paths.ts";
import { RUNTIME_MANIFEST } from "./runtime-manifest.ts";
import type { RuntimeAsset, RuntimeBuild } from "./runtime-types.ts";

/**
 * Installing the llama.cpp build this server runs.
 *
 * One pinned upstream release (`runtime-manifest.ts`), downloaded on first
 * need, **verified against the sha256 recorded in the repository** before
 * anything is unpacked, and moved into place atomically. The binary is
 * executed by this server with the models it serves, so "whatever GitHub
 * returns today" is not an acceptable source — a new llama.cpp is a reviewed
 * change to the manifest.
 *
 * Extraction uses the system `tar`: bsdtar on macOS and Windows 10+ reads zip
 * as well as tar.gz, and the Linux builds are tarballs, so no archive library
 * is added to the server for one call per upgrade.
 */

const SERVER_BIN = process.platform === "win32" ? "llama-server.exe" : "llama-server";
const COMPLETE_MARKER = ".loxaic-complete.json";

export interface InstalledRuntime {
  key: string;
  tag: string;
  flavour: BuildFlavour;
  dir: string;
  bin: string;
}

export interface InstallProgress {
  doneBytes: number;
  totalBytes: number;
}

export class RuntimeInstallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeInstallError";
  }
}

let overrideWarned = false;

/**
 * `LOXAIC_LLAMA_SERVER_BIN` points at a binary to run instead of installing
 * one. **Test-only**: the e2e harness sets it to a fake router so no real
 * llama.cpp or GPU is needed. Warned about once, loudly, the same way
 * `LOXAIC_TSNET_BIN` is.
 */
export function binOverride(): string | null {
  const value = process.env.LOXAIC_LLAMA_SERVER_BIN;
  if (!value) return null;
  if (!overrideWarned) {
    overrideWarned = true;
    console.warn(`[llama] LOXAIC_LLAMA_SERVER_BIN is set — running ${value} instead of an installed llama.cpp. Test use only.`);
  }
  return value;
}

export function manifestBuild(flavour: BuildFlavour): RuntimeBuild | null {
  return RUNTIME_MANIFEST.builds[buildKey(flavour)] ?? null;
}

function installDirFor(flavour: BuildFlavour): string {
  return path.join(runtimeDir(), `${RUNTIME_MANIFEST.tag}-${flavour}`);
}

/** Find the server binary inside an unpacked archive — the macOS and Linux
 * tarballs nest it one directory down (`llama-b11149/llama-server`), the
 * Windows zips do not. */
async function findServerBin(dir: string, depth = 0): Promise<string | null> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const e of entries) if (e.isFile() && e.name === SERVER_BIN) return path.join(dir, e.name);
  if (depth >= 2) return null;
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const found = await findServerBin(path.join(dir, e.name), depth + 1);
    if (found) return found;
  }
  return null;
}

/** The pinned build for `flavour`, if it is fully installed. */
export async function installedRuntime(flavour: BuildFlavour): Promise<InstalledRuntime | null> {
  const dir = installDirFor(flavour);
  try {
    const marker = JSON.parse(await readFile(path.join(dir, COMPLETE_MARKER), "utf8")) as { bin?: string };
    if (typeof marker.bin !== "string") return null;
    const bin = path.join(dir, marker.bin);
    if (!existsSync(bin)) return null;
    return { key: buildKey(flavour), tag: RUNTIME_MANIFEST.tag, flavour, dir, bin };
  } catch {
    return null;
  }
}

/** Whether *any* build was ever installed here — which is what makes a missing
 * pinned build an upgrade to fetch on its own, rather than a first install
 * waiting for an admin. */
export async function anyRuntimeInstalled(): Promise<boolean> {
  const entries = await readdir(runtimeDir()).catch(() => [] as string[]);
  for (const name of entries) {
    if (existsSync(path.join(runtimeDir(), name, COMPLETE_MARKER))) return true;
  }
  return false;
}

/** Where releases are downloaded from. Read at call time: tests point it at a
 * local server serving a fixture archive. */
function releasesBase(): string {
  return (process.env.LLAMA_RELEASES_URL ?? "https://github.com/ggml-org/llama.cpp/releases/download").replace(/\/+$/, "");
}

async function download(
  asset: RuntimeAsset,
  dest: string,
  onBytes: (n: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  const url = `${releasesBase()}/${RUNTIME_MANIFEST.tag}/${asset.name}`;
  let res: Response;
  try {
    res = await fetch(url, { signal, headers: { "User-Agent": "loxaic" } });
  } catch (err) {
    if (signal?.aborted) throw err;
    throw new RuntimeInstallError(`Could not download llama.cpp (${asset.name}): ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res.ok || !res.body) {
    throw new RuntimeInstallError(`Downloading llama.cpp failed: ${asset.name} answered HTTP ${String(res.status)}`);
  }
  const hash = createHash("sha256");
  const body = Readable.fromWeb(res.body as unknown as WebReadableStream<Uint8Array>);
  const tap = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      hash.update(chunk);
      onBytes(chunk.length);
      cb(null, chunk);
    },
  });
  await pipeline(body, tap, createWriteStream(dest), { signal });
  const actual = hash.digest("hex");
  if (actual !== asset.sha256) {
    await rm(dest, { force: true });
    // Never unpacked, never run. The likeliest cause is a proxy rewriting the
    // response; the other one is exactly what the check is for.
    throw new RuntimeInstallError(
      `The downloaded llama.cpp (${asset.name}) did not match its recorded checksum, so it was discarded and not run.`,
    );
  }
}

function extract(archive: string, into: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile("tar", ["-xf", archive, "-C", into], { timeout: 5 * 60_000, windowsHide: true }, (err, _out, stderr) => {
      if (err) reject(new RuntimeInstallError(`Unpacking llama.cpp failed: ${stderr.trim() || err.message}`));
      else resolve();
    });
  });
}

/**
 * Download, verify, unpack and move a build into place. Idempotent: an
 * installed build is returned as is. Concurrent callers share one install.
 */
const inflight = new Map<string, Promise<InstalledRuntime>>();

export function installRuntime(
  flavour: BuildFlavour,
  onProgress: (p: InstallProgress) => void = () => undefined,
  /** Test seam: install this build instead of the manifest's. */
  build: RuntimeBuild | null = manifestBuild(flavour),
): Promise<InstalledRuntime> {
  const key = buildKey(flavour);
  const existing = inflight.get(key);
  if (existing) return existing;
  const job = doInstall(flavour, onProgress, build).finally(() => inflight.delete(key));
  inflight.set(key, job);
  return job;
}

async function doInstall(
  flavour: BuildFlavour,
  onProgress: (p: InstallProgress) => void,
  build: RuntimeBuild | null,
): Promise<InstalledRuntime> {
  const already = await installedRuntime(flavour);
  if (already) return already;
  if (!build) {
    throw new RuntimeInstallError(
      `llama.cpp publishes no ${flavour} build for ${process.platform}/${process.arch}.`,
    );
  }
  const root = runtimeDir();
  await mkdir(root, { recursive: true });
  const scratch = path.join(root, `.install-${randomBytes(6).toString("hex")}`);
  const staging = path.join(scratch, "unpacked");
  await mkdir(staging, { recursive: true });
  try {
    const assets = [build.asset, ...(build.extra ? [build.extra] : [])];
    const totalBytes = assets.reduce((n, a) => n + a.size, 0);
    let doneBytes = 0;
    onProgress({ doneBytes, totalBytes });
    for (const asset of assets) {
      const file = path.join(scratch, asset.name);
      await download(asset, file, (n) => {
        doneBytes += n;
        onProgress({ doneBytes, totalBytes });
      });
      await extract(file, staging);
      await rm(file, { force: true });
    }
    const bin = await findServerBin(staging);
    if (!bin) throw new RuntimeInstallError(`The ${flavour} build of llama.cpp contained no ${SERVER_BIN}.`);
    if (process.platform !== "win32") await chmod(bin, 0o755);
    // The Windows CUDA runtime libraries must sit beside the binary, and the
    // cudart zip is flat — move its DLLs next to llama-server if they landed
    // elsewhere.
    const binDir = path.dirname(bin);
    if (build.extra && binDir !== staging) {
      for (const e of await readdir(staging)) {
        if (e.toLowerCase().endsWith(".dll")) await rename(path.join(staging, e), path.join(binDir, e));
      }
    }
    await writeFile(
      path.join(staging, COMPLETE_MARKER),
      JSON.stringify({ tag: RUNTIME_MANIFEST.tag, flavour, bin: path.relative(staging, bin) }),
    );
    const target = installDirFor(flavour);
    await rm(target, { recursive: true, force: true });
    await rename(staging, target);
    const installed = await installedRuntime(flavour);
    if (!installed) throw new RuntimeInstallError("llama.cpp was unpacked but could not be found afterwards.");
    return installed;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/**
 * Remove every build except `keep`. Called only after `keep` has started and
 * answered its health check, so a bad upgrade never leaves nothing to run —
 * and so the disk does not fill with one ~30–500 MB build per llama.cpp bump.
 */
export async function pruneRuntimes(keep: InstalledRuntime): Promise<void> {
  const root = runtimeDir();
  const entries = await readdir(root).catch(() => [] as string[]);
  for (const name of entries) {
    const full = path.join(root, name);
    // An install in progress for another flavour is not ours to remove.
    if (full === keep.dir || name.startsWith(".install-")) continue;
    const s = await stat(full).catch(() => null);
    if (!s?.isDirectory()) continue;
    await rm(full, { recursive: true, force: true }).catch(() => undefined);
  }
}

export { RUNTIME_MANIFEST };
