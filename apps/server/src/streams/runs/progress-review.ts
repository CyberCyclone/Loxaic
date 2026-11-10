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
 * A run nobody is watching (a sub-agent, a routine) is reviewed whatever its
 * user's settings say, and has a ceiling on its working time besides: the one
 * bound here that no setting and no verdict lifts (`unattendedRunLimitMs`).
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
  PLAN_ACCEPTED_MESSAGE,
  isNudgeText,
  type ReviewAction,
  type ReviewMode,
  type ReviewVerdict,
} from "@loxaic/types";
import { PLAN_TOOL_NAME } from "@loxaic/agent";
import { streamCompletion, textOfContent, type ChatMessage, type CompletionResult } from "../../inference/provider.ts";
import { tryAcquireRunSlot } from "../../inference/scheduler.ts";
import { REVIEW_OUTPUT_CONTRACT } from "./review-marker.ts";

/** The reviewer's instructions when the user has not written their own. */
export const DEFAULT_REVIEW_PROMPT = [
  "You are checking on an AI agent partway through a task, to decide whether it is still making progress.",
  "You are shown its task, its most recent steps, the end of its latest thinking, how long it has been working, and what earlier checks like this one said.",
  "",
  "Decide one of:",
  "- progressing: it is doing new, useful work towards the task.",
  "- stuck: it is repeating itself, going round in circles, retrying something that keeps failing the same way, or drifting away from the task.",
  "- finished: it already has what it needs to answer (a result, or an explanation its evidence supports) and is only re-checking, collecting more confirmation or polishing.",
  "",
  "An agent rarely notices by itself that it is finished: each further check looks useful to it. So judge the direction, not one step. If earlier checks already said it was confirming a conclusion or gathering a last piece of evidence, and it is still confirming that same conclusion, it is finished. Weigh the time spent against the size of the task: hours on one narrow question mean it has what it needs.",
  "A step being slow is not a fault by itself: slow, steady work on something new is progressing.",
  "Sometimes you are shown a reply it is still writing, with how its thinking began, where it was half way, and where it is now. Thinking that keeps moving to new ground is progressing, however long. Thinking that has come back to the question it started from, or keeps weighing the same possibilities without settling one, is stuck; thinking that has already reached its conclusion and goes on checking it is finished. When you are told that much of the reply repeats itself word for word, it is going round: stuck.",
  "Waiting on something that is still running is progressing too: an agent that runs the same command to poll a build, a test run or a download is not stuck while that job is still going or its output is still changing. It is stuck only when the thing it waits for has ended or stopped moving and it keeps polling anyway.",
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

/** The working time a run nobody is watching may take when the operator has
 * not said: four hours. */
export const DEFAULT_UNATTENDED_RUN_LIMIT_MS = 4 * 60 * 60 * 1000;

/**
 * The most working time a sub-agent or a routine gets: the operator's
 * `UNATTENDED_RUN_LIMIT_MS`, else four hours. Past it the run is told to
 * answer, whatever its reviews said and whatever its user's settings are — a
 * review is a model's opinion, and a run with nobody to press Stop needs one
 * bound that is not. Not a user setting on purpose. Read at call time.
 */
export function unattendedRunLimitMs(): number {
  const raw = Number(process.env.UNATTENDED_RUN_LIMIT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_UNATTENDED_RUN_LIMIT_MS;
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

/** Whether a run is reviewed at all. Its user's setting decides for a run
 * they are in; a run nobody is watching is always reviewed. */
export function reviewsOn(prefs: Pick<ReviewPrefs, "enabled">, unattended: boolean): boolean {
  return prefs.enabled || unattended;
}

interface DueInput {
  stepsSinceReview: number;
  workedMsSinceReview: number;
  everyMs: number;
  everySteps: number;
}

/** Which cadence makes a review due, if either: `everyMs` of working time or
 * `everySteps` steps since the last one. Time is named when both do. */
export function reviewTrigger(input: DueInput): "time" | "steps" | null {
  if (input.workedMsSinceReview >= input.everyMs) return "time";
  return input.stepsSinceReview >= input.everySteps ? "steps" : null;
}

/** Whether a review is due, on either cadence. */
export function reviewDue(input: DueInput): boolean {
  return reviewTrigger(input) !== null;
}

/**
 * How much one reply may write, thinking and words together, before a review
 * looks at it while it is still being written — and again each time it has
 * written that much more.
 *
 * By size and not by time: it is what the run that prompted all this had and
 * healthy ones did not. Its replies ran to 20–93K characters of thinking with
 * nothing in them repeated word for word (so no count of repeats sees it),
 * where two long runs that were getting on with their work never wrote 8K in
 * one reply. And it is the same on a backend ten times as fast.
 */
export const REPLY_REVIEW_CHARS = 24_000;

/** Whether a reply has written enough since it was last looked at. */
export function replyReviewDue(writtenChars: number, charsAtLastLook: number): boolean {
  return writtenChars - charsAtLastLook >= REPLY_REVIEW_CHARS;
}

/** The context past which a review in the run's own slot waits for the time
 * cadence. */
export const PAUSED_STEP_REVIEW_MAX_CONTEXT = 32_000;

/**
 * Whether a review that has to borrow the run's own slot is worth it.
 *
 * On a backend with one slot the review's prompt takes the slot the run's
 * cached context was in, so the run's next request reads its whole context
 * again: minutes, at 150K tokens. Paying that every `everySteps` steps would
 * cost a fast run more than the review saves, so past a modest context only
 * the time cadence pauses a run. A review on a spare slot costs nothing of
 * the kind and is never held back.
 */
export function worthPausingFor(trigger: "time" | "steps", contextTokens: number | null): boolean {
  return trigger === "time" || contextTokens === null || contextTokens <= PAUSED_STEP_REVIEW_MAX_CONTEXT;
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
// The whole task section; its parts (reviewTask) come to less.
const TASK_CHARS = 6_000;
const LATEST_ASK_CHARS = 2_000;
const PLAN_CHARS = 2_500;
const FIRST_ASK_CHARS = 1_000;
const ARGS_CHARS = 300;
const RESULT_CHARS = 300;
const TEXT_CHARS = 1_500;
const THINKING_CHARS = 4_000;
const PAST_REASON_CHARS = 300;
const REPLY_START_CHARS = 1_200;
const REPLY_MIDDLE_CHARS = 1_200;
const REPLY_END_CHARS = 3_000;

/** Head and tail of a long string, so both the ask and its end survive. */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const half = Math.floor((max - 5) / 2);
  return `${text.slice(0, half)} […] ${text.slice(text.length - half)}`;
}

function minutes(ms: number): string {
  const m = ms / 60_000;
  if (m >= 90) return `${(m / 60).toFixed(1)} h`;
  return m < 1 ? `${String(Math.round(ms / 1000))} s` : `${m.toFixed(m < 10 ? 1 : 0)} min`;
}

/** A review this run has already had, as the next one is told about it. */
export interface PastReview {
  /** The steps the run had finished when it was taken. */
  step: number;
  /** Its working time by then. */
  workedMs: number;
  verdict: ReviewVerdict | null;
  reason?: string;
}

/** How many earlier reviews the digest carries. */
export const DIGEST_PAST_REVIEWS = 5;

/** One message of the run's history, as far as the task needs it. */
export interface TaskEntry {
  role: string;
  text: string;
  /** The plan, when this is the assistant's `propose_plan` call. */
  plan?: string;
}

/** A run's history, as `reviewTask` reads it. */
export function taskEntries(messages: readonly ChatMessage[]): TaskEntry[] {
  return messages.map((m) => {
    if (m.role === "assistant") {
      const call = m.tool_calls?.find((c) => c.function.name === PLAN_TOOL_NAME);
      let plan: string | undefined;
      try {
        const args: unknown = call ? JSON.parse(call.function.arguments) : null;
        const said = (args as { plan?: unknown } | null)?.plan;
        if (typeof said === "string") plan = said;
      } catch {
        // Arguments that are not JSON carry no plan.
      }
      return { role: m.role, text: m.content ?? "", ...(plan ? { plan } : {}) };
    }
    return { role: m.role, text: m.role === "user" ? textOfContent(m.content) : m.content };
  });
}

/**
 * What the run was asked to do, for the reviewer: the newest thing a person
 * typed — never a note the server wrote into the run — with what that message
 * leans on. "I accept this plan" says nothing without the plan, and "yes, go
 * on" nothing without the request it answers, so the accepted plan and the
 * conversation's first request ride along. Bounded part by part.
 */
export function reviewTask(entries: readonly TaskEntry[]): string {
  const typed = entries.filter((e) => e.role === "user" && e.text.trim() !== "" && !isNudgeText(e.text));
  const latest = typed.at(-1);
  if (!latest) return "";
  const parts = [clip(latest.text.trim(), LATEST_ASK_CHARS)];
  if (latest.text.trim() === PLAN_ACCEPTED_MESSAGE) {
    const plan = entries.slice(0, entries.indexOf(latest)).reverse().find((e) => e.plan?.trim())?.plan;
    if (plan) parts.push(`The plan that message accepts:\n${clip(plan.trim(), PLAN_CHARS)}`);
  }
  const first = typed[0];
  if (first !== latest) parts.push(`What the user first asked in this conversation:\n${clip(first.text.trim(), FIRST_ASK_CHARS)}`);
  return parts.join("\n\n");
}

/**
 * How much of a text repeats, word for word, something earlier in the same
 * text: the share of its eight-word runs already seen. A reply that goes
 * round in the same paragraphs scores high; real thinking, however long,
 * scored 0 to 1% on every reply of the run this was measured on.
 */
export function repeatedShare(text: string): number {
  const words = text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
  const RUN = 8;
  if (words.length < RUN * 10) return 0;
  const seen = new Set<string>();
  let repeats = 0;
  for (let i = 0; i + RUN <= words.length; i++) {
    const run = words.slice(i, i + RUN).join(" ");
    if (seen.has(run)) repeats += 1;
    else seen.add(run);
  }
  return repeats / (words.length - RUN + 1);
}

/** The share past which the digest says so. */
const REPEATED_SHARE_SHOWN = 0.1;

/** Tool output inside the digest, marked off as someone else's words. The
 * marks themselves are taken out of the text, so it cannot close its own. */
function quoted(text: string): string {
  return `«${text.replace(/[«»]/g, "'")}»`;
}

/**
 * What the reviewer reads. Bounded whatever the run did: every part has its
 * own budget, so a run at 180K tokens still yields a digest of a few thousand.
 * Tool output is quoted, never bare: it is the one part of this that a web
 * page or a file can have written (see REVIEW_OUTPUT_CONTRACT).
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
  /** What earlier reviews of this run said, oldest first. A reviewer shown
   * only the latest steps calls a run that has been "checking one last thing"
   * for hours progressing every single time; its own earlier words are what
   * let it see that. */
  earlier: readonly PastReview[];
  /** The reply being written right now, for a review taken mid-reply: how
   * long it has been going, and everything it has thought and said so far. */
  inFlight?: { ms: number; text: string; thinking: string } | null;
}): string {
  const out: string[] = [];
  out.push(
    input.subagent
      ? "## Task (handed to this agent by another agent, which is waiting for its report)"
      : "## Task (the user's latest message)",
  );
  out.push(clip(input.task.trim(), TASK_CHARS) || "(empty)");
  out.push("");
  out.push("## So far");
  out.push(`- ${String(input.stepsDone)} steps, ${minutes(input.workedMs)} of working time`);
  if (input.contextTokens != null) out.push(`- context: about ${String(input.contextTokens)} tokens`);
  out.push("");
  const earlier = input.earlier.slice(-DIGEST_PAST_REVIEWS);
  if (earlier.length > 0) {
    out.push("## Earlier checks on this run, oldest first");
    for (const past of earlier) {
      out.push(
        `- after step ${String(past.step)} (${minutes(past.workedMs)} in): ${past.verdict ?? "no verdict"}` +
          (past.reason ? ` — ${clip(past.reason, PAST_REASON_CHARS)}` : ""),
      );
    }
    out.push("");
  }
  const recent = input.steps.slice(-DIGEST_STEPS);
  const first = input.stepsDone - recent.length + 1;
  out.push(`## Its last ${String(recent.length)} steps, oldest first (tool output is quoted in «»)`);
  recent.forEach((step, i) => {
    const tokens = step.completionTokens != null ? `, wrote ${String(step.completionTokens)} tokens` : "";
    out.push(`### Step ${String(first + i)} (${minutes(step.ms)}, ${String(step.thinkingChars)} characters of thinking${tokens})`);
    if (step.calls.length === 0) out.push("(no tool calls)");
    for (const call of step.calls) {
      out.push(`- ${call.tool} ${clip(call.args, ARGS_CHARS)}`);
      out.push(`  ${call.ok ? "ok" : "failed"}: ${quoted(clip(call.result.replace(/\s+/g, " ").trim(), RESULT_CHARS))}`);
    }
  });
  const live = input.inFlight;
  const said = live?.text.trim() ? live.text : input.lastText;
  if (said.trim()) {
    out.push("");
    out.push("## Its latest words to the user");
    out.push(clip(said.trim(), TEXT_CHARS));
  }
  if (live) {
    // A reply can go round in its own thinking for an hour without calling a
    // tool, and without a sentence of it repeated. Its end alone looks like
    // work; its start, middle and end side by side show whether it has moved.
    const t = live.thinking.trim();
    out.push("");
    out.push(
      `## The reply it is writing now: step ${String(input.stepsDone + 1)}, ${minutes(live.ms)} so far, ` +
        `${String(t.length)} characters of thinking, no tool call yet`,
    );
    // Three excerpts can each land on different words of a reply that is
    // going round between two paragraphs; this cannot.
    const repeated = repeatedShare(t);
    if (repeated >= REPEATED_SHARE_SHOWN) {
      out.push(`${String(Math.round(repeated * 100))}% of this reply repeats, word for word, something it wrote earlier in the same reply.`);
    }
    if (t.length <= REPLY_START_CHARS + REPLY_MIDDLE_CHARS + REPLY_END_CHARS) {
      out.push(t || "(nothing yet)");
    } else {
      const mid = Math.floor((t.length - REPLY_MIDDLE_CHARS) / 2);
      out.push("### How its thinking began");
      out.push(`${t.slice(0, REPLY_START_CHARS)} […]`);
      out.push("### Its thinking half way through");
      out.push(`[…] ${t.slice(mid, mid + REPLY_MIDDLE_CHARS)} […]`);
      out.push("### Its thinking now");
      out.push(`[…] ${t.slice(t.length - REPLY_END_CHARS)}`);
    }
  } else if (input.thinkingTail.trim()) {
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

/** Reasoning a backend left inline, taken out: closed `<think>` blocks, then
 * whatever comes before a stray closing tag or after a stray opening one. */
function withoutThinking(text: string): string {
  let out = text.replace(/<think>[\s\S]*?<\/think>/gi, " ");
  const close = out.toLowerCase().lastIndexOf("</think>");
  if (close >= 0) out = out.slice(close + "</think>".length);
  const open = out.toLowerCase().indexOf("<think>");
  if (open >= 0) out = out.slice(0, open);
  return out;
}

/**
 * The reviewer's reply, read: the JSON object bare, fenced, among other
 * words, or cut short. Where the reply holds several, the last one is the
 * answer — a model that restates the format or reasons aloud first puts its
 * verdict at the end. Anything else is no verdict.
 */
export function parseVerdict(text: string): { verdict: ReviewVerdict; reason: string } | null {
  const body = withoutThinking(text);
  const candidates: string[] = [];
  // Most specific first: an object that names a verdict and nests nothing.
  candidates.push(...[...body.matchAll(/\{[^{}]*"verdict"[^{}]*\}/g)].map((m) => m[0]).reverse());
  candidates.push(...[...body.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map((m) => m[1]).reverse());
  const first = body.indexOf("{");
  const last = body.lastIndexOf("}");
  if (first >= 0 && last > first) candidates.push(body.slice(first, last + 1));
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
  // A reply cut off before its closing brace or quote: a real model not held
  // to a schema ended one review in twenty that way (Qwen3.8 Flash-Next),
  // having said everything that matters. The fields are read where they stand.
  const verdict = [...body.matchAll(/"verdict"\s*:\s*"(progressing|stuck|finished)"/gi)].at(-1)?.[1].toLowerCase();
  if (!verdict) return null;
  const said = [...body.matchAll(/"reason"\s*:\s*"((?:[^"\\]|\\.)*)/g)].at(-1)?.[1] ?? "";
  let reason = said;
  try {
    reason = JSON.parse(`"${said.replace(/\\$/, "")}"`) as string;
  } catch {
    // Escapes that do not parse stay as they were written.
  }
  return { verdict: verdict as ReviewVerdict, reason: reason.trim().replace(/\s+/g, " ").slice(0, 500) };
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

/** The verdict as a schema, for a backend that will hold the reply to one. */
export const VERDICT_SCHEMA = {
  name: "progress_verdict",
  schema: {
    type: "object",
    properties: { verdict: { type: "string", enum: ["progressing", "stuck", "finished"] }, reason: { type: "string" } },
    required: ["verdict", "reason"],
    additionalProperties: false,
  },
};

/** The reviewer's token budget. Room for a model that cannot be told not to
 * think to do so and still answer; a model that can answers in a few dozen. */
const REVIEW_MAX_TOKENS = 4_000;

/**
 * Sends one review and reads its verdict. `read` is null for no verdict: the
 * deadline passed, the request failed, or the reply could not be read.
 * `result` is the finished request, for its usage record. Never throws.
 */
export async function reviewRun(input: {
  model: string;
  messages: ChatMessage[];
  thinking: Record<string, unknown>;
  signal: AbortSignal;
}): Promise<{ read: { verdict: ReviewVerdict; reason: string } | null; result: CompletionResult | null }> {
  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(reviewDeadlineMs())]);
  let text = "";
  let reasoning = "";
  let result: CompletionResult | null = null;
  // Asked for under a schema first. Told only in words to reply in JSON, a
  // real model (Qwen3.8 Flash-Next, 137 reviews of real runs) left off the
  // closing brace 7 times and answered in prose 4; held to the schema it gave
  // a whole verdict 64 times in 64. A backend that refuses the field is asked
  // once more without it.
  for (const constrained of [true, false]) {
    text = "";
    reasoning = "";
    try {
      // No `conversationId`: this is not the conversation's next turn, and
      // must neither restore its saved cache nor be mistaken for it.
      for await (const event of streamCompletion(input.model, input.messages, {
        signal,
        thinking: input.thinking,
        maxTokens: REVIEW_MAX_TOKENS,
        ...(constrained ? { jsonSchema: VERDICT_SCHEMA } : {}),
      })) {
        if (event.type === "delta") text += event.content;
        else if (event.type === "thinking") reasoning += event.content;
        else if (event.type === "done") {
          result = event.result;
          text = event.result.content || text;
        }
      }
      break;
    } catch (err) {
      if (signal.aborted) return { read: null, result };
      if (constrained) continue;
      console.warn(`progress review failed: ${(err as Error).message}`);
      return { read: null, result };
    }
  }
  // A model that put its whole answer in its reasoning still answered.
  return { read: parseVerdict(text) ?? parseVerdict(reasoning), result };
}

/** What the engine is handed to act on. */
export interface ReviewDecision {
  verdict: ReviewVerdict | null;
  reason: string;
  action: ReviewAction;
  /** The working-time ceiling, not a verdict: no switch withdraws it. */
  forced?: boolean;
}

/** What a request being written looks like to a review taken mid-reply. */
export interface LiveRequest {
  text: string;
  thinking: string;
  startedAt: number;
}

/** How soon a look that could do nothing is tried again. */
const RECHECK_MS = 30_000;
/** How often a streaming reply's size is looked at. */
const REPLY_POLL_MS = 10_000;

/**
 * Sequences reviews for one run. The engine calls `recordStep` and then
 * `atStepEnd` after every step, and acts on what `atStepEnd` returns. Around
 * each model request it calls `watchRequest`, so that the time cadence and
 * the ceiling are not left waiting for a reply that takes an hour; a decision
 * reached while a reply is being written calls `interrupt`, which the engine
 * wires to the current request.
 */
export class ProgressReviewer {
  private readonly steps: DigestStep[] = [];
  private stepsDone = 0;
  private stepsAtLast = 0;
  private workedAtLast = 0;
  private streak: ReviewStreak = { stuck: false, missed: false };
  private readonly earlier: PastReview[] = [];
  private inFlight: Promise<void> | null = null;
  private ready: ReviewDecision | null = null;
  private readonly cancel = new AbortController();
  private disposed = false;
  private limitSaid = false;
  private retryAt = 0;
  private lastText = "";
  private thinkingTail = "";
  private contextTokens: number | null = null;
  private readonly on: boolean;
  /** Set by the engine while a model request streams: ends that request so a
   * decision lands now rather than after a long generation. */
  interrupt: (() => void) | null = null;

  constructor(
    private readonly opts: {
      prefs: ReviewPrefs;
      /** Its parent waits on it: any verdict but `progressing` ends it. */
      subagent: boolean;
      /** Nobody is watching: a sub-agent or a routine. Always reviewed, and
       * held to `limitMs`. */
      unattended: boolean;
      /** The working-time ceiling of an unattended run; null for none. */
      limitMs: number | null;
      task: string;
      model: string;
      providerId: string;
      thinking: Record<string, unknown>;
      runSignal: AbortSignal;
      /** The run's working time so far: wall clock less every wait. */
      workedMs: () => number;
      /** The per-conversation switch, read live. */
      switchedOff: () => boolean;
      /** A finished review request, for its usage record. */
      onUsage?: (result: CompletionResult) => void;
      /** How often a streaming reply's size is looked at; `REPLY_POLL_MS`
       * unless a test wants it sooner. */
      replyPollMs?: number;
      emit: (event: { kind: "run.review.start"; mode: ReviewMode } | ({ kind: "run.review.end" } & Omit<ReviewDecision, "reason" | "forced"> & { reason?: string })) => void;
    },
  ) {
    this.on = reviewsOn(opts.prefs, opts.unattended);
  }

  /** A finished step, for the digest. Clipped here, to what the digest will
   * show: a run's tool output can be megabytes, and ten steps of it are kept. */
  recordStep(step: DigestStep, latest: { text: string; thinking: string; contextTokens: number | null }): void {
    this.stepsDone += 1;
    this.steps.push({
      ...step,
      calls: step.calls.map((c) => ({ ...c, args: clip(c.args, ARGS_CHARS), result: clip(c.result.replace(/\s+/g, " ").trim(), RESULT_CHARS) })),
    });
    if (this.steps.length > DIGEST_STEPS) this.steps.shift();
    if (latest.text.trim()) this.lastText = latest.text.slice(-2 * TEXT_CHARS);
    if (latest.thinking.trim()) this.thinkingTail = latest.thinking.slice(-2 * THINKING_CHARS);
    if (latest.contextTokens != null) this.contextTokens = latest.contextTokens;
  }

  /** The waiting decision, if it still stands: one that calls for something,
   * and that the conversation's switch has not been turned off under since. */
  private standing(): ReviewDecision | null {
    const ready = this.ready;
    if (!ready || ready.action === "none") return null;
    if (!ready.forced && this.opts.switchedOff()) {
      this.ready = null;
      return null;
    }
    return ready;
  }

  /** Whether a decision reached beside the run is waiting to be acted on. */
  hasDecision(): boolean {
    return this.standing() !== null;
  }

  /** That decision. Taken once. */
  takeReady(): ReviewDecision | null {
    const ready = this.standing();
    this.ready = null;
    return ready;
  }

  /** The ceiling, once: a decision when an unattended run has used up its
   * working time. */
  private overLimit(workedMs: number): ReviewDecision | null {
    const { limitMs } = this.opts;
    if (limitMs === null || this.limitSaid || workedMs < limitMs) return null;
    this.limitSaid = true;
    return {
      verdict: null,
      reason: `This ${this.opts.subagent ? "sub-agent" : "routine"} has been working for ${minutes(limitMs)}, the most a run nobody is watching gets.`,
      action: "answer",
      forced: true,
    };
  }

  private messagesFor(workedMs: number, live: LiveRequest | null): ChatMessage[] {
    return reviewMessages(
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
        earlier: this.earlier,
        inFlight: live ? { ms: Date.now() - live.startedAt, text: live.text, thinking: live.thinking } : null,
      }),
    );
  }

  /** A review on a slot the backend had spare: the run carries on, and the
   * decision interrupts whatever it is writing by then. */
  private startBeside(spare: { release(): void }, messages: ChatMessage[]): void {
    this.opts.emit({ kind: "run.review.start", mode: "alongside" });
    this.inFlight = this.review(messages)
      .then((decision) => {
        if (this.isDisposed()) return;
        this.ready = decision;
        if (this.hasDecision()) this.interrupt?.();
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
  }

  /**
   * After a step: a waiting decision if there is one; otherwise, if a review
   * is due, one starts — beside the run (returns null at once) or, without a
   * spare slot, in the run's own slot (returns its decision).
   */
  async atStepEnd(): Promise<ReviewDecision | null> {
    const waiting = this.takeReady();
    if (waiting) return waiting;
    if (this.disposed) return null;
    const workedMs = this.opts.workedMs();
    const over = this.overLimit(workedMs);
    if (over) return over;
    if (this.inFlight || !this.on || this.opts.switchedOff()) return null;
    const trigger = reviewTrigger({
      stepsSinceReview: this.stepsDone - this.stepsAtLast,
      workedMsSinceReview: workedMs - this.workedAtLast,
      everyMs: this.opts.prefs.everyMs,
      everySteps: this.opts.prefs.everySteps,
    });
    if (!trigger) return null;
    const messages = this.messagesFor(workedMs, null);
    const spare = await tryAcquireRunSlot(this.opts.providerId);
    // Through calls: the checks above narrowed the fields, and the await is
    // exactly when the run can end or a look mid-reply can start a review.
    if (this.isDisposed() || this.reviewing()) {
      spare?.release();
      return null;
    }
    if (spare) {
      this.startBeside(spare, messages);
      return null;
    }
    if (!worthPausingFor(trigger, this.contextTokens)) return null;
    this.opts.emit({ kind: "run.review.start", mode: "paused" });
    const decision = await this.review(messages);
    return decision.action === "none" ? null : decision;
  }

  /**
   * Watches one model request, from its send until the returned function is
   * called. A reply can take longer than the whole review cadence — the run
   * this exists for wrote for twenty-eight minutes a step — and one that never
   * ends would never reach a step boundary at all. So a reply is looked at
   * while it streams: when the time cadence comes due, and each time it has
   * written another `REPLY_REVIEW_CHARS` without acting. A review then starts
   * beside the run when a slot is spare (there is no pausing a request
   * half-written), reading the reply so far; and the ceiling of an unattended
   * run cuts the reply short.
   */
  watchRequest(live: () => LiveRequest): () => void {
    // Nothing a look could do: no timer at all.
    if (!this.on && this.opts.limitMs === null) return () => undefined;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let watching = true;
    // What this reply had written when a review last started on it.
    const seen = { chars: 0 };
    const arm = (): void => {
      if (!watching || this.isDisposed()) return;
      timer = setTimeout(() => {
        timer = null;
        void this.lookDuring(live, seen)
          .catch((err: unknown) => {
            console.warn(`progress review look failed: ${(err as Error).message}`);
          })
          .then(arm);
      }, this.nextLookMs());
      // Never the reason a process stays up.
      timer.unref();
    };
    arm();
    return () => {
      watching = false;
      if (timer) clearTimeout(timer);
    };
  }

  /** How long until there could be something to do mid-reply. */
  private nextLookMs(): number {
    const worked = this.opts.workedMs();
    const waits: number[] = [];
    if (this.opts.limitMs !== null && !this.limitSaid) waits.push(this.opts.limitMs - worked);
    if (this.on) waits.push(this.opts.prefs.everyMs - (worked - this.workedAtLast));
    const soonest = waits.length > 0 ? Math.min(...waits) : RECHECK_MS;
    // Never longer than a size poll while reviews are on: how much a reply
    // has written is only known by looking.
    const longest = this.on ? (this.opts.replyPollMs ?? REPLY_POLL_MS) : 60 * 60_000;
    return Math.min(Math.max(soonest, this.retryAt - Date.now(), 250), longest);
  }

  private async lookDuring(live: () => LiveRequest, seen: { chars: number }): Promise<void> {
    if (this.disposed) return;
    const workedMs = this.opts.workedMs();
    const over = this.overLimit(workedMs);
    if (over) {
      this.ready = over;
      this.interrupt?.();
      return;
    }
    if (!this.on) return;
    const now = live();
    const written = now.thinking.length + now.text.length;
    const due = workedMs - this.workedAtLast >= this.opts.prefs.everyMs || replyReviewDue(written, seen.chars);
    if (!due) return;
    // Due. Where nothing can be done about it just now, look again in a while.
    if (this.inFlight || this.opts.switchedOff()) {
      this.retryAt = Date.now() + RECHECK_MS;
      return;
    }
    const messages = this.messagesFor(workedMs, now);
    const spare = await tryAcquireRunSlot(this.opts.providerId);
    if (!spare) {
      this.retryAt = Date.now() + RECHECK_MS;
      return;
    }
    if (this.isDisposed() || this.reviewing()) {
      spare.release();
      return;
    }
    seen.chars = written;
    this.startBeside(spare, messages);
  }

  private async review(messages: ChatMessage[]): Promise<ReviewDecision> {
    const signal = AbortSignal.any([this.opts.runSignal, this.cancel.signal]);
    const { read, result } = await reviewRun({ model: this.opts.model, messages, thinking: this.opts.thinking, signal });
    // Real tokens whatever became of the run meanwhile.
    if (result) this.opts.onUsage?.(result);
    const verdict = read?.verdict ?? null;
    const reason = read?.reason ?? "";
    // A stop or the run ending says nothing about the run's progress: no
    // verdict is recorded and no event follows the stream's end.
    if (this.isDisposed() || (signal.aborted && !read)) return { verdict: null, reason: "", action: "none" };
    const outcome = reviewOutcome({ subagent: this.opts.subagent, verdict, streak: this.streak });
    // Switched off while the review ran: its verdict is still said, but it
    // neither steers nor ends a run its owner just asked to be left alone, and
    // it does not count towards the next one either — a `stuck` nobody acted
    // on must not turn the first steer after the switch comes back into an
    // answer.
    const withdrawn = this.opts.switchedOff();
    const action = withdrawn ? "none" : outcome.action;
    if (!withdrawn) this.streak = outcome.streak;
    this.stepsAtLast = this.stepsDone;
    this.workedAtLast = this.opts.workedMs();
    // The cadence starts again from here, so the next look is its to time.
    this.retryAt = 0;
    this.earlier.push({ step: this.stepsDone, workedMs: this.workedAtLast, verdict, ...(reason ? { reason } : {}) });
    if (this.earlier.length > DIGEST_PAST_REVIEWS) this.earlier.shift();
    this.opts.emit({ kind: "run.review.end", verdict, ...(reason ? { reason } : {}), action });
    return { verdict, reason, action };
  }

  private isDisposed(): boolean {
    return this.disposed;
  }

  private reviewing(): boolean {
    return this.inFlight !== null;
  }

  /** The run is ending: a review beside it is abandoned, and says nothing. */
  dispose(): void {
    this.disposed = true;
    this.cancel.abort();
    this.interrupt = null;
  }
}
