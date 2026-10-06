import type { RuntimeAsset, RuntimeBuild } from "./runtime-types.ts";

/**
 * Which of a llama.cpp release's assets is the build for a machine.
 *
 * Pure, and shared by the script that pins the bundled build
 * (`scripts/update-llama-runtime.mjs`) and the version picker, which has to
 * answer the same question for a release nobody reviewed. Matched by pattern
 * rather than by exact name because the names have moved over llama.cpp's
 * history: the CUDA minor in the file name changes (`cuda-12.4`, `cuda-12.8`),
 * and Linux builds were zips before they were tarballs.
 *
 * Everything here is erasable TypeScript with no imports of values, so the
 * `.mjs` script can import it under Node's own type stripping, and nothing
 * here reaches the database.
 */

/** A release asset as GitHub's API describes it. */
export interface ReleaseAsset {
  name: string;
  size: number;
  /** `sha256:<hex>`, or null on releases older than GitHub's asset digests. */
  digest: string | null;
}

interface AssetSpec {
  /** The part of the name after `llama-<tag>-bin-`, without the extension. */
  body: string;
  /** For Windows CUDA: the `cudart` archive of the same CUDA version, which
   * must be unpacked beside the binary. `$1` is the minor the body captured. */
  extra?: string;
}

/** Keyed `<platform>-<arch>-<flavour>`, the manifest's own keys. */
export const ASSET_SPECS: Readonly<Record<string, AssetSpec>> = {
  "darwin-arm64-metal": { body: "macos-arm64" },
  "darwin-arm64-cpu": { body: "macos-arm64" },
  "linux-x64-vulkan": { body: "ubuntu-vulkan-x64" },
  "linux-arm64-vulkan": { body: "ubuntu-vulkan-arm64" },
  "linux-x64-cuda12": { body: "ubuntu-cuda-12\\.\\d+-x64" },
  "linux-x64-cuda13": { body: "ubuntu-cuda-13\\.\\d+-x64" },
  "linux-arm64-cuda13": { body: "ubuntu-cuda-13\\.\\d+-arm64" },
  "linux-x64-rocm": { body: "ubuntu-rocm-\\d+\\.\\d+-x64" },
  "linux-x64-cpu": { body: "ubuntu-x64" },
  "linux-arm64-cpu": { body: "ubuntu-arm64" },
  "win32-x64-vulkan": { body: "win-vulkan-x64" },
  "win32-x64-cuda12": { body: "win-cuda-12\\.(\\d+)-x64", extra: "cudart-llama-bin-win-cuda-12.$1-x64.zip" },
  "win32-x64-cuda13": { body: "win-cuda-13\\.(\\d+)-x64", extra: "cudart-llama-bin-win-cuda-13.$1-x64.zip" },
  "win32-x64-rocm": { body: "win-rocm-\\d+\\.\\d+-x64" },
  "win32-x64-cpu": { body: "win-cpu-x64" },
};

/** An official release tag. Anything else never reaches a path or a URL. */
export const OFFICIAL_TAG = /^b\d{1,7}$/;

/**
 * The archive types this platform's `tar` can unpack. GNU tar on Linux does
 * not read zip, so an old release that only shipped zips has no build for a
 * Linux machine; bsdtar on macOS and Windows reads both.
 */
function extensions(platform: string): string {
  return platform === "linux" ? "\\.tar\\.gz" : "\\.(?:tar\\.gz|zip)";
}

export type AssetMatch =
  | { status: "ok"; build: RuntimeBuild }
  /** The release has no archive for this platform, architecture and backend. */
  | { status: "no-build" }
  /** It has one, but GitHub publishes no checksum for it, so it could not be
   * verified before it is run. */
  | { status: "no-checksum" };

function described(asset: ReleaseAsset): RuntimeAsset | null {
  const m = /^sha256:([0-9a-f]{64})$/.exec(asset.digest ?? "");
  if (!m || !Number.isInteger(asset.size) || asset.size <= 0) return null;
  return { name: asset.name, sha256: m[1], size: asset.size };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The build of release `tag` for `key`, from that release's asset list. */
export function matchAssets(tag: string, assets: readonly ReleaseAsset[], key: string): AssetMatch {
  const spec = ASSET_SPECS[key] as AssetSpec | undefined;
  if (!spec || !OFFICIAL_TAG.test(tag)) return { status: "no-build" };
  const platform = key.split("-")[0];
  const re = new RegExp(`^llama-${escapeRegExp(tag)}-bin-${spec.body}${extensions(platform)}$`);
  let main: ReleaseAsset | null = null;
  let captured: string | undefined;
  for (const a of assets) {
    const m = re.exec(a.name);
    if (!m) continue;
    // A tarball over a zip when a release carries both.
    if (!main || (a.name.endsWith(".tar.gz") && !main.name.endsWith(".tar.gz"))) {
      main = a;
      captured = m[1];
    }
  }
  if (!main) return { status: "no-build" };
  const asset = described(main);
  if (!asset) return { status: "no-checksum" };
  if (!spec.extra) return { status: "ok", build: { asset } };
  const extraName = spec.extra.replace("$1", captured ?? "");
  const extraAsset = assets.find((a) => a.name === extraName);
  if (!extraAsset) return { status: "no-build" };
  const extra = described(extraAsset);
  if (!extra) return { status: "no-checksum" };
  return { status: "ok", build: { asset, extra } };
}

/**
 * Where a third-party build may be fetched from: https, with no credentials in
 * the address (they would sit in the clear in the settings row and on the
 * admin screen). Asked of the address an admin enters and of every redirect on
 * the way to the archive.
 *
 * Deliberately no private-address guard, as for inference providers: this is
 * admin-only deployment configuration, a build mirrored on the LAN is a
 * reasonable thing to want, and the admin choosing it is already choosing what
 * this machine executes.
 */
export function allowedBuildUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.username || url.password) return false;
  if (url.protocol === "https:") return true;
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost";
  return url.protocol === "http:" && loopback && httpBuildsForTests();
}

let httpWarned = false;

/**
 * `LOXAIC_TEST_HTTP_BUILDS=1` lets a build come from loopback over plain http,
 * which is how the e2e lane serves its fixture archives. **Test-only**, and a
 * flag of its own: `LOXAIC_LLAMA_SERVER_BIN` used to stand in for it, but that
 * now replaces the bundled build only while chosen builds install and run for
 * real, so it no longer means "nothing real is fetched here". Found in review.
 */
function httpBuildsForTests(): boolean {
  if (process.env.LOXAIC_TEST_HTTP_BUILDS !== "1") return false;
  if (!httpWarned) {
    httpWarned = true;
    console.warn("[llama] LOXAIC_TEST_HTTP_BUILDS is set — llama.cpp builds may be fetched from loopback over plain http. Test use only.");
  }
  return true;
}
