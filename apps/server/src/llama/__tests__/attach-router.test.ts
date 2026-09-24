import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { v4 as uuid } from "uuid";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { db, eq } from "@loxaic/db";
import { localModels } from "@loxaic/db/schema";
import { invalidateLocalModelCache } from "../catalog.ts";
import {
  __resetRouterForTest,
  bootLocalRuntime,
  refreshRuntimeState,
  routerEndpoint,
  routerModelStatuses,
  runtimeView,
} from "../router.ts";
import { streamCompletion } from "../../inference/provider.ts";

/**
 * Compose's attach mode, end to end: the real sidecar entrypoint
 * (`infra/docker/llama-router.sh`) runs the fake llama-server, and this
 * server — `LLAMA_MODE=attach` — talks to it over the shared directory and
 * HTTP, exactly as the two containers do.
 *
 * What is held: the sidecar does not start until the server has written the
 * preset *and* the key; it then refuses unauthenticated requests; the server
 * reaches it with the key it minted; the sidecar's device list reaches the
 * admin view; and a sidecar that can see no GPU is reported as running on the
 * CPU, never silently.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(HERE, "../../../../../infra/docker/llama-router.sh");
const FAKE = path.resolve(HERE, "../../../test-fixtures/fake-llama-server.mjs");
const dir = mkdtempSync(path.join(os.tmpdir(), "loxaic-attach-"));
const host = `test-attach-${uuid()}`;
const model = `test/attach-${uuid().slice(0, 8)}:Q4_K_M`;
let port = 0;
let sidecar: ChildProcess | null = null;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const p = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => { resolve(p); });
    });
  });
}

async function listening(): Promise<boolean> {
  try {
    return (await fetch(`http://127.0.0.1:${String(port)}/health`, { signal: AbortSignal.timeout(500) })).ok;
  } catch {
    return false;
  }
}

async function until(pred: () => Promise<boolean>, ms = 15_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await pred())) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 100));
  }
}

beforeAll(async () => {
  port = await freePort();
  vi.stubEnv("LOXAIC_INSTANCE_ID", host);
  vi.stubEnv("LLAMA_DIR", dir);
  vi.stubEnv("LLAMA_MODE", "attach");
  vi.stubEnv("LLAMA_ROUTER_URL", `http://127.0.0.1:${String(port)}`);
  vi.stubEnv("LLAMA_API_KEY", "");
  vi.stubEnv("MOCK_INFERENCE", "false");
  await __resetRouterForTest();
  await db.insert(localModels).values({
    id: model,
    hostId: host,
    repo: model.split(":")[0],
    revision: "0".repeat(40),
    quant: "Q4_K_M",
    files: [{ path: "m.gguf", size: 1, sha256: "a".repeat(64) }],
    sizeBytes: 1,
    status: "ready",
    enabled: true,
    displayName: model,
    publisher: "test",
  });
  invalidateLocalModelCache();
});

afterAll(async () => {
  sidecar?.kill("SIGTERM");
  await __resetRouterForTest();
  await db.delete(localModels).where(eq(localModels.hostId, host));
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

describe("the Compose sidecar (attach mode)", () => {
  it("waits for the key even when a preset is already there", async () => {
    // A volume from before the key existed: the preset is there, the key is
    // not. The sidecar must still wait rather than start unauthenticated.
    writeFileSync(path.join(dir, "models.ini"), "version = 1\n\n[*]\njinja = true\n");
    sidecar = spawn("sh", [SCRIPT], {
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        LLAMA_DIR: dir,
        LLAMA_SERVER_BIN: FAKE,
        LLAMA_ROUTER_HOST: "127.0.0.1",
        LLAMA_ROUTER_PORT: String(port),
      },
      stdio: "ignore",
    });
    await new Promise((r) => setTimeout(r, 1500));
    // Nothing to serve and no key yet: it must not have started unprotected.
    expect(await listening()).toBe(false);
    // It did record what it can see, for the admin screen.
    expect(readFileSync(path.join(dir, "router-devices.txt"), "utf8")).toContain("FAKE0");
  });

  it("starts once the server has written them, and refuses a request without the key", async () => {
    await bootLocalRuntime(() => undefined);
    const keyFile = path.join(dir, "router.key");
    expect(statSync(keyFile).mode & 0o777).toBe(0o600);
    await until(listening);
    const open = await fetch(`http://127.0.0.1:${String(port)}/models`);
    expect(open.status).toBe(401);
    // The key never appears in the preset, which the sidecar also reads.
    const key = readFileSync(keyFile, "utf8").trim();
    expect(readFileSync(path.join(dir, "models.ini"), "utf8")).not.toContain(key);
    expect(routerEndpoint()?.apiKey).toBe(key);
  });

  it("the server reaches it with the key: listing, the device list, and a streamed reply", async () => {
    expect((await routerModelStatuses()).has(model)).toBe(true);
    await refreshRuntimeState();
    const view = runtimeView();
    expect(view.state).toBe("running");
    expect(view.devices.map((d) => d.name)).toEqual(["FAKE0"]);
    expect(view.cpuActive).toBe(false);
    let text = "";
    for await (const ev of streamCompletion(model, [{ role: "user", content: "hi" }])) {
      if (ev.type === "delta") text += ev.content;
    }
    expect(text).toBe(`Hello from ${model}`);
  });

  it("a sidecar that sees no GPU is reported as running on the CPU", async () => {
    // What the entrypoint writes when the container was started without the
    // override for its GPU.
    writeFileSync(path.join(dir, "router-devices.txt"), "Available devices:\n");
    await refreshRuntimeState();
    const view = runtimeView();
    expect(view.cpuActive).toBe(true);
    expect(view.gpuAvailable).toBe(false);
    expect(view.reason).toMatch(/cannot see a GPU/);
  });
});
