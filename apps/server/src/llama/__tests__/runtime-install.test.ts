import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  __setDiskFreeForTest,
  deleteRuntime,
  installedCustom,
  installedOfficial,
  installedRuntime,
  installRuntime,
  installSource,
  listInstalledRuntimes,
  pruneRuntimes,
  RuntimeInstallError,
  RUNTIME_MANIFEST,
  setRuntimePinned,
} from "../runtime.ts";

/**
 * Installing a llama.cpp build: download, checksum, unpack, move into place.
 * Served from a local HTTP server (`LLAMA_RELEASES_URL`) with an archive built
 * here, shaped like upstream's — the binary one directory down.
 */

const dir = mkdtempSync(path.join(os.tmpdir(), "loxaic-rt-"));
const bin = process.platform === "win32" ? "llama-server.exe" : "llama-server";
let archive: Buffer;
let server: Server;
let requests = 0;
let base = "";
/** Other things the server can be asked for, by path. */
const routes = new Map<string, (res: import("node:http").ServerResponse) => void>();

/** A tar.gz of `files` (name → contents, or a link target as `{ link }`). */
function tarball(name: string, files: Record<string, string | { link: string }>): Buffer {
  const src = path.join(dir, `src-${name}`);
  for (const [file, content] of Object.entries(files)) {
    const full = path.join(src, file);
    mkdirSync(path.dirname(full), { recursive: true });
    if (typeof content === "string") writeFileSync(full, content);
    else symlinkSync(content.link, full);
  }
  const out = path.join(dir, `${name}.tar.gz`);
  execFileSync("tar", ["-czf", out, "-C", src, "."]);
  return readFileSync(out);
}

function serve(pathname: string, body: Buffer, headers: Record<string, string> = {}): string {
  routes.set(pathname, (res) => {
    res.writeHead(200, { "content-length": String(body.length), ...headers });
    res.end(body);
  });
  return `${base}${pathname}`;
}


beforeAll(async () => {
  const src = path.join(dir, "src");
  mkdirSync(path.join(src, "llama-b1"), { recursive: true });
  writeFileSync(path.join(src, "llama-b1", bin), "#!/bin/sh\necho fake\n");
  writeFileSync(path.join(src, "llama-b1", "libggml.so"), "lib");
  const tgz = path.join(dir, "llama-test.tar.gz");
  execFileSync("tar", ["-czf", tgz, "-C", src, "llama-b1"]);
  archive = readFileSync(tgz);
  server = createServer((req, res) => {
    requests++;
    const route = routes.get(req.url ?? "");
    if (route) {
      route(res);
    } else if (req.url === `/${RUNTIME_MANIFEST.tag}/llama-test.tar.gz` || req.url === "/b7001/llama-test.tar.gz" || req.url === "/b7002/llama-test.tar.gz") {
      res.writeHead(200, { "content-length": String(archive.length) });
      res.end(archive);
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  base = `http://127.0.0.1:${String(port)}`;
  vi.stubEnv("LLAMA_RELEASES_URL", base);
  vi.stubEnv("LLAMA_DIR", path.join(dir, "llama"));
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await new Promise<void>((r) => server.close(() => { r(); }));
  rmSync(dir, { recursive: true, force: true });
});

const sha = () => createHash("sha256").update(archive).digest("hex");

describe("runtime install", () => {
  it("refuses an archive whose checksum does not match, and leaves nothing behind", async () => {
    const build = { asset: { name: "llama-test.tar.gz", sha256: "0".repeat(64), size: archive.length } };
    await expect(installRuntime("vulkan", undefined, build)).rejects.toBeInstanceOf(RuntimeInstallError);
    await expect(installRuntime("vulkan", undefined, build)).rejects.toThrow(/did not match its recorded checksum/);
    expect(await installedRuntime("vulkan")).toBeNull();
  });

  it("downloads, verifies, unpacks, finds the nested binary and marks it executable", async () => {
    const progress: number[] = [];
    const build = { asset: { name: "llama-test.tar.gz", sha256: sha(), size: archive.length } };
    const installed = await installRuntime("vulkan", (p) => progress.push(p.doneBytes), build);
    expect(installed.bin.endsWith(path.join("llama-b1", bin))).toBe(true);
    expect(existsSync(installed.bin)).toBe(true);
    if (process.platform !== "win32") expect(statSync(installed.bin).mode & 0o111).not.toBe(0);
    expect(progress.at(-1)).toBe(archive.length);
    expect(await installedRuntime("vulkan")).toMatchObject({ flavour: "vulkan", bin: installed.bin });
  });

  it("is idempotent: an installed build is not downloaded again", async () => {
    const before = requests;
    const build = { asset: { name: "llama-test.tar.gz", sha256: sha(), size: archive.length } };
    await installRuntime("vulkan", undefined, build);
    expect(requests).toBe(before);
  });

  it("prunes other builds only once told which one runs", async () => {
    const other = path.join(dir, "llama", "runtime", "b0-vulkan");
    mkdirSync(other, { recursive: true });
    const keep = await installedRuntime("vulkan");
    if (!keep) throw new Error("expected an installed runtime");
    await pruneRuntimes(keep);
    expect(existsSync(other)).toBe(false);
    expect(existsSync(keep.bin)).toBe(true);
  });
});

/**
 * Builds an admin chose (#270): other official releases beside the bundled
 * one, and archives from an address they entered.
 */
describe("more than one build", () => {
  const official = (tag: string) =>
    ({ kind: "official", tag, flavour: "vulkan", build: { asset: { name: "llama-test.tar.gz", sha256: sha(), size: archive.length } } }) as const;

  it("installs two releases of one backend side by side, each from its own release", async () => {
    const [a, b] = await Promise.all([installSource(official("b7001")), installSource(official("b7002"))]);
    expect(a.dir).not.toBe(b.dir);
    expect(a).toMatchObject({ tag: "b7001", source: "official", pinned: true, sha256: sha() });
    expect(await installedOfficial("b7002", "vulkan")).toMatchObject({ tag: "b7002", flavour: "vulkan" });
    // Neither displaced the bundled build.
    expect(await installedRuntime("vulkan")).toMatchObject({ tag: RUNTIME_MANIFEST.tag, source: "bundled", pinned: false });
  });

  it("refuses a tag that is not a release tag before it becomes a path", () => {
    expect(() => installSource({ ...official("b7001"), tag: "../../etc" })).toThrow(RuntimeInstallError);
    expect(() => installSource({ kind: "custom", id: "../x", name: "x", flavour: "cpu", url: `${base}/x`, sha256: null })).toThrow(RuntimeInstallError);
  });

  it("keeps the builds an admin downloaded when it prunes, and the bundled one, and drops the rest", async () => {
    const running = await installedOfficial("b7001", "vulkan");
    if (!running) throw new Error("expected b7001");
    // A superseded bundled build: complete, but neither pinned nor current.
    const stale = path.join(dir, "llama", "runtime", "b6000-vulkan");
    mkdirSync(stale, { recursive: true });
    writeFileSync(path.join(stale, bin), "x");
    writeFileSync(path.join(stale, ".loxaic-complete.json"), JSON.stringify({ tag: "b6000", flavour: "vulkan", bin }));
    await pruneRuntimes(running);
    expect(existsSync(stale)).toBe(false);
    const left = (await listInstalledRuntimes()).map((r) => r.key).sort();
    expect(left).toEqual(["b7001-vulkan", "b7002-vulkan", `${RUNTIME_MANIFEST.tag}-vulkan`].sort());

    // Unpinned, a chosen build is a superseded one like any other.
    const other = await installedOfficial("b7002", "vulkan");
    if (!other) throw new Error("expected b7002");
    await setRuntimePinned(other, false);
    await pruneRuntimes(running);
    expect(await installedOfficial("b7002", "vulkan")).toBeNull();
  });

  it("removes one build's files and nothing else", async () => {
    const one = await installedOfficial("b7001", "vulkan");
    if (!one) throw new Error("expected b7001");
    await deleteRuntime(one);
    expect(await installedOfficial("b7001", "vulkan")).toBeNull();
    expect(await installedRuntime("vulkan")).not.toBeNull();
    await expect(deleteRuntime({ ...one, key: "../models" })).rejects.toThrow(RuntimeInstallError);
  });

  it("cuts an official download off at the size its release declares", async () => {
    // No content-length, and twice the bytes: only the stream can notice.
    routes.set("/b7003/llama-test.tar.gz", (res) => {
      res.writeHead(200);
      res.end(Buffer.concat([archive, archive]));
    });
    await expect(installSource(official("b7003"))).rejects.toThrow(/past its expected size/);
    expect(await installedOfficial("b7003", "vulkan")).toBeNull();
  });
});

describe("what a marker may say", () => {
  const marker = (r: { dir: string }) => path.join(r.dir, ".loxaic-complete.json");
  const edit = (r: { dir: string }, change: (m: Record<string, unknown>) => void) => {
    const m = JSON.parse(readFileSync(marker(r), "utf8")) as Record<string, unknown>;
    change(m);
    writeFileSync(marker(r), JSON.stringify(m));
  };

  it("is not believed about which build it is, nor allowed to name a program outside it", async () => {
    const build = { asset: { name: "llama-test.tar.gz", sha256: sha(), size: archive.length } };
    const r = await installSource({ kind: "official", tag: "b7002", flavour: "vulkan", build });
    const original = readFileSync(marker(r), "utf8");
    // A build in b7002-vulkan claiming to be the bundled release.
    edit(r, (m) => { m.tag = RUNTIME_MANIFEST.tag; });
    expect(await installedOfficial("b7002", "vulkan")).toBeNull();
    writeFileSync(marker(r), original);
    edit(r, (m) => { m.flavour = "cuda12"; });
    expect(await installedOfficial("b7002", "vulkan")).toBeNull();
    writeFileSync(marker(r), original);
    // A binary path that climbs out of the build.
    edit(r, (m) => { m.bin = "../../../../../../../bin/sh"; });
    expect(await installedOfficial("b7002", "vulkan")).toBeNull();
    writeFileSync(marker(r), original);
    expect(await installedOfficial("b7002", "vulkan")).toMatchObject({ tag: "b7002" });
  });
});

describe("disk space", () => {
  const official = () => ({ kind: "official", tag: "b7001", flavour: "cpu", build: { asset: { name: "llama-test.tar.gz", sha256: sha(), size: archive.length } } }) as const;
  afterEach(() => { __setDiskFreeForTest(null); });

  it("refuses to start when the download would not leave the margin free, before asking for anything", async () => {
    __setDiskFreeForTest(() => 1024 ** 3);
    const before = requests;
    await expect(installSource(official())).rejects.toThrow(/Not enough disk space/);
    expect(requests).toBe(before);
    expect(await installedOfficial("b7001", "cpu")).toBeNull();
  });

  it("stops once the disk runs low partway, and removes what it wrote", async () => {
    let free = 100 * 1024 ** 3;
    __setDiskFreeForTest(() => free);
    const progress = (p: { doneBytes: number; totalBytes: number }) => {
      // What unpacking would do to a disk.
      if (p.totalBytes > 0 && p.doneBytes >= p.totalBytes) free = 1024 ** 3;
    };
    await expect(installSource(official(), progress)).rejects.toThrow(/was stopped: it would have left less than/);
    expect(await installedOfficial("b7001", "cpu")).toBeNull();
    expect(readdirSync(path.join(dir, "llama", "runtime")).filter((n) => n.startsWith(".install-"))).toEqual([]);
  });
});

describe("a third-party build", () => {
  const custom = (id: string, url: string, sha: string | null = null) =>
    ({ kind: "custom", id, name: "Fork", flavour: "vulkan", url, sha256: sha }) as const;

  beforeAll(() => {
    // What lets a loopback http address through; a real install needs https.
    vi.stubEnv("LOXAIC_TEST_HTTP_BUILDS", "1");
  });

  it("is refused when it does not hash to what the admin said, and nothing is unpacked", async () => {
    const url = serve("/fork-a.tar.gz", archive);
    await expect(installSource(custom("aaaaaaaaaaa1", url, "0".repeat(64)))).rejects.toThrow(/did not match its recorded checksum/);
    expect(await installedCustom("aaaaaaaaaaa1")).toBeNull();
  });

  it("installs with a matching hash, or none, and records what it hashed to either way", async () => {
    const url = serve("/fork-b.tar.gz", archive);
    const withHash = await installSource(custom("aaaaaaaaaaa2", url, sha()));
    const without = await installSource(custom("aaaaaaaaaaa3", url));
    for (const r of [withHash, without]) {
      expect(r).toMatchObject({ source: "custom", tag: "Fork", pinned: true, sha256: sha() });
      expect(existsSync(r.bin)).toBe(true);
    }
    expect(await installedCustom("aaaaaaaaaaa3")).toMatchObject({ customId: "aaaaaaaaaaa3", key: "custom-aaaaaaaaaaa3" });
  });

  it("does not follow a redirect to somewhere that is not https", async () => {
    let followed = false;
    routes.set("/elsewhere", (res) => {
      followed = true;
      res.writeHead(200).end(archive);
    });
    routes.set("/redirect-out", (res) => { res.writeHead(302, { location: "http://example.invalid/llama.tar.gz" }).end(); });
    await expect(installSource(custom("aaaaaaaaaaa4", `${base}/redirect-out`))).rejects.toThrow(/redirected somewhere that is not https/);
    // A redirect that stays allowed is followed.
    routes.set("/redirect-ok", (res) => { res.writeHead(302, { location: "/elsewhere" }).end(); });
    await installSource(custom("aaaaaaaaaaa5", `${base}/redirect-ok`));
    expect(followed).toBe(true);
    // And one that never ends is given up on.
    routes.set("/loop", (res) => { res.writeHead(302, { location: "/loop" }).end(); });
    await expect(installSource(custom("aaaaaaaaaaa6", `${base}/loop`))).rejects.toThrow(/redirected too many times/);
  });

  it("is refused when it is not an archive, whatever its name says", async () => {
    const url = serve("/page.tar.gz", Buffer.from("<html>Sign in to download</html>"));
    await expect(installSource(custom("aaaaaaaaaaa7", url))).rejects.toThrow(/is not a \.tar\.gz/);
  });

  it("is refused when it holds no llama-server", async () => {
    const url = serve("/empty.tar.gz", tarball("nobin", { "README.md": "hello" }));
    await expect(installSource(custom("aaaaaaaaaaa8", url))).rejects.toThrow(/contains no llama-server/);
  });

  it.skipIf(process.platform === "win32")("is refused when it holds a link that leads outside it", async () => {
    const url = serve("/escape.tar.gz", tarball("escape", { [`b/${bin}`]: "#!/bin/sh\n", "b/models": { link: "../../../models" } }));
    await expect(installSource(custom("aaaaaaaaaaa9", url))).rejects.toThrow(/link that leads outside/);
    expect(await installedCustom("aaaaaaaaaaa9")).toBeNull();
    // A link that stays inside is what upstream's own archives contain.
    const ok = serve("/inside.tar.gz", tarball("inside", { [`b/${bin}`]: "#!/bin/sh\n", "b/libllama.so.0": "lib", "b/libllama.so": { link: "libllama.so.0" } }));
    await expect(installSource(custom("aaaaaaaaaab1", ok))).resolves.toMatchObject({ source: "custom" });
  });

  it.skipIf(process.platform === "win32")("judges a link by where it really leads, not by its text", async () => {
    // `d/up` is the unpacked root itself, so `d/up/../../pwned` is two levels
    // above it — while joined as text it reads as `root/pwned`.
    const url = serve("/chain.tar.gz", tarball("chain", {
      [`b/${bin}`]: "#!/bin/sh\n",
      "d/up": { link: ".." },
      ".loxaic-complete.json": { link: "d/up/../../pwned" },
    }));
    await expect(installSource(custom("aaaaaaaaaac3", url))).rejects.toThrow(/link that leads outside/);
    expect(await installedCustom("aaaaaaaaaac3")).toBeNull();
    // Nothing was written where the link pointed.
    expect(existsSync(path.join(dir, "llama", "pwned"))).toBe(false);
    expect(existsSync(path.join(dir, "llama", "runtime", "pwned"))).toBe(false);
  });

  it.skipIf(process.platform === "win32")("judges a link to something missing by where it would lead", async () => {
    // Writing through it would create the file wherever it names.
    const out = serve("/dangling-out.tar.gz", tarball("dangling-out", { [`b/${bin}`]: "#!/bin/sh\n", "b/cache": { link: "../../not-there" } }));
    await expect(installSource(custom("aaaaaaaaaac4", out))).rejects.toThrow(/link that leads outside/);
    const inside = serve("/dangling-in.tar.gz", tarball("dangling-in", { [`b/${bin}`]: "#!/bin/sh\n", "b/libllama.so": { link: "libllama.so.9" } }));
    await expect(installSource(custom("aaaaaaaaaac7", inside))).resolves.toMatchObject({ source: "custom" });
  });

  it.skipIf(process.platform === "win32")("writes its own marker over whatever the archive shipped by that name", async () => {
    const url = serve("/marker.tar.gz", tarball("marker", {
      [`b/${bin}`]: "#!/bin/sh\n",
      "b/notes.txt": "upstream notes",
      ".loxaic-complete.json": { link: "b/notes.txt" },
    }));
    const r = await installSource(custom("aaaaaaaaaac5", url));
    expect(readFileSync(path.join(r.dir, "b", "notes.txt"), "utf8")).toBe("upstream notes");
    expect(lstatSync(path.join(r.dir, ".loxaic-complete.json")).isSymbolicLink()).toBe(false);
    expect(r).toMatchObject({ source: "custom", customId: "aaaaaaaaaac5" });
  });

  it("refuses a stored address that is not https before asking it for anything", async () => {
    vi.stubEnv("LOXAIC_TEST_HTTP_BUILDS", "");
    const before = requests;
    const url = serve("/plain.tar.gz", archive);
    await expect(installSource(custom("aaaaaaaaaac6", url))).rejects.toThrow(/not an https address/);
    expect(requests).toBe(before);
    vi.stubEnv("LOXAIC_TEST_HTTP_BUILDS", "1");
  });

  it("gives up on a download that goes quiet", async () => {
    vi.stubEnv("LLAMA_DOWNLOAD_STALL_MS", "300");
    routes.set("/stall.tar.gz", (res) => {
      res.writeHead(200, { "content-length": String(archive.length) });
      res.write(archive.subarray(0, 10));
      // …and nothing more.
    });
    await expect(installSource(custom("aaaaaaaaaab2", `${base}/stall.tar.gz`))).rejects.toThrow(/stalled/);
    vi.stubEnv("LLAMA_DOWNLOAD_STALL_MS", "");
  });

  it("refuses an archive that declares itself larger than any build", async () => {
    routes.set("/huge.tar.gz", (res) => {
      res.writeHead(200, { "content-length": String(3 * 1024 ** 3) });
      res.write(archive.subarray(0, 10));
    });
    await expect(installSource(custom("aaaaaaaaaab3", `${base}/huge.tar.gz`))).rejects.toThrow(/larger than expected/);
  });

  it("names nothing of the address when the download cannot be reached", async () => {
    const err = await installSource(custom("aaaaaaaaaab4", "http://127.0.0.1:1/llama.tar.gz?token=SECRET")).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RuntimeInstallError);
    expect((err as Error).message).not.toMatch(/SECRET|127\.0\.0\.1/);
  });
});
