import type { HfMtpHead, LoadSettings, LocalModel } from '@loxaic/api-client';
import { formatBytes } from './localModels';

/**
 * What the settings sheet says about a model's multi-token-prediction head,
 * and whether MTP can be turned on — decided here, so the sheet only renders
 * it. A model either carries its own head (Qwen3.8-27B), has a separate one
 * downloaded or on its way (Flash-Next's `MTP/` folder), or can be given one
 * from its repository, or has none at all, and then the sheet shows nothing.
 */

export type MtpPanel =
  | { kind: 'embedded' }
  | { kind: 'head-ready'; name: string; size: string }
  | { kind: 'head-downloading'; name: string; percent: number; queued: boolean }
  | { kind: 'head-failed'; name: string; error: string }
  | { kind: 'choose'; heads: MtpHeadChoice[] }
  /** The repository's heads have not been listed yet (or could not be). */
  | { kind: 'unknown' }
  | { kind: 'none' };

export interface MtpHeadChoice {
  path: string;
  name: string;
  size: string;
  /** Why it cannot be picked, or null. */
  disabledReason: string | null;
}

export const SHARED_HEAD_REASON = "Borrows the model's own tensors, which this server's llama.cpp cannot do yet.";

export function headName(path: string): string {
  return path.split('/').at(-1) ?? path;
}

/**
 * `repoHeads` is the repository's head list: null while it is being fetched,
 * `'error'` when it could not be, an array once known. Only asked for a model
 * with no head of its own.
 */
export function mtpPanel(model: Pick<LocalModel, 'mtpSource' | 'mtpHead' | 'meta'>, repoHeads: HfMtpHead[] | null | 'error'): MtpPanel {
  if (model.mtpSource === 'embedded' || model.meta.mtp) return { kind: 'embedded' };
  const head = model.mtpHead;
  if (head) {
    const name = headName(head.path);
    if (head.status === 'ready') return { kind: 'head-ready', name, size: formatBytes(head.size) };
    if (head.status === 'failed') return { kind: 'head-failed', name, error: head.error ?? 'The head could not be used.' };
    const percent = head.size > 0 ? Math.max(0, Math.min(100, Math.floor((head.bytesDone / head.size) * 100))) : 0;
    return { kind: 'head-downloading', name, percent, queued: head.status === 'queued' };
  }
  if (repoHeads === null || repoHeads === 'error') return { kind: 'unknown' };
  if (repoHeads.length === 0) return { kind: 'none' };
  return { kind: 'choose', heads: headChoices(repoHeads) };
}

/** A failed head offers the others again, so the list is wanted then too. */
export function wantsRepoHeads(model: Pick<LocalModel, 'mtpSource' | 'mtpHead' | 'meta'>): boolean {
  if (model.mtpSource === 'embedded' || model.meta.mtp) return false;
  return !model.mtpHead || model.mtpHead.status === 'failed';
}

export function headChoices(heads: HfMtpHead[]): MtpHeadChoice[] {
  return heads.map((h) => ({
    path: h.path,
    name: headName(h.path),
    size: formatBytes(h.size),
    disabledReason: h.shared ? SHARED_HEAD_REASON : null,
  }));
}

/**
 * The head the download dialog ticks by default: the smallest self-contained
 * Q8_0 — unsloth's recommendation for Flash-Next, and the one its measurements
 * found fastest — or else the smallest one this server can load at all.
 */
export function defaultMtpHead(heads: HfMtpHead[] | undefined): HfMtpHead | null {
  const usable = (heads ?? []).filter((h) => !h.shared).sort((a, b) => a.size - b.size);
  return usable.find((h) => /q8_0/i.test(headName(h.path))) ?? usable.at(0) ?? null;
}

/** Whether the sheet shows the MTP group at all. */
export function showsMtp(panel: MtpPanel): boolean {
  return panel.kind !== 'none' && panel.kind !== 'unknown';
}

/** MTP can be switched on once a head exists or is on its way; it starts
 * drafting when the head is ready. */
export function mtpCanTurnOn(panel: MtpPanel): boolean {
  return panel.kind === 'embedded' || panel.kind === 'head-ready' || panel.kind === 'head-downloading';
}

/**
 * Speculation helps one conversation at a time and costs when several run at
 * once (unsloth measured 0.81–0.87× at eight): a busy model has no idle time
 * for a draft to use. llama.cpp runs four slots when `parallel` is unset.
 */
export function mtpParallelWarning(settings: LoadSettings): string | null {
  if (settings.mtp !== true || settings.parallel === 1) return null;
  const slots = typeof settings.parallel === 'number' ? String(settings.parallel) : 'four';
  return `This model answers up to ${slots} conversations at once. MTP speeds up one at a time and was measured slower with several running together — set Max concurrent predictions to 1 for the speedup.`;
}

/** Turning MTP off takes its draft length with it: the server refuses a draft
 * length on its own. */
export function withMtp(draft: LoadSettings, on: boolean): LoadSettings {
  const next = { ...draft };
  if (on) next.mtp = true;
  else {
    Reflect.deleteProperty(next, 'mtp');
    Reflect.deleteProperty(next, 'mtpDraftMax');
  }
  return next;
}

/** One line for a message's usage: what share of the drafted tokens the model
 * kept. Floored, so 99.6% never reads as a perfect 100. Null when nothing was
 * drafted — absence, never "0%". */
export function describeMtpAcceptance(drafted: number | null | undefined, accepted: number | null | undefined): string | null {
  if (drafted === null || drafted === undefined || drafted <= 0) return null;
  const kept = Math.max(0, Math.min(drafted, accepted ?? 0));
  const pct = Math.floor((kept / drafted) * 100);
  return `MTP ${String(pct)}% of ${String(drafted)} drafted`;
}

/** The installed row's MTP badge: on (drafting), a head on its way, or a head
 * that was refused. Null when there is nothing to say. */
export function mtpBadge(
  model: Pick<LocalModel, 'mtpSource' | 'mtpHead' | 'meta' | 'loadSettings'>,
): { text: string; problem: boolean } | null {
  const head = model.mtpHead;
  if (head && (head.status === 'queued' || head.status === 'downloading')) {
    const pct = head.size > 0 ? Math.floor((head.bytesDone / head.size) * 100) : 0;
    return { text: head.status === 'queued' ? 'MTP head waiting' : `MTP head · ${String(pct)}%`, problem: false };
  }
  if (head?.status === 'failed') return { text: 'MTP head refused', problem: true };
  const drafting = model.loadSettings.mtp === true && (model.mtpSource === 'embedded' || model.mtpSource === 'head' || Boolean(model.meta.mtp));
  return drafting ? { text: 'MTP', problem: false } : null;
}
