/**
 * The progress review: every so often a second model call looks at a run and
 * decides whether it is still getting somewhere. It replaced the mechanical
 * loop detector and the step-limit check-in, and it asks nobody: a run that is
 * stuck is told so, and one that stays stuck, or already has its answer, is
 * told to answer.
 *
 * Why a model and not a rule: the run that prompted this went 91 steps over
 * eight hours without repeating a single tool call. It had its answer by step
 * seventy-five and kept re-verifying it. No count of repeats sees that; a
 * reader of its last few steps does.
 *
 * The reviewer is shown a digest, never the run's own context: a few thousand
 * tokens it can read in a minute or two on a slow local backend, where the
 * run's context can be past 150K. It runs beside the run on a spare inference
 * slot when the backend has one, and otherwise the run pauses at a step
 * boundary and lends it its own (`tryAcquireRunSlot`).
 *
 * Everything that decides is pure and exported for the unit tests; the
 * `ProgressReviewer` class only sequences them for the engine.
 */
import {
  DEFAULT_PROGRESS_CHECK_MS,
  DEFAULT_PROGRESS_CHECK_STEPS,
  MAX_PROGRESS_CHECK_MS,
  MAX_PROGRESS_CHECK_STEPS,
  MAX_PROGRESS_REVIEW_PROMPT_CHARS,
  MIN_PROGRESS_CHECK_MS,
  MIN_PROGRESS_CHECK_STEPS,
  type ReviewAction,
  type ReviewMode,
  type ReviewVerdict,
} from "@loxaic/types";
import { streamCompletion, type ChatMessage } from "../../inference/provider.ts";
import { tryAcquireRunSlot } from "../../inference/scheduler.ts";
import { REVIEW_OUTPUT_CONTRACT } from "./review-marker.ts";

/** The reviewer's instructions when the user has not written their own. */
export const DEFAULT_REVIEW_PROMPT = [
  "You are checking on an AI agent partway through a task, to decide whether it is still making progress.",
  "You are shown its task, its most recent steps, the end of its latest thinking, and how long it has been working.",
  "",
  "Decide one of:",
  "- progressing: it is doing new, useful work towards the task.",
  "- stuck: it is repeating itself, going round in circles, retrying something that keeps failing the same way, or drifting away from the task.",
  "- finished: it already has what it needs to answer, and is only re-checking, re-verifying or polishing work that is done.",
  "",
  "Judge by what the steps show, not by how long they took: slow, steady work is progressing.",
  "Write the reason as one sentence to the agent itself, naming what it keeps repeating, or what it already has.",
].join("\n");

// Appended after the instructions, whoever wrote them, so a tweaked prompt
// cannot break the one thing `parseVerdict` needs. The mock backend recognises
// a review request by it.
export { REVIEW_OUTPUT_CONTRACT };

/** How long a review may take before it counts as no verdict. Read at call
 * time, so a test can shorten it. */
export function reviewDeadlineMs(): number {
  const raw = Number(process.env.REVIEW_DEADLINE_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 5 * 60 * 1000;
}

/** The working time between reviews when the user has not chosen one: the
 * operator's `PROGRESS_CHECK_MS`, else 30 minutes. No lower bound, so a test
 * can set a few seconds; read at call time for the same reason. */
export function serverDefaultProgressCheckMs(): number {
  const raw = Number(process.env.PROGRESS_CHECK_MS);
  return Number.isFinite(raw) && raw > 0 ? Math.min(raw, MAX_PROGRESS_CHECK_MS) : DEFAULT_PROGRESS_CHECK_MS;
}

/** As `serverDefaultProgressCheckMs`, for steps: `PROGRESS_CHECK_STEPS`. */
export function serverDefaultProgressCheckSteps(): number {
  const raw = Number(process.env.PROGRESS_CHECK_STEPS);
  return Number.isInteger(raw) && raw > 0 ? Math.min(raw, MAX_PROGRESS_CHECK_STEPS) : DEFAULT_PROGRESS_CHECK_STEPS;
}

/** Stored values made safe, on read as well as on write: the columns are
 * plain data. Null stays null — it means the server's default. */
export function clampProgressCheckMs(value: number | null | undefined): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  return Math.min(MAX_PROGRESS_CHECK_MS, Math.max(MIN_PROGRESS_CHECK_MS, Math.round(value)));
}
export function clampProgressCheckSteps(value: number | null | undefined): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  return Math.min(MAX_PROGRESS_CHECK_STEPS, Math.max(MIN_PROGRESS_CHECK_STEPS, Math.round(value)));
}
/** A stored prompt that is blank or too long is not used. */
export function usableReviewPrompt(value: string | null | undefined): string | null {
  if (typeof value !== "string" || !value.trim() || value.length > MAX_PROGRESS_REVIEW_PROMPT_CHARS) return null;
  return value;
}

/** What a run needs to know about its user's review settings, resolved. */
export interface ReviewPrefs {
  enabled: boolean;
  everyMs: number;
  everySteps: number;
  instructions: string;
}

export function resolveReviewPrefs(row: {
  progressReview?: boolean | null;
  progressCheckMs?: number | null;
  progressCheckSteps?: number | null;
  progressReviewPrompt?: string | null;
} | null | undefined): ReviewPrefs {
  return {
    enabled: row?.progressReview ?? true,
    everyMs: clampProgressCheckMs(row?.progressCheckMs) ?? serverDefaultProgressCheckMs(),
    everySteps: clampProgressCheckSteps(row?.progressCheckSteps) ?? serverDefaultProgressCheckSteps(),
    instructions: usableReviewPrompt(row?.progressReviewPrompt) ?? DEFAULT_REVIEW_PROMPT,
  };
}

/** Whether a review is due: after `everySteps` steps or `everyMs` of working
 * time since the last one, whichever comes first. */
export function reviewDue(input: { stepsSinceReview: number; workedMsSinceReview: number; everyMs: number; everySteps: number }): boolean {
  return input.stepsSinceReview >= input.everySteps || input.workedMsSinceReview >= input.everyMs;
}

/** One finished step, as the digest describes it. */
export interface DigestStep {
  calls: { tool: string; args: string; result: string; ok: boolean }[];
  /** Send to the end of its tools. */
  ms: number;
  thinkingChars: number;
  completionTokens: number | null;
}

/** How many recent steps the digest shows. */
export const DIGEST_STEPS = 10;
const TASK_CHARS = 3_000;
const ARGS_CHARS = 300;
const RESULT_CHARS = 300;
const TEXT_CHARS = 1_500;
const THINKING_CHARS = 4_000;

/** Head and tail of a long string, so both the ask and its end survive. */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const half = Math.floor((max - 5) / 2);
  return `${text.slice(0, half)} […] ${text.slice(text.length - half)}`;
}

function minutes(ms: number): string {
  const m = ms / 60_000;
  return m < 1 ? `${String(Math.round(ms / 1000))} s` : `${m.toFixed(m < 10 ? 1 : 0)} min`;
}

/**
 * What the reviewer reads. Bounded whatever the run did: every part has its
 * own budget, so a run at 180K tokens still yields a digest of a few thousand.
 */
export function reviewDigest(input: {
  task: string;
  subagent: boolean;
  steps: readonly DigestStep[];
  stepsDone: number;
  workedMs: number;
  lastText: string;
  thinkingTail: string;
  contextTokens: number | null;
  previous: { verdict: ReviewVerdict | null; reason?: string } | null;
}): string {
  const out: string[] = [];
  out.push(input.subagent ? "## Task (handed to this agent by another agent)" : "## Task (the user's latest message)");
  out.push(clip(input.task.trim() || "(empty)", TASK_CHARS));
  out.push("");
  out.push("## So far");
  out.push(`- ${String(input.stepsDone)} steps, ${minutes(input.workedMs)} of working time`);
  if (input.contextTokens != null) out.push(`- context: about ${String(input.contextTokens)} tokens`);
  if (input.previous) {
    out.push(
      `- last review: ${input.previous.verdict ?? "no verdict"}${input.previous.reason ? ` — ${input.previous.reason}` : ""}`,
    );
  }
  out.push("");
  const recent = input.steps.slice(-DIGEST_STEPS);
  const first = input.stepsDone - recent.length + 1;
  out.push(`## Its last ${String(recent.length)} steps, oldest first`);
  recent.forEach((step, i) => {
    const tokens = step.completionTokens != null ? `, wrote ${String(step.completionTokens)} tokens` : "";
    out.push(`### Step ${String(first + i)} (${minutes(step.ms)}, ${String(step.thinkingChars)} characters of thinking${tokens})`);
    if (step.calls.length === 0) out.push("(no tool calls)");
    for (const call of step.calls) {
      out.push(`- ${call.tool} ${clip(call.args, ARGS_CHARS)}`);
      out.push(`  ${call.ok ? "→" : "✗"} ${clip(call.result.replace(/\s+/g, " ").trim(), RESULT_CHARS)}`);
    }
  });
  if (input.lastText.trim()) {
    out.push("");
    out.push("## Its latest words to the user");
    out.push(clip(input.lastText.trim(), TEXT_CHARS));
  }
  if (input.thinkingTail.trim()) {
    out.push("");
    out.push("## The end of its latest thinking");
    const t = input.thinkingTail.trim();
    out.push(t.length > THINKING_CHARS ? `[…] ${t.slice(t.length - THINKING_CHARS)}` : t);
  }
  return out.join("\n");
}

/** The request a review sends: the instructions, then the fixed contract. */
export function reviewMessages(instructions: string, digest: string): ChatMessage[] {
  return [
    { role: "system", content: `${instructions.trim()}\n\n${REVIEW_OUTPUT_CONTRACT}` },
    { role: "user", content: digest },
  ];
}

const VERDICTS: readonly ReviewVerdict[] = ["progressing", "stuck", "finished"];

/** The reviewer's reply, read: the JSON object bare, fenced, or among other
 * words. Anything else is no verdict. */
export function parseVerdict(text: string): { verdict: ReviewVerdict; reason: string } | null {
  const candidates: string[] = [];
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  if (fenced) candidates.push(fenced[1]);
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first >= 0 && last > first) candidates.push(text.slice(first, last + 1));
  for (const raw of candidates) {
    try {
      const parsed = JSON.parse(raw) as { verdict?: unknown; reason?: unknown };
      const verdict = typeof parsed.verdict === "string" ? parsed.verdict.trim().toLowerCase() : "";
      if (!(VERDICTS as readonly string[]).includes(verdict)) continue;
      const reason = typeof parsed.reason === "string" ? parsed.reason.trim().replace(/\s+/g, " ").slice(0, 500) : "";
      return { verdict: verdict as ReviewVerdict, reason };
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

/** The streaks a run carries from one review to the next. */
export interface ReviewStreak {
  /** The last verdict was `stuck`. */
  stuck: boolean;
  /** The last review gave no verdict. */
  missed: boolean;
}

/**
 * What a verdict does.
 *
 * A sub-agent is told to answer on anything but `progressing`: its parent is
 * waiting on it, and a partial report beats a child that never returns —
 * including when the reviewer itself could not say (a backend too busy to
 * answer a review in time is exactly when an all-night run costs most).
 *
 * A run a person started is steered first, and told to answer only when it is
 * stuck at two reviews in a row, or has its answer already. A review that
 * gives no verdict leaves it alone, unless the one before gave none either:
 * then nothing is watching it, and it answers.
 */
export function reviewOutcome(input: {
  subagent: boolean;
  verdict: ReviewVerdict | null;
  streak: ReviewStreak;
}): { action: ReviewAction; streak: ReviewStreak } {
  const { verdict, streak } = input;
  const next: ReviewStreak = { stuck: verdict === "stuck", missed: verdict === null };
  if (verdict === "progressing") return { action: "none", streak: next };
  if (input.subagent || verdict === "finished") return { action: "answer", streak: next };
  if (verdict === "stuck") return { action: streak.stuck ? "answer" : "steer", streak: next };
  return { action: streak.missed ? "answer" : "none", streak: next };
}

/** Sends one review and reads its verdict. Null for no verdict: the deadline
 * passed, the request failed, or the reply could not be read. Never throws. */
export async function reviewRun(input: {
  model: string;
  messages: ChatMessage[];
  thinking: Record<string, unknown>;
  signal: AbortSignal;
}): Promise<{ verdict: ReviewVerdict; reason: string } | null> {
  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(reviewDeadlineMs())]);
  let text = "";
  try {
    // No `conversationId`: this is not the conversation's next turn, and must
    // neither restore its saved cache nor be mistaken for it.
    for await (const event of streamCompletion(input.model, input.messages, {
      signal,
      thinking: input.thinking,
      maxTokens: 1_500,
    })) {
      if (event.type === "delta") text += event.content;
      else if (event.type === "done") text = event.result.content || text;
    }
  } catch (err) {
    if (!signal.aborted) console.warn(`progress review failed: ${(err as Error).message}`);
    return null;
  }
  return parseVerdict(text);
}

/** What the engine is handed to act on. */
export interface ReviewDecision {
  verdict: ReviewVerdict | null;
  reason: string;
  action: ReviewAction;
}

/**
 * Sequences reviews for one run. The engine calls `recordStep` and then
 * `atStepEnd` after every step, and acts on what `atStepEnd` returns; a review
 * that finishes beside the run while it is generating calls `interrupt`, which
 * the engine wires to the current request.
 */
export class ProgressReviewer {
  private readonly steps: DigestStep[] = [];
  private stepsDone = 0;
  private stepsAtLast = 0;
  private workedAtLast = 0;
  private streak: ReviewStreak = { stuck: false, missed: false };
  private previous: { verdict: ReviewVerdict | null; reason?: string } | null = null;
  private inFlight: Promise<void> | null = null;
  private ready: ReviewDecision | null = null;
  private readonly cancel = new AbortController();
  private disposed = false;
  private lastText = "";
  private thinkingTail = "";
  private contextTokens: number | null = null;
  /** Set by the engine while a model request streams: ends that request so a
   * decision lands now rather than after a long generation. */
  interrupt: (() => void) | null = null;

  constructor(
    private readonly opts: {
      prefs: ReviewPrefs;
      subagent: boolean;
      task: string;
      model: string;
      providerId: string;
      thinking: Record<string, unknown>;
      runSignal: AbortSignal;
      /** The run's working time so far: wall clock less every wait. */
      workedMs: () => number;
      /** The per-conversation switch, read live. */
      switchedOff: () => boolean;
      emit: (event: { kind: "run.review.start"; mode: ReviewMode } | ({ kind: "run.review.end" } & Omit<ReviewDecision, "reason"> & { reason?: string })) => void;
    },
  ) {}

  /** A finished step, for the digest. */
  recordStep(step: DigestStep, latest: { text: string; thinking: string; contextTokens: number | null }): void {
    this.stepsDone += 1;
    this.steps.push(step);
    if (this.steps.length > DIGEST_STEPS) this.steps.shift();
    if (latest.text.trim()) this.lastText = latest.text;
    if (latest.thinking.trim()) this.thinkingTail = latest.thinking.slice(-8_000);
    if (latest.contextTokens != null) this.contextTokens = latest.contextTokens;
  }

  /** Whether a review beside the run has decided something the run must act
   * on, and it has not been taken yet. */
  hasDecision(): boolean {
    return this.ready !== null && this.ready.action !== "none";
  }

  /** A decision from a review that ran beside the run, if one is waiting and
   * calls for something. Taken once. */
  takeReady(): ReviewDecision | null {
    const ready = this.ready;
    this.ready = null;
    return ready && ready.action !== "none" ? ready : null;
  }

  /**
   * After a step: a waiting decision if there is one; otherwise, if a review
   * is due, one starts — beside the run (returns null at once) or, without a
   * spare slot, in the run's own slot (returns its decision).
   */
  async atStepEnd(): Promise<ReviewDecision | null> {
    const waiting = this.takeReady();
    if (waiting) return waiting;
    if (this.disposed || this.inFlight || !this.opts.prefs.enabled || this.opts.switchedOff()) return null;
    const workedMs = this.opts.workedMs();
    if (
      !reviewDue({
        stepsSinceReview: this.stepsDone - this.stepsAtLast,
        workedMsSinceReview: workedMs - this.workedAtLast,
        everyMs: this.opts.prefs.everyMs,
        everySteps: this.opts.prefs.everySteps,
      })
    ) {
      return null;
    }
    const messages = reviewMessages(
      this.opts.prefs.instructions,
      reviewDigest({
        task: this.opts.task,
        subagent: this.opts.subagent,
        steps: this.steps,
        stepsDone: this.stepsDone,
        workedMs,
        lastText: this.lastText,
        thinkingTail: this.thinkingTail,
        contextTokens: this.contextTokens,
        previous: this.previous,
      }),
    );
    const spare = await tryAcquireRunSlot(this.opts.providerId);
    // Through a call: the check above narrowed the field, and the await is
    // exactly when the run can end.
    if (this.isDisposed()) {
      spare?.release();
      return null;
    }
    if (spare) {
      this.opts.emit({ kind: "run.review.start", mode: "alongside" });
      this.inFlight = this.review(messages)
        .then((decision) => {
          if (this.isDisposed()) return;
          this.ready = decision;
          if (decision.action !== "none") this.interrupt?.();
        })
        // `review` never throws by design; a fault there must still not
        // become an unhandled rejection, which would take the server down.
        .catch((err: unknown) => {
          console.warn(`progress review beside a run failed: ${(err as Error).message}`);
        })
        .finally(() => {
          spare.release();
          this.inFlight = null;
        });
      return null;
    }
    this.opts.emit({ kind: "run.review.start", mode: "paused" });
    const decision = await this.review(messages);
    return decision.action === "none" ? null : decision;
  }

  private async review(messages: ChatMessage[]): Promise<ReviewDecision> {
    const signal = AbortSignal.any([this.opts.runSignal, this.cancel.signal]);
    const read = await reviewRun({ model: this.opts.model, messages, thinking: this.opts.thinking, signal });
    const verdict = read?.verdict ?? null;
    const reason = read?.reason ?? "";
    const outcome = reviewOutcome({ subagent: this.opts.subagent, verdict, streak: this.streak });
    const { streak } = outcome;
    // Switched off while the review ran: its verdict is still said, but it no
    // longer steers or ends a run its owner just asked to be left alone.
    const action = this.opts.switchedOff() ? "none" : outcome.action;
    // A stop or the run ending says nothing about the run's progress: no
    // verdict is recorded and no event follows the stream's end.
    if (this.isDisposed() || (signal.aborted && !read)) return { verdict: null, reason: "", action: "none" };
    this.streak = streak;
    this.previous = { verdict, ...(reason ? { reason } : {}) };
    this.stepsAtLast = this.stepsDone;
    this.workedAtLast = this.opts.workedMs();
    this.opts.emit({ kind: "run.review.end", verdict, ...(reason ? { reason } : {}), action });
    return { verdict, reason, action };
  }

  private isDisposed(): boolean {
    return this.disposed;
  }

  /** The run is ending: a review beside it is abandoned, and says nothing. */
  dispose(): void {
    this.disposed = true;
    this.cancel.abort();
    this.interrupt = null;
  }
}
