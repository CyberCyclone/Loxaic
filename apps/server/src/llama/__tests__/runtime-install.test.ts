import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { installedRuntime, installRuntime, pruneRuntimes, RuntimeInstallError, RUNTIME_MANIFEST } from "../runtime.ts";

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
    if (req.url === `/${RUNTIME_MANIFEST.tag}/llama-test.tar.gz`) {
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
  vi.stubEnv("LLAMA_RELEASES_URL", `http://127.0.0.1:${String(port)}`);
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
