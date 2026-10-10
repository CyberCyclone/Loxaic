import { getLocalModelRow } from "./catalog.ts";
import { isShortGpuJobLimit, type GpuJobLimit } from "./gpu-job-limit.ts";

/**
 * What happens when the GPU is reset under a host model.
 *
 * On Pheonix a 221K-token re-read after a context-stage switch ran for 31
 * minutes, then the kernel reset one of the cards for running a job past the
 * amdgpu driver's 2-second limit (gpu-job-limit.ts). llama.cpp answered the
 * request with `decode() failed: vk::Queue::submit: ErrorDeviceLost`, and
 * the chat showed exactly that. Two things were wrong after it:
 *
 *   - Nothing said what had happened, or that Retry would read the whole
 *     conversation again and most likely stop at the same place.
 *   - The model's process stayed up. Its Vulkan device is gone for good once
 *     lost, so it answered nothing again: the next request, six and a half
 *     hours later, crashed it. So the model is unloaded as soon as a loss is
 *     seen, and the next request loads a fresh one.
 */

/** llama.cpp's words for a lost device: the Vulkan error a request fails with
 * (`vk::Queue::submit: ErrorDeviceLost`), the exception a crashing child
 * throws (`vk::DeviceLostError`), and ggml's own log line. */
export function isDeviceLost(message: string): boolean {
  return /\bErrorDeviceLost\b|\bDeviceLostError\b|\bdevice lost on \S+/.test(message);
}

const SPAWN_LINE = /spawning server instance with name=(\S+) on port (\d+)/;
const CHILD_LINE = /^\[\s*(\d+)\]\s?(.*)$/;

/** Which device the model's own llama-server reported lost (`ggml_vulkan:
 * device lost on Vulkan2`), from the router's output after its newest spawn;
 * null when it did not say. */
export function lostDevice(lines: string[], routerName: string): string | null {
  let port: string | null = null;
  let device: string | null = null;
  for (const line of lines) {
    const spawn = SPAWN_LINE.exec(line);
    if (spawn?.[1] === routerName) {
      port = spawn[2];
      device = null;
      continue;
    }
    const child = CHILD_LINE.exec(line);
    if (port === null || child?.[1] !== port) continue;
    const lost = /device lost on (\S+)/.exec(child[2]);
    if (lost) device = lost[1];
  }
  return device;
}

/** The sentence a person reads in place of llama.cpp's. Pure, for its tests. */
export function deviceLostMessage(name: string, device: string | null, limit: GpuJobLimit | null): string {
  const which = device ? `the GPU (${device})` : "the GPU";
  const first = `${which.charAt(0).toUpperCase()}${which.slice(1)} stopped responding while ${name} was working on this, and the system reset it.`;
  const why = isShortGpuJobLimit(limit)
    ? ` This host's GPU driver resets any GPU job that runs longer than ${formatMs(limit?.computeMs ?? 0)}, and a long prompt can need more than that; an admin can raise the limit (Settings › Host models says how).`
    : "";
  return (
    `${first}${why} The model has been unloaded and loads again with your next message, ` +
    "which reads the whole conversation again from the start."
  );
}

function formatMs(ms: number): string {
  return ms % 1000 === 0 ? `${String(ms / 1000)} s` : `${String(ms)} ms`;
}

/** The sentence for a lost device under host model `id`, falling back to the
 * id when its row is gone. */
export async function describeDeviceLoss(id: string, device: string | null, limit: GpuJobLimit | null): Promise<string> {
  const row = await getLocalModelRow(id).catch(() => null);
  return deviceLostMessage(row?.displayName ?? id, device, limit);
}
