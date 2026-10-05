import { readCapped } from "./hf.ts";
import { fakeHardwareMode, buildKey, type BuildFlavour } from "./hardware.ts";
import { matchAssets, OFFICIAL_TAG, type ReleaseAsset } from "./runtime-assets.ts";
import { RUNTIME_MANIFEST } from "./runtime-manifest.ts";
import type { RuntimeBuild } from "./runtime-types.ts";

/**
 * llama.cpp's official releases, for the version picker.
 *
 * Read from GitHub's API without a token: 60 requests an hour per address,
 * which a picker that pages through releases can spend. So every answer is
 * cached with its ETag and revalidated (a 304 does not count against the
 * limit), and when GitHub refuses, the last answer is served with a note
 * saying when to try again — a list that may be a little old is more use than
 * an error.
 *
 * Nothing here downloads a build. It answers what exists, whether this machine
 * has a build of it, and whether GitHub publishes the checksum that build will
 * be verified against before it is unpacked. A release without one is listed
 * and cannot be installed: "verified before it is run" holds for every
 * official build, bundled or chosen.
 */

const PAGE_SIZE = 30;
/** A page of thirty releases, each with a few dozen assets, is about 1.5 MB. */
const MAX_BYTES = 16 * 1024 * 1024;
const TIMEOUT_MS = 15_000;
/** Served without asking again inside this window. */
const FRESH_MS = 10 * 60_000;

export class ReleasesError extends Error {
  readonly status: number;
  constructor(message: string, status = 502) {
    super(message);
    this.name = "ReleasesError";
    this.status = status;
  }
}

/** Read at call time: tests and the e2e lane point it at a local server. */
function apiBase(): string {
  return (process.env.LLAMA_RELEASES_API_URL ?? "https://api.github.com/repos/ggml-org/llama.cpp").replace(/\/+$/, "");
}

/**
 * The manifest key releases are matched against for this machine. Under the
 * test-only fake hardware the flavour is `vulkan` whatever the host is, and a
 * Mac has no Vulkan build to find — so the fake machine is a fixed one.
 */
export function assetKey(flavour: BuildFlavour): string {
  return fakeHardwareMode() !== null ? buildKey(flavour, "linux", "x64") : buildKey(flavour);
}

interface ApiRelease {
  tag_name?: unknown;
  name?: unknown;
  prerelease?: unknown;
  draft?: unknown;
  published_at?: unknown;
  assets?: unknown;
}

export type ReleaseAvailability = "ok" | "no-build" | "no-checksum";

export interface ReleaseRow {
  tag: string;
  publishedAt: string | null;
  /** GitHub's own flag: llama.cpp marks a preview or beta release with it. */
  prerelease: boolean;
  availability: ReleaseAvailability;
  /** What would be downloaded, when there is something to download. */
  sizeBytes: number | null;
  /** The build this version of Loxaic pins. */
  bundled: boolean;
}

export interface ReleasePage {
  releases: ReleaseRow[];
  hasMore: boolean;
  /** Set when GitHub would not answer and this is an earlier answer. */
  stale: { since: string; retryAt: string | null } | null;
}

interface Cached {
  etag: string | null;
  body: unknown;
  at: number;
}

const cache = new Map<string, Cached>();
const MAX_CACHED = 64;

function remember(url: string, entry: Cached): void {
  cache.delete(url);
  cache.set(url, entry);
  while (cache.size > MAX_CACHED) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

interface Fetched {
  body: unknown;
  stale: ReleasePage["stale"];
  status: number;
}

/** GET a JSON document from the API through the cache. A 404 is returned as
 * its status, never thrown: "no such release" is an answer. */
async function apiGet(url: string): Promise<Fetched> {
  const had = cache.get(url);
  if (had && Date.now() - had.at < FRESH_MS) return { body: had.body, stale: null, status: 200 };
  const staleAnswer = (retryAt: string | null): Fetched | null =>
    had ? { body: had.body, stale: { since: new Date(had.at).toISOString(), retryAt }, status: 200 } : null;

  const controller = new AbortController();
  const timer = setTimeout(() => { controller.abort(); }, TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      // Never followed: the API does not redirect a listing, and a redirect
      // would move a request we cap and time somewhere we did not choose.
      redirect: "error",
      headers: {
        "User-Agent": "loxaic",
        Accept: "application/vnd.github+json",
        ...(had?.etag ? { "If-None-Match": had.etag } : {}),
      },
    });
    if (res.status === 304 && had) {
      await res.body?.cancel().catch(() => undefined);
      remember(url, { ...had, at: Date.now() });
      return { body: had.body, stale: null, status: 200 };
    }
    if (res.status === 404) {
      await res.body?.cancel().catch(() => undefined);
      return { body: null, stale: null, status: 404 };
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      const limited = res.status === 403 || res.status === 429;
      const reset = Number(res.headers.get("x-ratelimit-reset"));
      const retryAt = limited && Number.isFinite(reset) && reset > 0 ? new Date(reset * 1000).toISOString() : null;
      const fallback = staleAnswer(retryAt);
      if (fallback) return fallback;
      throw new ReleasesError(
        limited
          ? `GitHub is not answering right now: this server has asked for llama.cpp's releases too often.${
              retryAt ? ` Try again after ${new Date(retryAt).toISOString().slice(11, 16)} UTC.` : " Try again in a while."
            }`
          : `GitHub answered HTTP ${String(res.status)} for llama.cpp's releases.`,
        limited ? 429 : 502,
      );
    }
    const { text, truncated } = await readCapped(res, MAX_BYTES);
    if (truncated) throw new ReleasesError("GitHub's list of llama.cpp releases was larger than expected, so it was not read.");
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new ReleasesError("GitHub's list of llama.cpp releases could not be read.");
    }
    remember(url, { etag: res.headers.get("etag"), body, at: Date.now() });
    return { body, stale: null, status: 200 };
  } catch (err) {
    if (err instanceof ReleasesError) throw err;
    const fallback = staleAnswer(null);
    if (fallback) return fallback;
    // The code only: undici's own message can carry an address.
    const code = (err as { cause?: { code?: string } }).cause?.code;
    throw new ReleasesError(`Could not reach GitHub for llama.cpp's releases${code ? ` (${code})` : ""}.`, 0);
  } finally {
    clearTimeout(timer);
  }
}

function assetsOf(raw: unknown): ReleaseAsset[] {
  if (!Array.isArray(raw)) return [];
  const out: ReleaseAsset[] = [];
  for (const a of raw as Record<string, unknown>[]) {
    if (typeof a.name !== "string" || typeof a.size !== "number") continue;
    out.push({ name: a.name, size: a.size, digest: typeof a.digest === "string" ? a.digest : null });
  }
  return out;
}

function rowOf(raw: ApiRelease, key: string): ReleaseRow | null {
  // Only `b<number>` tags: the tag becomes a directory name and part of a
  // download address, and llama.cpp's earliest releases used other shapes
  // with no builds this server could run anyway.
  if (typeof raw.tag_name !== "string" || !OFFICIAL_TAG.test(raw.tag_name) || raw.draft === true) return null;
  const match = matchAssets(raw.tag_name, assetsOf(raw.assets), key);
  return {
    tag: raw.tag_name,
    publishedAt: typeof raw.published_at === "string" ? raw.published_at : null,
    prerelease: raw.prerelease === true,
    availability: match.status,
    sizeBytes: match.status === "ok" ? match.build.asset.size + (match.build.extra?.size ?? 0) : null,
    bundled: raw.tag_name === RUNTIME_MANIFEST.tag,
  };
}

/** One page of releases, newest first, as GitHub orders them. */
export async function listReleases(page: number, flavour: BuildFlavour): Promise<ReleasePage> {
  const n = Number.isInteger(page) && page >= 1 && page <= 500 ? page : 1;
  const { body, stale, status } = await apiGet(`${apiBase()}/releases?per_page=${String(PAGE_SIZE)}&page=${String(n)}`);
  if (status === 404 || !Array.isArray(body)) return { releases: [], hasMore: false, stale };
  const key = assetKey(flavour);
  return {
    releases: body.flatMap((r: ApiRelease) => rowOf(r, key) ?? []),
    // A full page from GitHub means there may be another, whatever we kept.
    hasMore: body.length >= PAGE_SIZE,
    stale,
  };
}

/** One release by its tag, or null when llama.cpp has no such release. */
export async function findRelease(tag: string, flavour: BuildFlavour): Promise<{ row: ReleaseRow | null; stale: ReleasePage["stale"] }> {
  if (!OFFICIAL_TAG.test(tag)) return { row: null, stale: null };
  const { body, stale, status } = await apiGet(`${apiBase()}/releases/tags/${tag}`);
  if (status === 404 || typeof body !== "object" || body === null) return { row: null, stale };
  return { row: rowOf(body, assetKey(flavour)), stale };
}

/**
 * What to download for `tag` on this machine, with the checksums it will be
 * verified against. The bundled tag answers from the manifest in the
 * repository — reviewed, and needing no network.
 */
export async function releaseBuild(tag: string, flavour: BuildFlavour): Promise<RuntimeBuild> {
  if (!OFFICIAL_TAG.test(tag)) throw new ReleasesError(`"${tag}" is not a llama.cpp release tag.`, 400);
  if (tag === RUNTIME_MANIFEST.tag && fakeHardwareMode() === null) {
    const build = RUNTIME_MANIFEST.builds[buildKey(flavour)] as RuntimeBuild | undefined;
    if (build) return build;
  }
  const { body, status } = await apiGet(`${apiBase()}/releases/tags/${tag}`);
  if (status === 404 || typeof body !== "object" || body === null) {
    throw new ReleasesError(`llama.cpp has no release ${tag}.`, 404);
  }
  const match = matchAssets(tag, assetsOf((body as ApiRelease).assets), assetKey(flavour));
  if (match.status === "no-build") {
    throw new ReleasesError(`llama.cpp ${tag} has no ${flavour} build for this machine.`, 409);
  }
  if (match.status === "no-checksum") {
    throw new ReleasesError(
      `GitHub publishes no checksum for llama.cpp ${tag}'s ${flavour} build, so it could not be verified and was not downloaded.`,
      409,
    );
  }
  return match.build;
}

/** Test seam. */
export function __resetReleasesForTest(): void {
  cache.clear();
}
