import type { BuildFlavour } from "./hardware.ts";
import { releaseBuild } from "./releases.ts";
import {
  customDirName,
  installedCustom,
  installedOfficial,
  installedRuntime,
  installing,
  installSource,
  manifestBuild,
  officialDirName,
  RUNTIME_MANIFEST,
  RuntimeInstallError,
  setRuntimePinned,
  type InstalledRuntime,
  type InstallProgress,
  type InstallSpec,
} from "./runtime.ts";
import {
  getRuntimeSelection,
  recordCustomBuildHash,
  type CustomBackend,
  type CustomBuild,
  type RuntimeSelection,
} from "./settings.ts";

/**
 * The versions of llama.cpp an admin has downloaded or is downloading (#270),
 * between the settings that say which one is chosen and the installer that
 * puts one on disk.
 *
 * A download started from the picker runs in the background and never touches
 * the running router: choosing a version is a separate step, and the only one
 * that restarts anything.
 */

export interface VersionDownload {
  /** The directory being filled, which is what makes it one download. */
  key: string;
  kind: "official" | "custom";
  tag: string | null;
  customId: string | null;
  doneBytes: number;
  totalBytes: number;
  /** Still running. False with an `error` is a download that failed and is
   * kept so the picker can say why. */
  active: boolean;
  error: string | null;
}

const downloads = new Map<string, VersionDownload>();

/** Failed downloads kept so the picker can say why. Any `b<number>` can be
 * asked for, so without a bound each failure stayed for the life of the
 * process and rode every answer of the one-second poll (found in review). The
 * oldest failures go first; running downloads are never dropped. */
export const MAX_FAILED_DOWNLOADS = 8;

function keepFailure(key: string, d: VersionDownload): void {
  // Re-inserted so the map's order is the order of failure.
  downloads.delete(key);
  downloads.set(key, d);
  const failed = [...downloads.entries()].filter(([, v]) => !v.active);
  for (const [k] of failed.slice(0, Math.max(0, failed.length - MAX_FAILED_DOWNLOADS))) downloads.delete(k);
}

export function versionDownloads(): VersionDownload[] {
  return [...downloads.values()];
}

/** The flavour a third-party build runs as. The CUDA major is not something
 * an archive tells us and nothing depends on it: the flavour only says
 * whether a GPU is expected. */
export function customFlavour(backend: CustomBackend): BuildFlavour {
  return backend === "cuda" ? "cuda12" : backend;
}

export function findCustomBuild(id: string): CustomBuild | null {
  return getRuntimeSelection().customBuilds.find((b) => b.id === id) ?? null;
}

/** The directory a selection's build lives in, for `flavour`. */
export function selectionKey(selected: RuntimeSelection, flavour: BuildFlavour): string {
  if (selected.kind === "custom") return customDirName(selected.id);
  return officialDirName(selected.kind === "official" ? selected.tag : RUNTIME_MANIFEST.tag, flavour);
}

/** The installed build a selection names, or null when it has to be
 * downloaded first. */
export function installedForSelection(selected: RuntimeSelection, flavour: BuildFlavour): Promise<InstalledRuntime | null> {
  if (selected.kind === "custom") return installedCustom(selected.id);
  if (selected.kind === "official") return installedOfficial(selected.tag, flavour);
  return installedRuntime(flavour);
}

async function specFor(selected: RuntimeSelection, flavour: BuildFlavour): Promise<InstallSpec> {
  if (selected.kind === "bundled") return { kind: "bundled", flavour, build: manifestBuild(flavour) };
  if (selected.kind === "official") {
    return { kind: "official", tag: selected.tag, flavour, build: await releaseBuild(selected.tag, flavour) };
  }
  const build = findCustomBuild(selected.id);
  if (!build) throw new RuntimeInstallError("That third-party build is no longer in the list.");
  return { kind: "custom", id: build.id, name: build.name, flavour, url: build.url, sha256: build.sha256Expected };
}

/**
 * Download and unpack what a selection names, reporting to the picker's
 * download list as well as to `onProgress`. Concurrent callers for one build
 * share the install (`installSource`), so choosing a version that is still
 * downloading waits for that download rather than starting another.
 */
export async function installSelection(
  selected: RuntimeSelection,
  flavour: BuildFlavour,
  onProgress: (p: InstallProgress) => void = () => undefined,
): Promise<InstalledRuntime> {
  const key = selectionKey(selected, flavour);
  const tracked = selected.kind !== "bundled";
  if (tracked) {
    const had = downloads.get(key);
    downloads.set(key, {
      key,
      kind: selected.kind,
      tag: selected.kind === "official" ? selected.tag : null,
      customId: selected.kind === "custom" ? selected.id : null,
      doneBytes: had?.active ? had.doneBytes : 0,
      totalBytes: had?.active ? had.totalBytes : 0,
      active: true,
      error: null,
    });
  }
  try {
    const spec = await specFor(selected, flavour);
    const installed = await installSource(spec, (p) => {
      const d = downloads.get(key);
      if (d) {
        d.doneBytes = p.doneBytes;
        d.totalBytes = p.totalBytes;
      }
      onProgress(p);
    });
    // The bundled release chosen by name shares the bundled build's directory;
    // choosing it is what makes it one to keep.
    if (tracked) await setRuntimePinned(installed, true).catch(() => undefined);
    if (selected.kind === "custom" && installed.sha256) {
      await recordCustomBuildHash(selected.id, installed.sha256).catch(() => undefined);
    }
    // Another caller may still be waiting on the same install.
    if (!installing(key)) downloads.delete(key);
    return installed;
  } catch (err) {
    const d = downloads.get(key);
    if (d) {
      d.active = false;
      d.error = err instanceof Error ? err.message : String(err);
      keepFailure(key, d);
    }
    throw err;
  }
}

/** Start a download from the picker. Returns at once; the outcome is in
 * `versionDownloads()`. */
export function startVersionDownload(selected: RuntimeSelection, flavour: BuildFlavour): void {
  void installSelection(selected, flavour).catch((err: unknown) => {
    console.warn(`[llama] downloading a llama.cpp version failed: ${err instanceof Error ? err.message : String(err)}`);
  });
}

/** Forget a failed download — the build was removed, or is being tried again. */
export function forgetVersionDownload(key: string): void {
  const d = downloads.get(key);
  if (d && !d.active) downloads.delete(key);
}

/** Whether release `a` is older than `b`. Tags are `b<number>`. */
export function olderTag(a: string, b: string): boolean {
  return Number(a.slice(1)) < Number(b.slice(1));
}

/** Test seam. */
export function __resetVersionDownloadsForTest(): void {
  downloads.clear();
}
