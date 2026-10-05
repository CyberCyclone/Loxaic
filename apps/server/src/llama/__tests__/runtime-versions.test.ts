import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import Fastify from "fastify";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { v4 as uuid } from "uuid";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { presetPath, runtimeDir } from "../paths.ts";
import { __resetReleasesForTest } from "../releases.ts";
import { __resetRouterForTest, runtimeView, type RuntimeView } from "../router.ts";
import { RUNTIME_MANIFEST } from "../runtime-manifest.ts";
import { __resetVersionDownloadsForTest } from "../runtime-versions.ts";
import { getRuntimeSelection } from "../settings.ts";

/**
 * Choosing which llama.cpp runs (#270), through the admin routes and the real
 * router module, against stand-ins for GitHub's API and its downloads. Each
 * mock release is an archive whose `llama-server` is a wrapper around the fake
 * router, so a chosen version is really downloaded, verified, unpacked and
 * started — and one of them is a build that refuses a setting Loxaic writes,
 * which is how an older release or a fork really fails.
 *
 * The settings row is deployment-wide and the database is shared, so this
 * suite's choices are keyed by its own `LOXAIC_INSTANCE_ID` and it ends back
 * on the bundled build with nothing added, which removes its entry.
 */

vi.mock("../../auth/middleware", () => ({
  authenticate: () => Promise.resolve("admin-versions-test"),
  requireAdmin: () => Promise.resolve("admin-versions-test"),
}));
const { adminLocalModelRoutes } = await import("../../routes/admin-local-models.ts");
const app = Fastify();
adminLocalModelRoutes(app);

const FAKE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../test-fixtures/fake-llama-server.mjs");
const dir = mkdtempSync(path.join(os.tmpdir(), "loxaic-versions-"));
const host = `test-versions-${uuid()}`;
const posix = process.platform !== "win32";

interface Archive {
  bytes: Buffer;
  sha: string;
}

/** A release archive: `llama-<name>/llama-server`, a script that runs the
 * fake router saying it is `name`. */
function wrapperArchive(name: string, extraEnv = ""): Archive {
  const src = path.join(dir, `src-${name}`);
  mkdirSync(path.join(src, `llama-${name}`), { recursive: true });
  writeFileSync(
    path.join(src, `llama-${name}`, "llama-server"),
    `#!/bin/sh\nexport LOXAIC_FAKE_VERSION=${name}\n${extraEnv}\nexec "${process.execPath}" "${FAKE}" "$@"\n`,
    { mode: 0o755 },
  );
  return pack(name, src);
}

function pack(name: string, src: string): Archive {
  const out = path.join(dir, `${name}.tar.gz`);
  execFileSync("tar", ["-czf", out, "-C", src, "."]);
  const bytes = readFileSync(out);
  return { bytes, sha: createHash("sha256").update(bytes).digest("hex") };
}

const archives = new Map<string, Archive>();
let server: Server;
let base = "";

/** The mock releases, newest first. Asset names are the fixed fake machine's
 * (`linux-x64`), whatever this suite runs on. */
function releaseJson(tag: string, opts: { prerelease?: boolean; cpu?: boolean; digest?: boolean } = {}) {
  const asset = (name: string) => {
    const a = archives.get(`${tag}/${name}`);
    return { name, size: a?.bytes.length ?? 1, digest: opts.digest === false || !a ? null : `sha256:${a.sha}` };
  };
  return {
    tag_name: tag,
    prerelease: opts.prerelease === true,
    published_at: "2026-10-01T00:00:00Z",
    assets: [asset(`llama-${tag}-bin-ubuntu-vulkan-x64.tar.gz`), ...(opts.cpu ? [asset(`llama-${tag}-bin-ubuntu-x64.tar.gz`)] : [])],
  };
}

const RELEASES = () => [
  releaseJson("b9004", { prerelease: true }),
  releaseJson("b9003"),
  releaseJson("b9002"),
  releaseJson("b9001", { cpu: true }),
  releaseJson("b9000", { digest: false }),
];

async function until(what: string, pred: () => boolean | Promise<boolean>, ms = 15_000): Promise<void> {
  const end = Date.now() + ms;
  for (;;) {
    if (await pred()) return;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}: ${JSON.stringify({ state: runtimeView().state, reason: runtimeView().reason, downloads: runtimeView().versionDownloads })}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

const inject = (method: "GET" | "POST" | "DELETE" | "PATCH", url: string, payload?: unknown) =>
  app.inject({ method, url: `/v1/admin/local-models${url}`, ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }) });

interface VersionsAnswer {
  selected: { kind: string; tag?: string; id?: string };
  flavour: string | null;
  bundled: { tag: string; downloaded: boolean; inUse: boolean };
  official: {
    releases: { tag: string; prerelease: boolean; availability: string; downloaded: boolean; inUse: boolean; bundled: boolean }[];
    hasMore: boolean;
    unavailable: string | null;
    downloadedTags: string[];
  };
  customAllowed: boolean;
  custom: { id: string; name: string; host: string; backend: string; sha256: string | null; downloaded: boolean; inUse: boolean }[];
}

async function versions(query = ""): Promise<VersionsAnswer> {
  const res = await inject("GET", `/runtime/versions${query}`);
  expect(res.statusCode).toBe(200);
  return res.json<VersionsAnswer>();
}

const running = (): boolean => runtimeView().state === "running";

async function download(tag: string): Promise<void> {
  expect((await inject("POST", "/runtime/versions/download", { tag })).statusCode).toBe(200);
  await until(`${tag} to download`, async () => (await versions()).official.downloadedTags.includes(tag));
}

async function select(body: Record<string, unknown>): Promise<RuntimeView> {
  const res = await inject("POST", "/runtime/select", body);
  expect(res.statusCode, res.body).toBe(200);
  await until("the runtime to settle", () => ["running", "error", "needs-gpu"].includes(runtimeView().state) && runtimeView().restart === null);
  return runtimeView();
}

async function revert(): Promise<void> {
  expect((await inject("POST", "/runtime/revert")).statusCode).toBe(200);
  await until("the bundled build to run", () => running() && runtimeView().restart === null && runtimeView().version.kind === "bundled");
}

beforeAll(async () => {
  await app.ready();
  for (const tag of ["b9001", "b9004"]) archives.set(`${tag}/llama-${tag}-bin-ubuntu-vulkan-x64.tar.gz`, wrapperArchive(tag));
  archives.set("b9001/llama-b9001-bin-ubuntu-x64.tar.gz", wrapperArchive("b9001-cpu"));
  // A build that does not know a key Loxaic always writes.
  archives.set("b9002/llama-b9002-bin-ubuntu-vulkan-x64.tar.gz", wrapperArchive("b9002", "export LOXAIC_FAKE_REJECT_KEY=jinja"));
  // A build that cannot be run at all: not a program.
  const junk = path.join(dir, "src-junk");
  mkdirSync(junk, { recursive: true });
  writeFileSync(path.join(junk, "llama-server"), Buffer.from([0x00, 0x01, 0x02, 0x03, 0xff, 0xfe]), { mode: 0o755 });
  archives.set("b9003/llama-b9003-bin-ubuntu-vulkan-x64.tar.gz", pack("b9003", junk));
  archives.set("b9000/llama-b9000-bin-ubuntu-vulkan-x64.tar.gz", wrapperArchive("b9000"));
  archives.set("fork", wrapperArchive("fork-1.0"));

  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const send = (body: unknown, status = 200) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === "/repo/releases") {
      send(url.searchParams.get("page") === "1" ? RELEASES() : []);
      return;
    }
    const byTag = /^\/repo\/releases\/tags\/(.+)$/.exec(url.pathname);
    if (byTag) {
      const found = RELEASES().find((r) => r.tag_name === byTag[1]);
      if (found) send(found);
      else send({ message: "Not Found" }, 404);
      return;
    }
    const file = /^\/dl\/(.+)$/.exec(url.pathname);
    const archive = file ? archives.get(decodeURIComponent(file[1])) : url.pathname === "/fork.tar.gz" ? archives.get("fork") : undefined;
    if (archive) {
      res.writeHead(200, { "content-length": String(archive.bytes.length) });
      res.end(archive.bytes);
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  base = `http://127.0.0.1:${String(typeof addr === "object" && addr ? addr.port : 0)}`;

  vi.stubEnv("LOXAIC_INSTANCE_ID", host);
  vi.stubEnv("LLAMA_DIR", path.join(dir, "llama"));
  vi.stubEnv("LOXAIC_LLAMA_SERVER_BIN", FAKE);
  vi.stubEnv("LOXAIC_FAKE_HARDWARE", "gpu");
  vi.stubEnv("MOCK_INFERENCE", "false");
  vi.stubEnv("LLAMA_MODE", "managed");
  // This process adopts the stored settings row when it writes to it, and
  // that row is the developer's own: the backend is pinned so a choice made
  // on their Host models screen cannot decide what this suite runs.
  vi.stubEnv("LLAMA_BACKEND", "auto");
  vi.stubEnv("LLAMA_RUNTIME_TAG", "");
  vi.stubEnv("LLAMA_CUSTOM_RUNTIMES", "");
  vi.stubEnv("LLAMA_RELEASES_API_URL", `${base}/repo`);
  vi.stubEnv("LLAMA_RELEASES_URL", `${base}/dl`);
  __resetReleasesForTest();
  __resetVersionDownloadsForTest();
  await __resetRouterForTest();
  // The screen opening is what starts the runtime.
  await inject("GET", "");
  await until("the bundled build to run", running);
});

afterAll(async () => {
  // Leave the shared settings row as it was found: no entry for this host.
  vi.stubEnv("LLAMA_RUNTIME_TAG", "");
  vi.stubEnv("LLAMA_CUSTOM_RUNTIMES", "");
  await inject("POST", "/runtime/revert");
  for (const b of (await versions()).custom) await inject("DELETE", `/runtime/custom/${b.id}`);
  expect(getRuntimeSelection()).toMatchObject({ selected: { kind: "bundled" }, customBuilds: [] });
  await app.close();
  await __resetRouterForTest();
  await new Promise<void>((r) => server.close(() => { r(); }));
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!posix)("choosing a llama.cpp version", () => {
  it("starts on the bundled build, at the verbosity placement needs", () => {
    const view = runtimeView();
    expect(view.tag).toBe(RUNTIME_MANIFEST.tag);
    expect(view.version).toMatchObject({ kind: "bundled", tag: RUNTIME_MANIFEST.tag, bundledNewer: false, canRevert: false, envPinned: false });
    expect(readFileSync(presetPath(), "utf8")).toMatch(/^log-verbosity = 4$/m);
  });

  it("lists the releases, with pre-releases and what cannot be installed marked", async () => {
    const v = await versions("?page=1");
    expect(v.flavour).toBe("vulkan");
    expect(v.bundled).toMatchObject({ tag: RUNTIME_MANIFEST.tag, inUse: true });
    expect(v.official.releases.map((r) => [r.tag, r.prerelease, r.availability, r.downloaded])).toEqual([
      ["b9004", true, "ok", false],
      ["b9003", false, "ok", false],
      ["b9002", false, "ok", false],
      ["b9001", false, "ok", false],
      ["b9000", false, "no-checksum", false],
    ]);
    expect(v.official.downloadedTags).toEqual([]);
    // One release by its tag, with or without the "b"; and one that is not there.
    expect((await versions("?q=9004")).official.releases.map((r) => r.tag)).toEqual(["b9004"]);
    expect((await versions("?q=b9001")).official.releases.map((r) => r.tag)).toEqual(["b9001"]);
    expect((await versions("?q=b1")).official.releases).toEqual([]);
    expect((await versions("?q=..%2F..")).official.releases).toEqual([]);
  });

  it("will not switch to a version that is not downloaded, and downloading one disturbs nothing", async () => {
    const refused = await inject("POST", "/runtime/select", { kind: "official", tag: "b9001" });
    expect(refused.statusCode).toBe(409);
    expect(refused.json<{ error: string }>().error).toMatch(/Download this version first/);
    await download("b9001");
    expect(running()).toBe(true);
    expect(runtimeView().version.kind).toBe("bundled");
    const v = await versions();
    expect(v.official.releases.find((r) => r.tag === "b9001")).toMatchObject({ downloaded: true, inUse: false });
  });

  it("refuses to download a release GitHub publishes no checksum for, and says why", async () => {
    expect((await inject("POST", "/runtime/versions/download", { tag: "b9000" })).statusCode).toBe(200);
    await until("the refusal", () => runtimeView().versionDownloads.some((d) => d.tag === "b9000" && d.error !== null));
    expect(runtimeView().versionDownloads.find((d) => d.tag === "b9000")?.error).toMatch(/no checksum/);
    expect(existsSync(path.join(runtimeDir(), "b9000-vulkan"))).toBe(false);
    expect((await inject("POST", "/runtime/versions/download", { tag: "latest" })).statusCode).toBe(400);
  });

  it("switches to a downloaded version: it is what runs, and it runs at llama.cpp's own verbosity", async () => {
    const view = await select({ kind: "official", tag: "b9001" });
    expect(view.state).toBe("running");
    expect(view.tag).toBe("b9001");
    expect(view.version).toMatchObject({ kind: "official", tag: "b9001", reported: "b9001", bundledNewer: true, canRevert: true });
    // Only the bundled release's log is known to carry no prompt text at 4.
    expect(readFileSync(presetPath(), "utf8")).not.toMatch(/log-verbosity/);
    const v = await versions();
    expect(v.bundled.inUse).toBe(false);
    expect(v.official.releases.find((r) => r.tag === "b9001")).toMatchObject({ downloaded: true, inUse: true });
  });

  it("will not remove the version in use, nor the bundled one", async () => {
    const inUse = await inject("DELETE", "/runtime/versions?tag=b9001");
    expect(inUse.statusCode).toBe(409);
    expect(inUse.json<{ error: string }>().error).toMatch(/in use/);
    expect((await inject("DELETE", `/runtime/versions?tag=${RUNTIME_MANIFEST.tag}`)).statusCode).toBe(409);
    expect(existsSync(path.join(runtimeDir(), "b9001-vulkan"))).toBe(true);
  });

  it("fetches the chosen release's other build when the backend changes", async () => {
    vi.stubEnv("LLAMA_BACKEND", "cpu");
    expect((await inject("POST", "/runtime/restart")).statusCode).toBe(200);
    await until("the CPU build to run", () => running() && runtimeView().restart === null && runtimeView().flavour === "cpu");
    expect(runtimeView().version).toMatchObject({ kind: "official", tag: "b9001", reported: "b9001-cpu" });
    expect(existsSync(path.join(runtimeDir(), "b9001-cpu"))).toBe(true);
    vi.stubEnv("LLAMA_BACKEND", "auto");
    await inject("POST", "/runtime/restart");
    await until("the GPU build to run again", () => running() && runtimeView().restart === null && runtimeView().flavour === "vulkan");
  });

  it("leaves a chosen version that will not start failed, with llama.cpp's reason, and does not retry it", async () => {
    await download("b9002");
    const view = await select({ kind: "official", tag: "b9002" });
    expect(view.state).toBe("error");
    expect(view.reason).toMatch(/option 'jinja' not recognized in preset/);
    expect(view.reason).not.toMatch(/Restarting in/);
    expect(view.version).toMatchObject({ kind: "official", tag: "b9002", canRevert: true });
    // The crash loop would have started it again within a second.
    await new Promise((r) => setTimeout(r, 2500));
    expect(runtimeView()).toMatchObject({ state: "error", restart: null });
    expect(runtimeView().reason).toMatch(/option 'jinja' not recognized/);
    // Nothing fell back by itself: the choice is still the admin's.
    expect(getRuntimeSelection().selected).toEqual({ kind: "official", tag: "b9002" });
  });

  it("switches back to the bundled version in one step", async () => {
    await revert();
    expect(runtimeView().tag).toBe(RUNTIME_MANIFEST.tag);
    expect(runtimeView().version.canRevert).toBe(false);
    expect(readFileSync(presetPath(), "utf8")).toMatch(/^log-verbosity = 4$/m);
    // Now it can go.
    expect((await inject("DELETE", "/runtime/versions?tag=b9002")).statusCode).toBe(200);
    expect(existsSync(path.join(runtimeDir(), "b9002-vulkan"))).toBe(false);
    expect((await versions()).official.downloadedTags).toEqual(["b9001"]);
  });

  it("says a build that cannot be run cannot be run, rather than that there is no GPU", async () => {
    await download("b9003");
    const view = await select({ kind: "official", tag: "b9003" });
    expect(view.state).toBe("error");
    expect(view.reason).toMatch(/could not be run on this machine/);
    expect(view.reason).not.toMatch(/found no GPU/);
    await revert();
  });

  it("honours LLAMA_RUNTIME_TAG and refuses to change it from the API", async () => {
    vi.stubEnv("LLAMA_RUNTIME_TAG", "b9001");
    expect(runtimeView().version).toMatchObject({ kind: "official", tag: "b9001", envPinned: true, canRevert: false });
    for (const res of [await inject("POST", "/runtime/select", { kind: "bundled" }), await inject("POST", "/runtime/revert")]) {
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ envOverride: true });
    }
    vi.stubEnv("LLAMA_RUNTIME_TAG", "nonsense");
    expect(runtimeView().version).toMatchObject({ kind: "bundled", envPinned: false });
    vi.stubEnv("LLAMA_RUNTIME_TAG", "");
  });
});

describe.skipIf(!posix)("third-party builds", () => {
  const add = (body: Record<string, unknown>) => inject("POST", "/runtime/custom", body);
  let forkId = "";

  it("validates what is added", async () => {
    const ok = { name: "Fork", url: `${base}/fork.tar.gz`, backend: "vulkan" };
    const bad: Record<string, unknown>[] = [
      { ...ok, name: "" },
      { ...ok, name: "x".repeat(61) },
      { ...ok, url: "http://example.com/fork.tar.gz" },
      { ...ok, url: "https://user:pw@example.com/fork.tar.gz" },
      { ...ok, url: "file:///etc/passwd" },
      { ...ok, sha256: "abc" },
      { ...ok, backend: "auto" },
      { ...ok, backend: "cpu" },
    ];
    for (const body of bad) expect((await add(body)).statusCode, JSON.stringify(body)).toBe(400);
    expect((await versions()).custom).toEqual([]);
  });

  it("keeps a build whose hash is not the one given, with the reason, and never unpacks it", async () => {
    const res = await add({ name: "Wrong hash", url: `${base}/fork.tar.gz`, backend: "vulkan", sha256: "0".repeat(64) });
    expect(res.statusCode).toBe(201);
    await until("the refusal", () => runtimeView().versionDownloads.some((d) => d.kind === "custom" && d.error !== null));
    const [build] = (await versions()).custom;
    expect(build).toMatchObject({ name: "Wrong hash", downloaded: false, sha256: null });
    expect(runtimeView().versionDownloads.find((d) => d.customId === build.id)?.error).toMatch(/did not match its recorded checksum/);
    expect(existsSync(path.join(runtimeDir(), `custom-${build.id}`))).toBe(false);
    expect((await inject("POST", "/runtime/select", { kind: "custom", id: build.id })).statusCode).toBe(409);
    expect((await inject("DELETE", `/runtime/custom/${build.id}`)).statusCode).toBe(200);
    expect((await versions()).custom).toEqual([]);
    expect(runtimeView().versionDownloads.filter((d) => d.kind === "custom")).toEqual([]);
  });

  it("downloads one with the right hash, records it, and shows where it came from but not the address", async () => {
    const sha = archives.get("fork")?.sha ?? "";
    const res = await add({ name: "  Fork\n1.0 ", url: `${base}/fork.tar.gz?token=SECRET`, backend: "vulkan", sha256: `sha256:${sha.toUpperCase()}` });
    expect(res.statusCode).toBe(201);
    await until("the fork to download", async () => Boolean((await versions()).custom.at(0)?.downloaded));
    const raw = (await inject("GET", "/runtime/versions")).body;
    expect(raw).not.toContain("SECRET");
    const [build] = (await versions()).custom;
    expect(build).toMatchObject({ name: "Fork 1.0", host: new URL(base).host, backend: "vulkan", sha256: sha, inUse: false });
    forkId = build.id;
  });

  it("runs it when chosen, under its own name, and will not remove it while it is", async () => {
    const view = await select({ kind: "custom", id: forkId });
    expect(view.state).toBe("running");
    expect(view.tag).toBe("Fork 1.0");
    expect(view.version).toMatchObject({ kind: "custom", name: "Fork 1.0", tag: null, reported: "fork-1.0", bundledNewer: false, canRevert: true });
    expect(readFileSync(presetPath(), "utf8")).not.toMatch(/log-verbosity/);
    expect((await versions()).custom[0]).toMatchObject({ inUse: true });
    expect((await inject("DELETE", `/runtime/custom/${forkId}`)).statusCode).toBe(409);
    expect((await inject("POST", "/runtime/select", { kind: "custom", id: "0".repeat(12) })).statusCode).toBe(404);
  });

  it("can be switched off by the operator: nothing is listed, added or run", async () => {
    vi.stubEnv("LLAMA_CUSTOM_RUNTIMES", "off");
    const v = await versions();
    expect(v).toMatchObject({ customAllowed: false, custom: [], selected: { kind: "bundled" } });
    expect(runtimeView().version).toMatchObject({ kind: "bundled", customAllowed: false });
    const res = await add({ name: "Fork", url: `${base}/fork.tar.gz`, backend: "vulkan" });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ envOverride: true });
    expect((await inject("POST", "/runtime/select", { kind: "custom", id: forkId })).statusCode).toBe(404);
    vi.stubEnv("LLAMA_CUSTOM_RUNTIMES", "");
  });

  it("is removed with its files once something else runs", async () => {
    await revert();
    expect((await inject("DELETE", `/runtime/custom/${forkId}`)).statusCode).toBe(200);
    expect(existsSync(path.join(runtimeDir(), `custom-${forkId}`))).toBe(false);
    expect((await versions()).custom).toEqual([]);
    expect((await inject("DELETE", `/runtime/custom/${forkId}`)).statusCode).toBe(404);
  });
});
