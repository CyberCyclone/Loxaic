import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

// Counted, not changed: how many times a rotation is attempted is the point of
// one case below.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, renameSync: vi.fn(actual.renameSync) };
});

const { carriesPrompt, lineSplitter, openRouterLog } = await import("../router-log.ts");

const dir = mkdtempSync(path.join(os.tmpdir(), "loxaic-router-log-"));
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

const at = new Date("2026-10-02T08:00:00.000Z");
const posix = process.platform !== "win32";

describe("the router's log on disk", () => {
  it("stamps every line with the wall-clock time and skips blank ones", async () => {
    const file = path.join(dir, "a", "router.log");
    const log = openRouterLog(file, 1024 * 1024, () => at);
    log.write("srv  load_model: offloaded 49/49 layers to GPU\n\n");
    log.write("[48112] graph splits = 3\n");
    await log.close();
    expect(readFileSync(file, "utf8")).toBe(
      "2026-10-02T08:00:00.000Z srv  load_model: offloaded 49/49 layers to GPU\n" +
        "2026-10-02T08:00:00.000Z [48112] graph splits = 3\n",
    );
  });

  it("keeps a line split across two chunks whole", async () => {
    // A `data` event is not a line: a model's load output arrives in 64 KiB
    // reads, and the lines worth searching for must not be cut in two.
    const file = path.join(dir, "split", "router.log");
    const log = openRouterLog(file, 1024 * 1024, () => at);
    log.write("load_tensors: offloa");
    log.write("ded 49/49 layers to GPU\ngraph spl");
    log.write("its = 4");
    await log.close();
    expect(readFileSync(file, "utf8")).toBe(
      "2026-10-02T08:00:00.000Z load_tensors: offloaded 49/49 layers to GPU\n" +
        "2026-10-02T08:00:00.000Z graph splits = 4\n",
    );
  });

  it("keeps what an earlier router wrote: a restart appends", async () => {
    const file = path.join(dir, "b", "router.log");
    const first = openRouterLog(file, 1024 * 1024, () => at);
    first.write("before the restart\n");
    await first.close();
    const second = openRouterLog(file, 1024 * 1024, () => at);
    second.write("after the restart\n");
    await second.close();
    expect(readFileSync(file, "utf8").trim().split("\n")).toHaveLength(2);
  });

  it("rotates once past the cap, so it is bounded at twice that", async () => {
    const file = path.join(dir, "c", "router.log");
    const log = openRouterLog(file, 1000, () => at);
    for (let i = 0; i < 30; i++) log.write(`${"x".repeat(100)}\n`);
    await log.close();
    expect(existsSync(`${file}.1`)).toBe(true);
    expect(readFileSync(file).length).toBeLessThanOrEqual(1000);
    expect(readFileSync(`${file}.1`).length).toBeLessThanOrEqual(1000);
  });

  it("stops trying to rotate when the old file cannot be moved, rather than retrying on every write", async () => {
    const file = path.join(dir, "stuck", "router.log");
    // A non-empty directory where the rotated file would go: the rename fails.
    mkdirSync(path.join(`${file}.1`, "in-the-way"), { recursive: true });
    vi.mocked(renameSync).mockClear();
    const log = openRouterLog(file, 1000, () => at);
    for (let i = 0; i < 50; i++) log.write(`${"x".repeat(100)}\n`);
    await log.close();
    // Everything kept, in the one file it could write...
    expect(readFileSync(file, "utf8").trim().split("\n")).toHaveLength(50);
    // ...after one attempt to move it, not one per write past the cap.
    expect(renameSync).toHaveBeenCalledTimes(1);
  });

  it.skipIf(!posix)("makes an existing file 0600 and its directory 0700, whatever they were", async () => {
    const logs = path.join(dir, "modes");
    const file = path.join(logs, "router.log");
    mkdirSync(logs, { recursive: true });
    writeFileSync(file, "left by another run\n");
    chmodSync(file, 0o644);
    const log = openRouterLog(file, 1024 * 1024, () => at);
    log.write("line\n");
    await log.close();
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const fresh = path.join(dir, "fresh-dir", "logs", "router.log");
    const second = openRouterLog(fresh, 1024 * 1024, () => at);
    second.write("line\n");
    await second.close();
    expect(statSync(path.dirname(fresh)).mode & 0o777).toBe(0o700);
  });

  it.skipIf(!posix)("never appends through a link left at the path", async () => {
    const logs = path.join(dir, "linked");
    mkdirSync(logs, { recursive: true });
    const target = path.join(dir, "someone-elses-file");
    writeFileSync(target, "theirs\n");
    symlinkSync(target, path.join(logs, "router.log"));
    const log = openRouterLog(path.join(logs, "router.log"), 1024 * 1024, () => at);
    expect(() => { log.write("ours\n"); }).not.toThrow();
    await log.close();
    expect(readFileSync(target, "utf8")).toBe("theirs\n");
  });

  it("never throws when it cannot write", () => {
    // Its own blocker: a file where the log's directory would have to be.
    const blocker = path.join(dir, "blocked");
    writeFileSync(blocker, "");
    const log = openRouterLog(path.join(blocker, "nested", "router.log"));
    expect(() => { log.write("lost, harmlessly\n"); }).not.toThrow();
    expect(existsSync(path.join(blocker, "nested"))).toBe(false);
  });
});

describe("reading the router's output as lines", () => {
  it("keeps each stream's unfinished line to itself", () => {
    // stdout and stderr arrive in pieces, interleaved: a carry-over shared
    // between them stitched "…model buffer" from one onto the other's line.
    const out = lineSplitter();
    const err = lineSplitter();
    expect(out("[40001] load_tensors:      Vulkan0 model buffer")).toEqual([]);
    expect(err("[40001] E failed to allocate\n[40001] W retrying")).toEqual(["[40001] E failed to allocate"]);
    expect(out(" size = 23500.00 MiB\n")).toEqual(["[40001] load_tensors:      Vulkan0 model buffer size = 23500.00 MiB"]);
    expect(err(" once\n")).toEqual(["[40001] W retrying once"]);
  });

  it("drops llama.cpp's debug lines that carry a request's content, and nothing else", () => {
    // b11342's own wording (server-http.cpp, server-context.cpp); none prints
    // at verbosity 4, which is why they are only dropped, never relied on.
    expect(carriesPrompt('[40001] 0.12.345.678 D srv  log_server_r: request:  {"messages":[{"role":"user","content":"secret"}]}')).toBe(true);
    expect(carriesPrompt("[40001] srv  log_server_r: response: {\"choices\":[]}")).toBe(true);
    expect(carriesPrompt('[40001] srv  operator(): converted request: {"messages":[]}')).toBe(true);
    expect(carriesPrompt("[40001] slot update_slots: id  0 | task 3 | prompt token   0: 151644 '<|im_start|>'")).toBe(true);
    expect(carriesPrompt("[40001] srv  log_server_r: done request: POST /v1/chat/completions 127.0.0.1 200")).toBe(false);
    expect(carriesPrompt("[40001] load_tensors:      Vulkan0 model buffer size = 23500.00 MiB")).toBe(false);
    expect(carriesPrompt("[40001] slot launch_slot_: id  0 | task 3 | processing task, prompt tokens = 512")).toBe(false);
  });
});
