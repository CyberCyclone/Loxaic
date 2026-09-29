import type { ContextStageInfo } from '@loxaic/api-client';
import { CONTEXT_STAGE_PROMPT_AT, type ModelContextStage } from '@loxaic/types';

/**
 * The decisions behind the YaRN context-stage UI, kept out of the components
 * so each can be tested without rendering one: when to offer Extend, when to
 * offer stepping back down, when a smaller stage needs compacting first, and
 * the sentences that say what a switch costs other people.
 *
 * A stage is model-wide (a llama.cpp load is shared), so most of what a modal
 * says is about who else is on the model and what a reload costs them.
 */

/** What a window can hold before it is full — the server's automatic
 * compaction default, so "fits this stage" and "would compact here" agree. */
export const STAGE_FIT_SHARE = 0.85;

/** `262144` → "256K", `1048576` → "1M", `786432` → "768K". */
export function formatWindow(tokens: number | null | undefined): string {
  if (tokens == null) return 'unknown';
  if (tokens >= 1024 * 1024) {
    const m = tokens / (1024 * 1024);
    return `${Number.isInteger(m) ? String(m) : m.toFixed(1)}M`;
  }
  if (tokens >= 1024) return `${String(Math.round(tokens / 1024))}K`;
  return String(tokens);
}

/** "512K · YaRN 2×", "256K · standard", or just "80K" for a larger stage that
 * needs no YaRN (no bigger than the model was trained for). */
export function stageLabel(window: number | null, yarnFactor: number | null, isStandard: boolean): string {
  if (yarnFactor !== null) return `${formatWindow(window)} · YaRN ${String(yarnFactor)}×`;
  return isStandard ? `${formatWindow(window)} · standard` : formatWindow(window);
}

/** The stage the model is at, and whether the next one exists. */
export function nextStage(stage: Pick<ModelContextStage, 'active' | 'windows'>): number | null {
  const next = stage.active + 1;
  return next < stage.windows.length ? next : null;
}

/** Whether this person may move the stage by hand. */
export function mayChangeStage(stage: Pick<ModelContextStage, 'who_may_change'>, isAdmin: boolean): boolean {
  return isAdmin || stage.who_may_change === 'everyone';
}

/** How full the conversation is at the model's *current* stage. Computed from
 * the stage's own window rather than the ring's, which keeps the last turn's
 * window until the next turn and would read as still full right after an
 * extension. */
export function stageFill(usedTokens: number, stage: Pick<ModelContextStage, 'active' | 'windows'>): number | null {
  const window = stage.windows[stage.active] as number | null | undefined;
  return window ? usedTokens / window : null;
}

export interface ApproachingInput {
  stage: ModelContextStage | undefined;
  usedTokens: number;
  /** Nothing is offered mid-reply: a decision about a reload should come when
   * the turn has ended. */
  streaming: boolean;
  /** A viewer, offline, or a routine — nobody who can act on the thread. */
  readOnly: boolean;
  /** Prompts already shown this session, by key. */
  shown: ReadonlySet<string>;
  conversationId: string | null;
}

export function approachingKey(conversationId: string, stage: number): string {
  return `${conversationId}:${String(stage)}:approaching`;
}

/**
 * Offer Compact or Extend: the conversation is past 75% of this stage's window
 * (below the server's automatic compaction at 85%, so the choice comes first),
 * a next stage exists, and this model is not set to extend by itself — an
 * admin who chose that has already decided.
 */
export function shouldPromptApproaching(i: ApproachingInput): boolean {
  const { stage } = i;
  if (!stage || !i.conversationId || i.streaming || i.readOnly) return false;
  if (stage.when_full === 'extend') return false;
  if (nextStage(stage) === null) return false;
  const fill = stageFill(i.usedTokens, stage);
  if (fill === null || fill < CONTEXT_STAGE_PROMPT_AT) return false;
  return !i.shown.has(approachingKey(i.conversationId, stage.active));
}

export function stepDownKey(conversationId: string, stage: number): string {
  return `${conversationId}:${String(stage)}:down`;
}

/**
 * Offer stepping back down on reopening a conversation that needs less than
 * the model is loaded at. `info.recommended` is the smallest stage that holds
 * it; a new conversation never asks (the server steps down for it).
 */
export function shouldPromptStepDown(input: {
  stage: ModelContextStage | undefined;
  info: Pick<ContextStageInfo, 'recommended' | 'may_change' | 'blocked_down_to'> | null;
  conversationId: string | null;
  readOnly: boolean;
  shown: ReadonlySet<string>;
}): boolean {
  const { stage, info } = input;
  if (!stage || !info || !input.conversationId || input.readOnly || !info.may_change) return false;
  if (stage.active === 0 || info.recommended >= stage.active) return false;
  // Nothing to offer when another conversation keeps the model where it is.
  if (Math.max(info.recommended, info.blocked_down_to) >= stage.active) return false;
  return !input.shown.has(stepDownKey(input.conversationId, stage.active));
}

/** The stage a step-down offers: as low as this conversation and everyone
 * else's allow. */
export function stepDownTarget(info: Pick<ContextStageInfo, 'recommended' | 'blocked_down_to'>): number {
  return Math.max(info.recommended, info.blocked_down_to);
}

/** Whether moving to a window this small must compact the conversation first. */
export function needsCompactFirst(usedTokens: number | null, targetWindow: number | null): boolean {
  if (usedTokens === null || targetWindow === null) return false;
  return usedTokens >= targetWindow * STAGE_FIT_SHARE;
}

/** "4 minutes ago" — the last time anyone else used the model. */
export function formatAgo(iso: string | null, now: number): string | null {
  if (!iso) return null;
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 45) return 'just now';
  if (s < 90) return 'a minute ago';
  const m = Math.round(s / 60);
  if (m < 60) return `${String(m)} minutes ago`;
  const h = Math.round(m / 60);
  return h === 1 ? 'an hour ago' : `${String(h)} hours ago`;
}

/**
 * What a switch does to everyone else on the model, or null when nobody else
 * has used it lately. Never names anyone: another person's conversation is
 * not the asker's to see.
 */
export function othersWarning(others: ContextStageInfo['others'], now: number): { text: string; waits: boolean } | null {
  if (others.count === 0) return null;
  const many = others.count === 1 ? '1 other conversation is' : `${String(others.count)} other conversations are`;
  const ago = formatAgo(others.last_used_at, now);
  const last = ago ? `, last used ${ago}` : '';
  const text = `${many} using this model${last}. Switching reloads it for them too: their next reply re-reads their conversation.`;
  if (others.running === 0) return { text, waits: false };
  const replying = others.running === 1 ? '1 is replying right now' : `${String(others.running)} are replying right now`;
  return { text: `${text} ${replying}, so the switch will wait until ${others.running === 1 ? 'it finishes' : 'they finish'}.`, waits: true };
}

/** "about 2 min" for the re-read after a reload; null when not known. */
export function formatRereadTime(seconds: number | null): string | null {
  if (seconds === null) return null;
  if (seconds < 5) return 'a few seconds';
  if (seconds < 90) return `about ${String(Math.round(seconds))} s`;
  return `about ${String(Math.round(seconds / 60))} min`;
}

/** "about 6 GB more memory". */
export function formatExtraMemory(bytes: number): string | null {
  if (bytes <= 0) return null;
  const gb = bytes / 1024 ** 3;
  return gb >= 10 ? `about ${String(Math.round(gb))} GB more memory` : `about ${gb.toFixed(1)} GB more memory`;
}
