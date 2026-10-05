import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createWriteStream, existsSync } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, readFile, readlink, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { buildKey, type BuildFlavour } from "./hardware.ts";
import { runtimeDir } from "./paths.ts";
import { allowedBuildUrl, OFFICIAL_TAG } from "./runtime-assets.ts";
import { RUNTIME_MANIFEST } from "./runtime-manifest.ts";
import type { RuntimeAsset, RuntimeBuild } from "./runtime-types.ts";

/**
 * Installing the llama.cpp builds this server can run.
 *
 * Three sources. The **bundled** build is one pinned upstream release
 * (`runtime-manifest.ts`), verified against the sha256 recorded in the
 * repository — a new llama.cpp is a reviewed change to the manifest. An
 * **official** build is another release an admin chose (#270), verified
 * against the digest GitHub publishes for it; a release with no digest is not
 * installable, so every official build is checked before it is unpacked. A
 * **custom** build is an archive from an address an admin entered: there is no
 * publisher digest to hold it to, so it is checked against the admin's own
 * SHA-256 when they gave one, and what it hashed to is recorded either way.
 *
 * All three are downloaded to a scratch directory, verified, unpacked and
 * moved into place atomically, one directory per build. The binary is executed
 * by this server with the models it serves; nothing reaches `runtime/<name>`
 * that has not passed its check.
 *
 * Extraction uses the system `tar`: bsdtar on macOS and Windows 10+ reads zip
 * as well as tar.gz, and the Linux builds are tarballs, so no archive library
 * is added to the server for one call per install.
 */

const SERVER_BIN = process.platform === "win32" ? "llama-server.exe" : "llama-server";
const COMPLETE_MARKER = ".loxaic-complete.json";

export type RuntimeSourceKind = "bundled" | "official" | "custom";

export interface InstalledRuntime {
  /** The directory's name under `runtime/`, or `override` for the test seam. */
  key: string;
  /** The release tag; a custom build's own name. */
  tag: string;
  flavour: BuildFlavour;
  dir: string;
  bin: string;
  source: RuntimeSourceKind;
  /** Kept by `pruneRuntimes`: an admin downloaded or chose it. */
  pinned: boolean;
  /** What `--version` printed, once asked. `undefined` is "not asked yet",
   * null is "asked, and it said nothing we could read". */
  version?: string | null;
  /** The archive's sha256 — the main one, for a build of two archives. */
  sha256: string | null;
  customId?: string;
}

/** What to install. */
export type InstallSpec =
  | { kind: "bundled"; flavour: BuildFlavour; build: RuntimeBuild | null }
  | { kind: "official"; tag: string; flavour: BuildFlavour; build: RuntimeBuild }
  | { kind: "custom"; id: string; name: string; flavour: BuildFlavour; url: string; sha256: string | null };

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
 * the **bundled** build. **Test-only**: the e2e harness sets it to a fake
 * router so no real llama.cpp or GPU is needed. A version an admin chose is
 * installed and run as itself even so — that is how the same harness tests
 * choosing one. Warned about once, loudly, the same way `LOXAIC_TSNET_BIN` is.
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

const CUSTOM_ID = /^[0-9a-f]{12}$/;

/** The directory a build lives in. Both parts of an official name are
 * shape-checked here, because this name is joined to a path that is later
 * removed recursively. */
export function officialDirName(tag: string, flavour: BuildFlavour): string {
  if (!OFFICIAL_TAG.test(tag)) throw new RuntimeInstallError(`"${tag}" is not a llama.cpp release tag.`);
  return `${tag}-${flavour}`;
}

export function customDirName(id: string): string {
  if (!CUSTOM_ID.test(id)) throw new RuntimeInstallError("Not a third-party build id.");
  return `custom-${id}`;
}

function dirNameFor(spec: InstallSpec): string {
  if (spec.kind === "custom") return customDirName(spec.id);
  return officialDirName(spec.kind === "official" ? spec.tag : RUNTIME_MANIFEST.tag, spec.flavour);
}

/** Find the server binary inside an unpacked archive — the macOS and Linux
 * tarballs nest it one directory down (`llama-b11149/llama-server`), the
 * Windows zips do not, and a fork's archive may nest it a level further. */
async function findServerBin(dir: string, depth = 0): Promise<string | null> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const e of entries) if (e.isFile() && e.name === SERVER_BIN) return path.join(dir, e.name);
  if (depth >= 3) return null;
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const found = await findServerBin(path.join(dir, e.name), depth + 1);
    if (found) return found;
  }
  return null;
}

interface Marker {
  tag?: unknown;
  flavour?: unknown;
  bin?: unknown;
  source?: unknown;
  pinned?: unknown;
  version?: unknown;
  sha256?: unknown;
  customId?: unknown;
}

const FLAVOURS: readonly string[] = ["metal", "vulkan", "cuda12", "cuda13", "rocm", "cpu"];

/** The build in `runtime/<name>`, if it is fully installed. A marker written
 * before sources existed is a bundled build. */
async function installedAt(name: string): Promise<InstalledRuntime | null> {
  const dir = path.join(runtimeDir(), name);
  try {
    const marker = JSON.parse(await readFile(path.join(dir, COMPLETE_MARKER), "utf8")) as Marker;
    if (typeof marker.bin !== "string" || typeof marker.tag !== "string") return null;
    if (typeof marker.flavour !== "string" || !FLAVOURS.includes(marker.flavour)) return null;
    const bin = path.join(dir, marker.bin);
    if (!existsSync(bin)) return null;
    const source: RuntimeSourceKind = marker.source === "official" || marker.source === "custom" ? marker.source : "bundled";
    return {
      key: name,
      tag: marker.tag,
      flavour: marker.flavour as BuildFlavour,
      dir,
      bin,
      source,
      pinned: marker.pinned === true,
      ...(marker.version === undefined ? {} : { version: typeof marker.version === "string" ? marker.version : null }),
      sha256: typeof marker.sha256 === "string" ? marker.sha256 : null,
      ...(typeof marker.customId === "string" ? { customId: marker.customId } : {}),
    };
  } catch {
    return null;
  }
}

/** The bundled build for `flavour`, if it is fully installed. */
export function installedRuntime(flavour: BuildFlavour): Promise<InstalledRuntime | null> {
  return installedAt(officialDirName(RUNTIME_MANIFEST.tag, flavour));
}

export function installedOfficial(tag: string, flavour: BuildFlavour): Promise<InstalledRuntime | null> {
  return installedAt(officialDirName(tag, flavour));
}

export function installedCustom(id: string): Promise<InstalledRuntime | null> {
  return installedAt(customDirName(id));
}

/** Every build on this machine's disk. */
export async function listInstalledRuntimes(): Promise<InstalledRuntime[]> {
  const entries = await readdir(runtimeDir()).catch(() => [] as string[]);
  const out: InstalledRuntime[] = [];
  for (const name of entries) {
    if (name.startsWith(".")) continue;
    const found = await installedAt(name);
    if (found) out.push(found);
  }
  return out;
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

async function rewriteMarker(dir: string, change: (m: Record<string, unknown>) => void): Promise<void> {
  const file = path.join(dir, COMPLETE_MARKER);
  const marker = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
  change(marker);
  // Written beside and renamed: a marker cut short by a crash would turn an
  // installed build into one that has to be downloaded again.
  const tmp = `${file}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(tmp, JSON.stringify(marker));
  await rename(tmp, file);
}

/** Keep (or stop keeping) a build through `pruneRuntimes`. */
export async function setRuntimePinned(runtime: InstalledRuntime, pinned: boolean): Promise<void> {
  if (runtime.key === "override" || runtime.pinned === pinned) return;
  await rewriteMarker(runtime.dir, (m) => { m.pinned = pinned; });
  runtime.pinned = pinned;
}

/** Remember what a build said its version was, so it is asked once. */
export async function recordRuntimeVersion(runtime: InstalledRuntime, version: string | null): Promise<void> {
  runtime.version = version;
  if (runtime.key === "override") return;
  await rewriteMarker(runtime.dir, (m) => { m.version = version; }).catch(() => undefined);
}

/** Where official releases are downloaded from. Read at call time: tests
 * point it at a local server serving a fixture archive. */
function releasesBase(): string {
  return (process.env.LLAMA_RELEASES_URL ?? "https://github.com/ggml-org/llama.cpp/releases/download").replace(/\/+$/, "");
}

/** A transfer that sends nothing for this long is treated as dead — the rule
 * model downloads use, and the same variable so a test can see it. */
function stallMs(): number {
  const n = Number(process.env.LLAMA_DOWNLOAD_STALL_MS);
  return Number.isInteger(n) && n > 0 ? n : 60_000;
}

/** No llama.cpp build is anywhere near this; an address that keeps sending is
 * not a build. */
const MAX_CUSTOM_BYTES = 2 * 1024 ** 3;
const MAX_REDIRECTS = 5;

interface FetchOptions {
  url: string;
  dest: string;
  /** How the file is named to a person. */
  label: string;
  /** Verified against when set. */
  sha256: string | null;
  /** Bytes past this end the transfer. */
  maxBytes: number;
  /** A third-party address: every hop must be allowed, so redirects are
   * followed here rather than by `fetch`. */
  checkRedirects: boolean;
  onBytes: (n: number) => void;
  onTotal?: (n: number) => void;
}

/** Download one archive, hashing it as it arrives. Returns its sha256. */
async function fetchArchive(o: FetchOptions): Promise<string> {
  const controller = new AbortController();
  const idle = stallMs();
  // Held in an object: set from a timer, and read after awaits the type
  // checker would otherwise narrow it across.
  const stall = { hit: false };
  let timer = setTimeout(onStall, idle);
  function onStall(): void {
    stall.hit = true;
    controller.abort();
  }
  const alive = (): void => {
    clearTimeout(timer);
    timer = setTimeout(onStall, idle);
  };
  try {
    let url = o.url;
    let res: Response;
    for (let hop = 0; ; hop++) {
      try {
        res = await fetch(url, {
          signal: controller.signal,
          headers: { "User-Agent": "loxaic" },
          redirect: o.checkRedirects ? "manual" : "follow",
        });
      } catch (err) {
        if (stall.hit) throw new RuntimeInstallError(`Downloading ${o.label} stalled: nothing arrived for ${String(Math.round(idle / 1000))} s.`);
        // The code only: the message can carry the address, which for a
        // third-party build may hold a token in its query.
        const code = (err as { cause?: { code?: string } }).cause?.code;
        throw new RuntimeInstallError(`Could not download ${o.label}${code ? ` (${code})` : ""}.`);
      }
      alive();
      if (!o.checkRedirects || res.status < 300 || res.status >= 400) break;
      await res.body?.cancel().catch(() => undefined);
      const location = res.headers.get("location");
      if (!location || hop >= MAX_REDIRECTS) {
        throw new RuntimeInstallError(`Downloading ${o.label} failed: the address redirected too many times.`);
      }
      const next = new URL(location, url).toString();
      if (!allowedBuildUrl(next)) {
        throw new RuntimeInstallError(`Downloading ${o.label} failed: the address redirected somewhere that is not https, so it was not followed.`);
      }
      url = next;
    }
    if (!res.ok || !res.body) {
      await res.body?.cancel().catch(() => undefined);
      throw new RuntimeInstallError(`Downloading ${o.label} failed: the server answered HTTP ${String(res.status)}.`);
    }
    const declared = Number(res.headers.get("content-length"));
    if (Number.isInteger(declared) && declared > 0) {
      if (declared > o.maxBytes) {
        await res.body.cancel().catch(() => undefined);
        throw new RuntimeInstallError(`${o.label} is larger than expected, so it was not downloaded.`);
      }
      o.onTotal?.(declared);
    }
    const hash = createHash("sha256");
    let seen = 0;
    const body = Readable.fromWeb(res.body as unknown as WebReadableStream<Uint8Array>);
    const tap = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        seen += chunk.length;
        if (seen > o.maxBytes) {
          // Cut off in the stream, before it is written: a server that sends
          // more than it declared is not sending the file that was asked for.
          cb(new RuntimeInstallError(`${o.label} kept sending past its expected size, so the download was stopped.`));
          return;
        }
        alive();
        hash.update(chunk);
        o.onBytes(chunk.length);
        cb(null, chunk);
      },
    });
    try {
      await pipeline(body, tap, createWriteStream(o.dest), { signal: controller.signal });
    } catch (err) {
      await rm(o.dest, { force: true });
      if (err instanceof RuntimeInstallError) throw err;
      if (stall.hit) throw new RuntimeInstallError(`Downloading ${o.label} stalled: nothing arrived for ${String(Math.round(idle / 1000))} s.`);
      throw new RuntimeInstallError(`Downloading ${o.label} was cut off before it finished.`);
    }
    const actual = hash.digest("hex");
    if (o.sha256 !== null && actual !== o.sha256) {
      await rm(o.dest, { force: true });
      // Never unpacked, never run. The likeliest cause is a proxy rewriting the
      // response; the other one is exactly what the check is for.
      throw new RuntimeInstallError(`The downloaded ${o.label} did not match its recorded checksum, so it was discarded and not run.`);
    }
    return actual;
  } finally {
    clearTimeout(timer);
  }
}

/** Whether the file is an archive this platform's `tar` reads, by its first
 * bytes — never by its name, which for a third-party address is whatever the
 * link ends in. */
async function isArchive(file: string): Promise<boolean> {
  const fh = await open(file, "r");
  try {
    const head = Buffer.alloc(6);
    const { bytesRead } = await fh.read(head, 0, 6, 0);
    if (bytesRead < 4) return false;
    const gzip = head[0] === 0x1f && head[1] === 0x8b;
    const xz = head.subarray(0, 6).equals(Buffer.from([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]));
    const zip = head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04;
    // GNU tar on Linux does not read zip.
    return gzip || xz || (zip && process.platform !== "linux");
  } finally {
    await fh.close();
  }
}

function extract(archive: string, into: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // Neither tar follows an absolute path or a `..` out of `-C` without `-P`.
    // Ownership and modes are ours, not the archive's: a setuid bit in a
    // stranger's tarball is not something to carry onto this disk.
    const args = ["-xf", archive, "-C", into, "--no-same-owner", "--no-same-permissions"];
    execFile("tar", args, { timeout: 5 * 60_000, windowsHide: true }, (err, _out, stderr) => {
      if (err) reject(new RuntimeInstallError(`Unpacking llama.cpp failed: ${stderr.trim().slice(0, 300) || err.message}`));
      else resolve();
    });
  });
}

const MAX_ENTRIES = 50_000;

/**
 * Refuse an unpacked tree that holds anything but files, directories and
 * symlinks that stay inside it. The official macOS and Linux builds link
 * `libllama.dylib` to its versioned name, so links are normal; one pointing
 * at `/etc` or `../../models` is how an archive reaches outside the directory
 * it was unpacked into once something reads or deletes through it.
 */
async function assertContained(root: string): Promise<void> {
  let seen = 0;
  const walk = async (dir: string): Promise<void> => {
    for (const name of await readdir(dir)) {
      if (++seen > MAX_ENTRIES) throw new RuntimeInstallError("The archive holds too many files to be a llama.cpp build.");
      const full = path.join(dir, name);
      const s = await lstat(full);
      if (s.isSymbolicLink()) {
        const target = path.resolve(dir, await readlink(full));
        if (target !== root && !target.startsWith(root + path.sep)) {
          throw new RuntimeInstallError("The archive contains a link that leads outside it, so it was discarded and not run.");
        }
      } else if (s.isDirectory()) {
        await walk(full);
      } else if (!s.isFile()) {
        throw new RuntimeInstallError("The archive contains something that is not a file, so it was discarded and not run.");
      }
    }
  };
  await walk(root);
}

/**
 * Download, verify, unpack and move a build into place. Idempotent: an
 * installed build is returned as is. Concurrent callers share one install —
 * per directory, so two releases of one backend are two installs.
 */
const inflight = new Map<string, Promise<InstalledRuntime>>();

export function installSource(
  spec: InstallSpec,
  onProgress: (p: InstallProgress) => void = () => undefined,
): Promise<InstalledRuntime> {
  const name = dirNameFor(spec);
  const existing = inflight.get(name);
  if (existing) return existing;
  const job = doInstall(spec, name, onProgress).finally(() => inflight.delete(name));
  inflight.set(name, job);
  return job;
}

/** Whether `runtime/<name>` is being installed right now. */
export function installing(name: string): boolean {
  return inflight.has(name);
}

/** The bundled build for `flavour`. */
export function installRuntime(
  flavour: BuildFlavour,
  onProgress: (p: InstallProgress) => void = () => undefined,
  /** Test seam: install this build instead of the manifest's. */
  build: RuntimeBuild | null = manifestBuild(flavour),
): Promise<InstalledRuntime> {
  return installSource({ kind: "bundled", flavour, build }, onProgress);
}

function officialUrl(tag: string, asset: RuntimeAsset): string {
  return `${releasesBase()}/${tag}/${encodeURIComponent(asset.name)}`;
}

async function doInstall(
  spec: InstallSpec,
  name: string,
  onProgress: (p: InstallProgress) => void,
): Promise<InstalledRuntime> {
  const already = await installedAt(name);
  if (already) return already;
  const flavour = spec.flavour;
  const build = spec.kind === "custom" ? null : spec.build;
  if (spec.kind !== "custom" && !build) {
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
    let doneBytes = 0;
    let totalBytes = 0;
    const onBytes = (n: number): void => {
      doneBytes += n;
      onProgress({ doneBytes, totalBytes });
    };
    let sha256: string | null = null;
    let hasExtra = false;
    if (spec.kind === "custom") {
      onProgress({ doneBytes, totalBytes });
      const file = path.join(scratch, "build.archive");
      sha256 = await fetchArchive({
        url: spec.url,
        dest: file,
        label: `"${spec.name}"`,
        sha256: spec.sha256,
        maxBytes: MAX_CUSTOM_BYTES,
        checkRedirects: true,
        onBytes,
        onTotal: (n) => { totalBytes = n; },
      });
      if (!(await isArchive(file))) {
        throw new RuntimeInstallError(
          process.platform === "linux"
            ? `"${spec.name}" is not a .tar.gz or .tar.xz archive, so it was not unpacked.`
            : `"${spec.name}" is not a .tar.gz, .tar.xz or .zip archive, so it was not unpacked.`,
        );
      }
      await extract(file, staging);
      await rm(file, { force: true });
    } else if (build) {
      const tag = spec.kind === "official" ? spec.tag : RUNTIME_MANIFEST.tag;
      const assets = [build.asset, ...(build.extra ? [build.extra] : [])];
      hasExtra = Boolean(build.extra);
      totalBytes = assets.reduce((n, a) => n + a.size, 0);
      onProgress({ doneBytes, totalBytes });
      sha256 = build.asset.sha256;
      for (const asset of assets) {
        // The name comes from GitHub's listing for a chosen release; it is
        // only ever joined to the scratch directory as a single segment.
        const file = path.join(scratch, path.basename(asset.name));
        await fetchArchive({
          url: officialUrl(tag, asset),
          dest: file,
          label: `llama.cpp (${asset.name})`,
          sha256: asset.sha256,
          maxBytes: asset.size,
          checkRedirects: false,
          onBytes,
        });
        await extract(file, staging);
        await rm(file, { force: true });
      }
    } else {
      throw new RuntimeInstallError("There is nothing to install.");
    }
    await assertContained(staging);
    const bin = await findServerBin(staging);
    if (!bin) {
      throw new RuntimeInstallError(
        spec.kind === "custom"
          ? `"${spec.name}" contains no ${SERVER_BIN}, so it is not a llama.cpp build this server can run.`
          : `The ${flavour} build of llama.cpp contained no ${SERVER_BIN}.`,
      );
    }
    if (process.platform !== "win32") await chmod(bin, 0o755);
    // The Windows CUDA runtime libraries must sit beside the binary, and the
    // cudart zip is flat — move its DLLs next to llama-server if they landed
    // elsewhere.
    const binDir = path.dirname(bin);
    if (hasExtra && binDir !== staging) {
      for (const e of await readdir(staging)) {
        if (e.toLowerCase().endsWith(".dll")) await rename(path.join(staging, e), path.join(binDir, e));
      }
    }
    await writeFile(
      path.join(staging, COMPLETE_MARKER),
      JSON.stringify({
        tag: spec.kind === "custom" ? spec.name : spec.kind === "official" ? spec.tag : RUNTIME_MANIFEST.tag,
        flavour,
        bin: path.relative(staging, bin),
        source: spec.kind,
        // An admin asked for this one by name; it stays until they remove it.
        pinned: spec.kind !== "bundled",
        sha256,
        ...(spec.kind === "custom" ? { customId: spec.id } : {}),
      }),
    );
    const target = path.join(root, name);
    await rm(target, { recursive: true, force: true });
    await rename(staging, target);
    const installed = await installedAt(name);
    if (!installed) throw new RuntimeInstallError("llama.cpp was unpacked but could not be found afterwards.");
    return installed;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/**
 * Remove the builds nothing needs any more. Called only after `keep` has
 * started and answered its health check, so a bad upgrade never leaves nothing
 * to run — and so the disk does not fill with one ~30–500 MB build per
 * llama.cpp bump.
 *
 * It used to remove every build but the running one. Now that an admin can
 * download several and switch between them, it keeps: the running build, any
 * build an admin downloaded or chose (`pinned`), the bundled release (what
 * "Switch back to the bundled version" needs, with no download in the way),
 * and anything still being installed. What is left is a superseded bundled
 * build, and directories with no marker at all.
 */
export async function pruneRuntimes(keep: InstalledRuntime): Promise<void> {
  const root = runtimeDir();
  const entries = await readdir(root).catch(() => [] as string[]);
  for (const name of entries) {
    const full = path.join(root, name);
    // An install in progress for another build is not ours to remove.
    if (full === keep.dir || name.startsWith(".install-") || inflight.has(name)) continue;
    const s = await stat(full).catch(() => null);
    if (!s?.isDirectory()) continue;
    const found = await installedAt(name);
    if (found && (found.pinned || (found.source !== "custom" && found.tag === RUNTIME_MANIFEST.tag))) continue;
    await rm(full, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Remove one build's files. The caller has made sure it is not running. */
export async function deleteRuntime(runtime: InstalledRuntime): Promise<void> {
  const root = runtimeDir();
  const full = path.resolve(root, runtime.key);
  // The name was shape-checked when it was built; asserted anyway, because
  // this is a recursive delete.
  if (path.dirname(full) !== root || runtime.key === "override") throw new RuntimeInstallError("Refusing to remove that directory.");
  await rm(full, { recursive: true, force: true });
}

export { RUNTIME_MANIFEST };
