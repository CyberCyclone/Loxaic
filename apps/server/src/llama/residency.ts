import { readdir, readFile } from "node:fs/promises";

/**
 * What a loaded model's process really holds on the GPU, measured rather than
 * logged (Linux only).
 *
 * The allocation log (placement.ts) says where llama.cpp *put* each buffer.
 * What it cannot say is that the driver later moved some of it: with VRAM
 * oversubscribed — two models loaded together on Pheonix — amdgpu evicts
 * buffers to GTT (system RAM the GPU reads across PCIe), the model keeps
 * running at a quarter of its speed, and nothing moves back until it is
 * reloaded. The kernel counts both per DRM client in
 * `/proc/<pid>/fdinfo/<fd>` (`drm-memory-vram`, `drm-memory-gtt`, in KiB),
 * which is what this reads. A process holds one client per device, possibly
 * behind several fds, so clients are counted once by `drm-client-id`.
 *
 * The model's process is the router's child serving its port; the router
 * starts it with `--port <P>`, so it is found by its parent and command line.
 */

export interface DrmUsage {
  vramBytes: number;
  gttBytes: number;
  clients: number;
}

/** Sum the DRM memory in a process's fdinfo texts, one client once. Pure. */
export function sumDrmFdinfo(texts: string[]): DrmUsage | null {
  const seen = new Set<string>();
  let vram = 0;
  let gtt = 0;
  for (const t of texts) {
    const id = /^drm-client-id:\s*(\d+)/m.exec(t)?.[1];
    if (!id) continue;
    // Two devices may each number a client 1: the device is part of the key.
    const key = `${/^drm-pdev:\s*(\S+)/m.exec(t)?.[1] ?? ""}/${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    vram += kib(/^drm-memory-vram:\s*(\d+)\s*KiB/m.exec(t)?.[1]);
    gtt += kib(/^drm-memory-gtt:\s*(\d+)\s*KiB/m.exec(t)?.[1]);
  }
  return seen.size > 0 ? { vramBytes: vram, gttBytes: gtt, clients: seen.size } : null;
}

function kib(v: string | undefined): number {
  return v ? Number(v) * 1024 : 0;
}

/** The parent pid in a `/proc/<pid>/stat` line. Pure. The command name is in
 * parentheses and may hold spaces and parentheses itself: the fields after
 * its last closing parenthesis are state, then the parent pid. */
export function parentPidFromStat(stat: string): number | null {
  const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
  return Number.isInteger(ppid) && ppid > 0 ? ppid : null;
}

/** Whether `pid` is still `parentPid`'s child serving `port`. */
async function isChildOnPort(pid: number, parentPid: number, port: number): Promise<boolean> {
  try {
    if (parentPidFromStat(await readFile(`/proc/${String(pid)}/stat`, "utf8")) !== parentPid) return false;
    const args = (await readFile(`/proc/${String(pid)}/cmdline`, "utf8")).split("\0");
    const i = args.indexOf("--port");
    return i >= 0 && Number(args[i + 1]) === port;
  } catch {
    return false; // gone, or not ours to read
  }
}

/** The pid of `parentPid`'s child started with `--port <port>`, or null. */
export async function childOnPort(parentPid: number, port: number): Promise<number | null> {
  let entries: string[];
  try {
    entries = await readdir("/proc");
  } catch {
    return null;
  }
  for (const e of entries) {
    if (/^\d+$/.test(e) && (await isChildOnPort(Number(e), parentPid, port))) return Number(e);
  }
  return null;
}

/** DRM memory held by `pid`, or null where the platform does not report it. */
export async function drmUsage(pid: number): Promise<DrmUsage | null> {
  try {
    const dir = `/proc/${String(pid)}/fdinfo`;
    const fds = await readdir(dir);
    const texts: string[] = [];
    for (const fd of fds) {
      const t = await readFile(`${dir}/${fd}`, "utf8").catch(() => "");
      if (t.includes("drm-client-id")) texts.push(t);
    }
    return sumDrmFdinfo(texts);
  } catch {
    return null;
  }
}

const CACHE_MS = 10_000;
const cache = new Map<string, { at: number; value: DrmUsage | null }>();
const pids = new Map<string, number>();

/**
 * The DRM memory of the model served on `port`, cached for ten seconds — the
 * admin screen polls every second while anything moves, and a `/proc` walk
 * per model per poll is waste. Null off Linux, without a router, or when the
 * driver reports nothing.
 */
export async function measuredForPort(routerPid: number | null, port: number): Promise<DrmUsage | null> {
  if (process.platform !== "linux" || !routerPid) return null;
  const key = `${String(routerPid)}:${String(port)}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  // A cached pid is checked again before it is read: the model on a port
  // changes, and a pid is reused — on a router that runs for weeks the cache
  // would otherwise report another process's memory as this model's (the
  // reason `reapStaleRouter` checks `ps` before it kills).
  let pid: number | null | undefined = pids.get(key);
  if (pid !== undefined && !(await isChildOnPort(pid, routerPid, port))) pid = undefined;
  if (pid === undefined) {
    pid = await childOnPort(routerPid, port);
    if (pid) pids.set(key, pid);
    else pids.delete(key);
  }
  const value = pid ? await drmUsage(pid) : null;
  if (!value) pids.delete(key);
  cache.set(key, { at: Date.now(), value });
  return value;
}
