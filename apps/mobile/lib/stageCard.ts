import type { ContextStageStatus, PromptProgress } from '@loxaic/api-client';
import { formatWindow } from './contextStages';

/**
 * The stage card: what a context-stage switch is doing, as the pill the
 * conversation shows while it runs — the compaction pill's sibling.
 *
 * Client-only, folded from the stream's `context.stage` events and from a
 * snapshot's `context_stage`. It is never a message: the server writes no row
 * for a stage run, because a row would enter the prompt and move the history
 * anchor. So after the stream log's TTL a reload simply has no card, which
 * reads as "we were not told", never as "nothing happened".
 */

export interface StageCard {
  streamId: string;
  status: ContextStageStatus;
  /** Epoch ms on this device when the switch's first step reached it. */
  since: number;
  /** When the current step began, for a countdown inside it. */
  stepSince: number;
}

export function foldStageCard(prev: StageCard | null, streamId: string, status: ContextStageStatus, now: number): StageCard {
  const sameRun = prev?.streamId === streamId;
  return {
    streamId,
    status,
    since: sameRun ? prev.since : now,
    // A waiting step is re-sent as the line moves; it is still the same step.
    stepSince: sameRun && prev.status.step === status.step ? prev.stepSince : now,
  };
}

export function isStageActive(card: StageCard | null): boolean {
  return card !== null && card.status.step !== 'applied' && card.status.step !== 'failed';
}

const direction = (s: ContextStageStatus): 'up' | 'down' | 'same' =>
  s.to_stage > s.from_stage ? 'up' : s.to_stage < s.from_stage ? 'down' : 'same';

/** "512K (YaRN 2×)" for a stage that extends, "256K" for standard. */
function target(s: ContextStageStatus): string {
  const w = formatWindow(s.to_tokens);
  return s.yarn_factor === null ? w : `${w} (YaRN ${String(s.yarn_factor)}×)`;
}

/** Seconds left of the reload, from how long it took last time; null when
 * that is not known or has already passed. */
export function reloadRemaining(status: ContextStageStatus, stepSince: number, now: number): number | null {
  if (status.step !== 'reloading' || !status.eta_ms) return null;
  const left = Math.ceil((status.eta_ms - (now - stepSince)) / 1000);
  return left > 0 ? left : null;
}

function progressLine(p: PromptProgress | undefined): string {
  if (!p || p.total_tokens <= 0) return '';
  const pct = Math.min(100, Math.floor((p.processed_tokens / p.total_tokens) * 100));
  const left = p.remaining_ms != null && p.remaining_ms > 0 ? ` · about ${formatLeft(p.remaining_ms)} left` : '';
  return ` · ${String(pct)}%${left}`;
}

function formatLeft(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 90) return `${String(Math.max(1, s))} s`;
  return `${String(Math.round(s / 60))} min`;
}

/** The pill's text for the current step. */
export function stageCardLabel(card: Pick<StageCard, 'status' | 'stepSince'>, now: number): string {
  const s = card.status;
  const dir = direction(s);
  switch (s.step) {
    case 'waiting': {
      const others = (s.running ?? 0) > 0;
      const what = s.reason === 'full' ? 'Context full — ' : '';
      if (others) return `${what}${what ? 'w' : 'W'}aiting for another reply to finish${s.reason === 'full' ? ' before enabling YaRN' : ''}`;
      return `${what}${what ? 'w' : 'W'}aiting for the model to be free`;
    }
    case 'reloading': {
      const left = reloadRemaining(s, card.stepSince, now);
      const time = left !== null ? ` · about ${String(left)} s` : '';
      if (dir === 'up' && s.yarn_factor !== null) {
        const lead = s.reason === 'full' ? 'Context full — enabling' : 'Enabling';
        return `${lead} YaRN ${String(s.yarn_factor)}× · reloading at ${formatWindow(s.to_tokens)}${time}`;
      }
      if (s.to_stage === 0) return `Switching back to standard context (${formatWindow(s.to_tokens)}) · reloading${time || '…'}`;
      return `Switching to ${target(s)} · reloading${time || '…'}`;
    }
    case 'rereading':
      return `Re-reading conversation${progressLine(s.progress)}`;
    case 'applied':
      if (dir === 'same') return `Context stays at ${target(s)}`;
      return s.to_stage === 0
        ? `Switched to standard context (${formatWindow(s.to_tokens)})`
        : `Context ${dir === 'up' ? 'extended' : 'set'} to ${target(s)}`;
    case 'failed':
      return s.message ?? 'The context could not be changed.';
    default:
      return 'Changing the context…';
  }
}

/** A second line, when the step has something more to say. */
export function stageCardDetail(status: ContextStageStatus): string | null {
  if (status.step === 'applied' && status.message) return status.message;
  if (status.step === 'applied' && status.auto && status.reason === 'new-conversation') {
    return 'A new conversation starts without YaRN, which costs every reply a little quality.';
  }
  return null;
}

/**
 * Whether a snapshot's `context_stage` may become the conversation's card.
 *
 * A reconnect's catch-up re-syncs the conversation's last few runs, and a
 * finished stage run's `context_stage` stays in the log for the stream TTL.
 * Two things must not bring a card back: an older finished run replacing a
 * newer card, and a card the person already dismissed by sending again — for
 * which "no card" is indistinguishable from "never had one" unless the
 * dismissed run's id is remembered (`dropped`). Without that the card came
 * back above a newer reply on every reconnect until the log expired.
 */
export function shouldInstallStageSnapshot(input: {
  have: StageCard | null | undefined;
  dropped: ReadonlySet<string>;
  streamId: string;
  runActive: boolean;
}): boolean {
  if (input.dropped.has(input.streamId)) return false;
  if (input.have && input.have.streamId !== input.streamId && !input.runActive) return false;
  return true;
}
