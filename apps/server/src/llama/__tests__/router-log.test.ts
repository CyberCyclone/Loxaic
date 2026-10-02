import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { openRouterLog } from "../router-log.ts";

const dir = mkdtempSync(path.join(os.tmpdir(), "loxaic-router-log-"));
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

const at = new Date("2026-10-02T08:00:00.000Z");

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

  it("keeps what an earlier router wrote: a restart appends", async () => {
    const file = path.join(dir, "b", "router.log");
    const first = openRouterLog(file, 1024 * 1024, () => at);
    first.write("before the restart");
    await first.close();
    const second = openRouterLog(file, 1024 * 1024, () => at);
    second.write("after the restart");
    await second.close();
    expect(readFileSync(file, "utf8").trim().split("\n")).toHaveLength(2);
  });

  it("rotates once past the cap, so it is bounded at twice that", async () => {
    const file = path.join(dir, "c", "router.log");
    const line = "x".repeat(100);
    const log = openRouterLog(file, 1000, () => at);
    for (let i = 0; i < 30; i++) log.write(line);
    await log.close();
    expect(existsSync(`${file}.1`)).toBe(true);
    expect(readFileSync(file).length).toBeLessThanOrEqual(1000);
    expect(readFileSync(`${file}.1`).length).toBeLessThanOrEqual(1000);
  });

  it("never throws when it cannot write", () => {
    // A path under a file, which no directory can be created at.
    const blocker = path.join(dir, "c", "router.log");
    const log = openRouterLog(path.join(blocker, "nested", "router.log"));
    expect(() => { log.write("lost, harmlessly"); }).not.toThrow();
  });
});
