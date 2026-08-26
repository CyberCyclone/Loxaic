import { useMemo } from 'react';
import type { ContextCategory, Message } from '@/lib/types';
import type { ModelWindow } from './useModels';

/**
 * Turns the last turn's usage into everything the context meter renders.
 *
 * The arithmetic this replaces summed `usage.in` across every message in the
 * thread. That double-counts badly: each turn's `prompt_tokens` already
 * contains the entire prior conversation, so an N-turn thread counted its
 * history N times and the reported figure grew quadratically. What actually
 * occupies the window is just the most recent turn's prompt plus its reply —
 * which is exactly what the next prompt will start from.
 */

export interface ContextSegment {
  category: ContextCategory | 'free' | 'used';
  label: string;
  tokens: number;
  /** Share of the window, for the stacked bar. */
  fraction: number;
}

export interface LastTurn {
  in: number;
  out: number;
  promptTps: number | null;
  genTps: number | null;
  totalMs: number | null;
}

export interface ContextView {
  /** Deliberately NOT clamped — being over the window is the single most
   * useful thing this indicator can tell you. */
  percent: number;
  used: number;
  /** null when no window could be resolved; the UI must say so, not guess. */
  window: number | null;
  /** Negative when over budget. */
  free: number | null;
  segments: ContextSegment[];
  breakdownAvailable: boolean;
  truncated: boolean;
  historyMessages: number;
  historyLimit: number;
  windowSource: ModelWindow['source'];
  maxWindow: number | null;
  lastTurn: LastTurn | null;
}

const LABELS: Record<ContextCategory | 'free' | 'used', string> = {
  used: 'Context used',
  system: 'System prompt',
  tools: 'Tool definitions',
  summary: 'Compacted summary',
  history: 'Conversation history',
  reasoning: 'Reasoning (carried over)',
  tool_io: 'Tool calls & results',
  current: 'Current message',
  response: 'Latest response',
  free: 'Free space',
};

export function useContextUsage(msgs: Message[] | undefined, window: ModelWindow | null): ContextView | null {
  return useMemo(() => {
    if (!msgs) return null;

    // The newest turn that actually reported usage. Walking backwards matters:
    // a still-streaming assistant message has no usage yet, and an errored one
    // may never get any.
    const last = [...msgs].reverse().find((m) => m.usage);
    const usage = last?.usage;
    const breakdown = usage?.context;

    // The server tells us the window the prompt was really assembled against.
    // Prefer it: the model list can be mid-refresh, or the conversation's model
    // may have changed since it was fetched.
    const effective = breakdown?.window_tokens ?? window?.effective ?? null;
    // Identical to usage.in + usage.out by construction on an ordinary turn —
    // but not after a compaction, where the breakdown describes the
    // post-compaction window while `usage` still carries the compact call's
    // own (much larger) prompt_tokens. Preferring the breakdown is what keeps
    // the ring from jumping up right after compacting.
    const used = breakdown ? breakdown.used_tokens : usage ? usage.in + usage.out : 0;
    const percent = effective && effective > 0 ? Math.round((used / effective) * 100) : 0;

    const frac = (n: number) => (effective && effective > 0 ? n / effective : 0);
    const segments: ContextSegment[] = [];
    if (breakdown?.parts.length) {
      for (const part of breakdown.parts) {
        segments.push({
          category: part.category,
          label: LABELS[part.category],
          tokens: part.tokens,
          fraction: frac(part.tokens),
        });
      }
      segments.sort((a, b) => b.tokens - a.tokens);
    } else if (used > 0) {
      // No per-category detail, but the window is still measurably occupied —
      // show it as one fill rather than an empty bar that reads as "0 used".
      segments.push({ category: 'used', label: LABELS.used, tokens: used, fraction: frac(used) });
    }

    const free = effective != null ? effective - used : null;
    if (free != null && free > 0) {
      segments.push({ category: 'free', label: LABELS.free, tokens: free, fraction: frac(free) });
    }

    return {
      percent,
      used,
      window: effective,
      free,
      segments,
      breakdownAvailable: !!breakdown?.parts.length,
      truncated: !!breakdown?.history_truncated,
      historyMessages: breakdown?.history_messages ?? 0,
      historyLimit: breakdown?.history_limit ?? 0,
      windowSource: window?.source ?? null,
      maxWindow: window?.max ?? null,
      lastTurn: usage
        ? {
            in: usage.in,
            out: usage.out,
            promptTps: usage.promptTps ?? null,
            genTps: usage.tps || null,
            totalMs: usage.totalMs ?? null,
          }
        : null,
    };
  }, [msgs, window]);
}
