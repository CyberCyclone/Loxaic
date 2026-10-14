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
 * null when it did not say. For the log and the admin card only: the chat's
 * sentence reaches every viewer of a conversation, and a GPU's ordinal is
 * deployment detail (`deviceLostMessage`).
 *
 * A port is handed back when a child exits and reused for the next one, so
 * another model spawned on our port ends our lines there. Another model on any
 * other port does not: several models are loaded at once, and our child keeps
 * printing beside theirs. */
export function lostDevice(lines: string[], routerName: string): string | null {
  let port: string | null = null;
  let device: string | null = null;
  for (const line of lines) {
    const spawn = SPAWN_LINE.exec(line);
    if (spawn) {
      if (spawn[1] === routerName) {
        port = spawn[2];
        device = null;
      } else if (spawn[2] === port) {
        port = null;
        device = null;
      }
      continue;
    }
    const child = CHILD_LINE.exec(line);
    if (port === null || child?.[1] !== port) continue;
    const lost = /device lost on (\S+)/.exec(child[2]);
    if (lost) device = lost[1];
  }
  return device;
}

/** How the loss reached us, and what became of the model. */
export interface DeviceLossContext {
  /** The device went while the model's process was loading, not answering. */
  atLoad?: boolean;
  /** An earlier loss left the model's process up, and it would not unload
   * (`room.ts`'s `discardFailed`): nothing will load a fresh one until the
   * runtime is restarted, so the sentence must not promise that it will. */
  stuck?: boolean;
}

/**
 * The sentence a person reads in place of llama.cpp's. Pure, for its tests.
 *
 * It is stored on the message and shown to everyone on the conversation,
 * shared viewers included, so it names neither the GPU nor the driver's limit:
 * both are admin-only everywhere else (the runtime card shows them). Whether
 * the limit is short enough to blame is said, without the figure.
 */
export function deviceLostMessage(name: string, limit: GpuJobLimit | null, ctx: DeviceLossContext = {}): string {
  const doing = ctx.atLoad ? "loading" : "working on this";
  const first = `The GPU stopped responding while ${name} was ${doing}, and the system reset it.`;
  const why = isShortGpuJobLimit(limit)
    ? " A long prompt can need more GPU time than this host's GPU driver allows; an admin can see the limit and raise it in Settings › Host models."
    : "";
  const next = ctx.stuck
    ? ` ${name} could not be unloaded after an earlier reset, so it will not answer until an admin restarts llama.cpp in Settings › Host models.`
    : ctx.atLoad
      ? " It loads again with your next message, which reads the whole conversation again from the start."
      : " The model has been unloaded and loads again with your next message, which reads the whole conversation again from the start.";
  return `${first}${why}${next}`;
}

/** The sentence for a lost device under host model `id`, falling back to the
 * id when its row is gone. */
export async function describeDeviceLoss(id: string, limit: GpuJobLimit | null, ctx: DeviceLossContext = {}): Promise<string> {
  const row = await getLocalModelRow(id).catch(() => null);
  return deviceLostMessage(row?.displayName ?? id, limit, ctx);
}
