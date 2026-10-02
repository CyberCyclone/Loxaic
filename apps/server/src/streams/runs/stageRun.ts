import { v4 as uuid } from "uuid";
import { count, db, eq } from "@loxaic/db";
import { conversations, messages } from "@loxaic/db/schema";
import type { ContextStageReason, ContextStageStatus, PromptProgress } from "@loxaic/types";
import { summaryMessage } from "../../inference/context.ts";
import { streamCompletion, type ChatMessage } from "../../inference/provider.ts";
import { getLocalModelRow } from "../../llama/catalog.ts";
import { applyStageChange, type StageOutcome } from "../../llama/context-stage-switch.ts";
import { StageRequestError, checkStageRequest } from "../../llama/context-stage-policy.ts";
import { activeStageIndex, rowStages } from "../../llama/context-stages.ts";
import { isAdmin } from "../authz.ts";
import type { StreamProducer } from "../broker.ts";
import { getStreamBroker } from "../index.ts";
import { getRunByConversation, registerRun, unregisterRun } from "../registry.ts";
import { announceNewRun } from "../watchers.ts";
import { userAllowsAutoCompact } from "./auto-compact.ts";
import { lastRequestShape } from "./request-shape.ts";

/**
 * Context-stage switches as they appear in a conversation (see
 * llama/context-stage-switch.ts for the switch itself).
 *
 * A switch someone asks for from a conversation, or that the model's
 * `whenFull: "extend"` makes when one fills up, is a **stage run**: a run of
 * its own, like a compaction, so it holds the conversation's run lock (nothing
 * can be sent mid-switch), shows as a live card on every device watching, and
 * Stop withdraws it before it applies. A new conversation's step back down is
 * not a run of its own — it happens inside that conversation's first run,
 * before its first request, reported on the same stream.
 *
 * Nothing here writes a message row: the card is client-only, folded from the
 * stream log like a check-in decision, because a row would enter the prompt
 * and move the history anchor.
 */

function emitter(producer: StreamProducer) {
  return (status: ContextStageStatus) => { producer.emit({ kind: "context.stage", ...status }); };
}

/**
 * Re-read `convId`'s prompt after a reload so its next turn finds it cached:
 * the same front its last run sent (request-shape.ts) and the same replayed
 * history, capped at one token of reply that is thrown away. Only when the
 * shape is this model's — any other front would warm nothing the next turn
 * uses.
 */
export function warmer(convId: string, model: string) {
  return async (signal: AbortSignal, onProgress: (p: PromptProgress) => void): Promise<void> => {
    const shape = lastRequestShape(convId);
    if (shape?.model !== model) return;
    // Dynamic, as compaction does: the engine imports this module.
    const { loadHistory } = await import("./engine.ts");
    const history = await loadHistory(convId);
    const messages: ChatMessage[] = [
      ...(shape.system ? [{ role: "system", content: shape.system } as ChatMessage] : []),
      ...(history.summaryText ? [summaryMessage(history.summaryText)] : []),
      ...history.messages,
    ];
    const started = Date.now();
    let reports = 0;
    let last: PromptProgress | null = null;
    for await (const event of streamCompletion(model, messages, {
      tools: shape.tools,
      signal,
      maxTokens: 1,
      thinking: shape.thinking,
      // Always asked for. A stage only exists on the built-in llama.cpp
      // router, which reports progress; reading that off the model list asked
      // a list this very reload had just invalidated, which still said "not
      // loaded, not a native runtime" — and the re-read showed no progress.
      reportProgress: true,
    })) {
      if (event.type === "progress") {
        reports++;
        last = event.progress;
        onProgress(event.progress);
      }
    }
    // One line per re-read, so a pill that sat at one figure can be told apart
    // from a backend that stopped reporting.
    console.log(
      `[llama] ${model}: re-read ${String(messages.length)} messages in ${String(Math.round((Date.now() - started) / 1000))} s, ` +
        `${String(reports)} progress report(s)${last ? `, last ${String(last.processed_tokens)}/${String(last.total_tokens)} tokens` : ""}`,
    );
  };
}

export interface StartStageRunResult {
  streamId: string;
  conversationId: string;
}

/**
 * A stage switch as a run in `conversationId`. Resolves once the run has
 * started; `onDone` hears how it ended. Permission and refusals are the
 * caller's (`checkStageRequest`) — by here the target is one that may be asked for.
 */
export async function startStageRun(input: {
  userId: string;
  conversationId: string;
  model: string;
  target: number;
  reason: ContextStageReason;
  auto: boolean;
  surface: "chat" | "agent";
  onDone?: (outcome: StageOutcome) => void;
  /** End the card as failed with this sentence instead of switching — a
   * compact-first whose summary still does not fit the smaller stage. */
  refuse?: string;
}): Promise<StartStageRunResult> {
  const { userId, conversationId: convId, model } = input;
  if (getRunByConversation(convId)) throw new Error("A response is already in progress for this conversation");
  const broker = getStreamBroker();
  const streamId = uuid();
  const abort = new AbortController();
  // Claim the conversation before the await below, not after it. The check
  // above and the claim have to be one synchronous step: with `openProducer`
  // between them, a send, a stage run and an automatic extension that all
  // arrive together each pass the check, and `registerRun` overwrites the
  // conversation's entry silently — Stop then reaches only one of them.
  registerRun({ streamId, conversationId: convId, userId, abort, approvals: new Map(), model });
  let producer: StreamProducer;
  try {
    producer = await broker.openProducer({ streamId, conversationId: convId, userId, surface: input.surface });
  } catch (err) {
    unregisterRun(streamId);
    throw err;
  }
  announceNewRun(convId, streamId);

  void (async () => {
    let outcome: StageOutcome = { kind: "cancelled" };
    try {
      if (input.refuse !== undefined) {
        const row = await getLocalModelRow(model);
        const from = row ? activeStageIndex(row) : 0;
        emitter(producer)({
          step: "failed",
          reason: input.reason,
          auto: input.auto,
          model,
          from_stage: from,
          to_stage: input.target,
          from_tokens: null,
          to_tokens: null,
          yarn_factor: null,
          message: input.refuse,
        });
        outcome = { kind: "failed", message: input.refuse };
        return;
      }
      outcome = await applyStageChange({
        modelId: model,
        target: input.target,
        reason: input.reason,
        auto: input.auto,
        byUserId: input.auto ? null : userId,
        conversationId: convId,
        signal: abort.signal,
        emit: emitter(producer),
        warm: warmer(convId, model),
      });
    } catch (err) {
      // applyStageChange answers its own failures, so this is what is left: a
      // database read or an emit that threw. Without a catch the finally below
      // ended the stream `cancelled` — the card reading "stopped" for a switch
      // that broke — and the rejection escaped unhandled.
      const message = `The context switch stopped unexpectedly: ${err instanceof Error ? err.message : String(err)}`;
      console.warn(`stage run ${streamId} failed: ${message}`);
      outcome = { kind: "failed", message };
      try {
        emitter(producer)({
          step: "failed",
          reason: input.reason,
          auto: input.auto,
          model,
          from_stage: 0,
          to_stage: input.target,
          from_tokens: null,
          to_tokens: null,
          yarn_factor: null,
          message,
        });
      } catch {
        // The stream's own end carries the error below.
      }
    } finally {
      unregisterRun(streamId);
      const status = outcome.kind === "cancelled" ? "cancelled" : outcome.kind === "failed" ? "error" : "complete";
      await producer.end(status, outcome.kind === "failed" ? { error: outcome.message } : undefined).catch(() => undefined);
      input.onDone?.(outcome);
    }
  })();

  return { streamId, conversationId: convId };
}

/**
 * The model's `whenFull: "extend"`: called where automatic compaction would
 * be, once a turn has crossed the threshold. True when a stage run started;
 * false means "compact as usual" — the model is set to compact, is at its
 * largest stage, or the next stage will not fit. A stage run that then fails
 * compacts instead, so the conversation is never left full with nothing done.
 */
export async function autoExtend(input: {
  userId: string;
  conversationId: string;
  model: string;
  surface: "chat" | "agent";
  /** Whether automatic compaction would have fired for this turn, the
   * `AUTO_COMPACT_MIN_MESSAGES` floor included. Extending ignores the floor
   * (one big paste can fill a short thread), but the compaction a failed
   * extension falls back to must not: a three-message thread whose summary
   * is still over the threshold would otherwise extend, fail and compact on
   * every turn, paying a model call and a full re-read each time. */
  canCompact: boolean;
}): Promise<boolean> {
  const row = await getLocalModelRow(input.model);
  if (!row) return false;
  const config = rowStages(row);
  if (config?.whenFull !== "extend") return false;
  const next = activeStageIndex(row) + 1;
  if (next > config.stages.length) return false;
  try {
    await checkStageRequest({ row, target: next, isAdmin: true, conversationId: input.conversationId, auto: true });
  } catch (err) {
    if (err instanceof StageRequestError) return false;
    throw err;
  }
  await startStageRun({
    userId: input.userId,
    conversationId: input.conversationId,
    model: input.model,
    surface: input.surface,
    target: next,
    reason: "full",
    auto: true,
    onDone: (outcome) => {
      if (outcome.kind !== "failed" || !input.canCompact) return;
      void (async () => {
        if (!(await userAllowsAutoCompact(input.userId))) return;
        const { startCompactRun } = await import("./compactRun.ts");
        await startCompactRun({ userId: input.userId, conversationId: input.conversationId, model: input.model, surface: input.surface, auto: true });
      })().catch((e: unknown) => { console.warn(`compaction after a failed extension skipped: ${(e as Error).message}`); });
    },
  });
  return true;
}

/** `conversation|model|stage` → when a crossing there was left to the person.
 * In memory: after a restart one more turn is left to them, which is the cheap
 * direction. Bounded, oldest first. */
const leftToPerson = new Map<string, number>();
const LEFT_TO_PERSON_MAX = 5_000;

/**
 * The model's `whenFull: "compact"` with a larger stage the person could move
 * to: is the first turn that crosses the compaction threshold theirs to decide?
 *
 * The "nearly full" prompt (Compact or Extend) is offered from 75% of the
 * window, and automatic compaction runs after any turn that ends past 85%. A
 * single turn that jumps across both — a big paste, a long tool result, a real
 * model's first large prompt — used to compact before the prompt could ever be
 * shown, so the choice the stages exist for was never offered. So the first
 * crossing at a stage is left to the person: nothing compacts, and the client
 * shows the prompt. If they do not choose (Not now, or just send again), the
 * next turn past the threshold compacts as before — a conversation is never
 * left over its window for long because someone looked away.
 *
 * Only when asking means something: an interactive conversation (a routine has
 * nobody to ask), and only if this person could extend right now —
 * `checkStageRequest` for the next stage says whether they may change it, the
 * next stage fits, and no cooldown or someone else's switch is in the way.
 */
export async function leaveCompactionToPerson(input: { userId: string; conversationId: string; model: string }): Promise<boolean> {
  const row = await getLocalModelRow(input.model);
  const config = row ? rowStages(row) : null;
  if (!row || config?.whenFull !== "compact") return false;
  const active = activeStageIndex(row);
  if (active >= config.stages.length) return false; // nothing larger to offer
  const convs = await db
    .select({ kind: conversations.kind })
    .from(conversations)
    .where(eq(conversations.id, input.conversationId));
  // A routine's conversation has nobody to ask; a missing one, nothing to ask about.
  if (convs.length === 0 || convs[0].kind === "routine") return false;
  try {
    await checkStageRequest({
      row,
      target: active + 1,
      isAdmin: await isAdmin(input.userId),
      conversationId: input.conversationId,
      userId: input.userId,
    });
  } catch (err) {
    if (err instanceof StageRequestError) return false;
    throw err;
  }
  const key = `${input.conversationId}|${row.id}|${String(active)}`;
  if (leftToPerson.has(key)) return false; // asked once at this stage: compact now
  leftToPerson.set(key, Date.now());
  if (leftToPerson.size > LEFT_TO_PERSON_MAX) {
    const oldest = leftToPerson.keys().next();
    if (!oldest.done) leftToPerson.delete(oldest.value);
  }
  return true;
}

/** Test seam. */
export function __resetLeftToPersonForTest(): void {
  leftToPerson.clear();
}

/**
 * A new conversation's first run, before its first request: move the model to
 * the stage the conversation was started with (Context settings), or back down
 * to standard when it names none. Reported on the run's own stream; never
 * fails the run — a refusal is said in the card and the run goes on at the
 * stage the model is on.
 */
export async function stageForNewConversation(input: {
  userId: string;
  conversationId: string;
  model: string;
  chosen?: number;
  producer: StreamProducer;
  signal: AbortSignal;
}): Promise<void> {
  const row = await getLocalModelRow(input.model);
  const config = row ? rowStages(row) : null;
  if (!row || !config) return;
  const active = activeStageIndex(row);
  const wanted = input.chosen ?? 0;
  if (wanted === active) return;
  const emit = emitter(input.producer);
  const auto = input.chosen === undefined;
  const reason: ContextStageReason = auto ? "new-conversation" : "chosen";
  let target: number;
  let limitedBy: number | null;
  try {
    ({ target, limitedBy } = await checkStageRequest({
      row,
      target: wanted,
      isAdmin: await isAdmin(input.userId),
      conversationId: input.conversationId,
      auto,
      userId: input.userId,
    }));
  } catch (err) {
    if (!(err instanceof StageRequestError)) throw err;
    // Chosen and refused: say so on the card, and carry on at the stage it is.
    emit({
      step: "failed",
      reason,
      auto,
      model: row.id,
      from_stage: active,
      to_stage: wanted,
      from_tokens: null,
      to_tokens: null,
      yarn_factor: null,
      message: err.message,
    });
    return;
  }
  if (target === active) return;
  await applyStageChange({
    modelId: row.id,
    target,
    reason,
    auto,
    byUserId: auto ? null : input.userId,
    conversationId: input.conversationId,
    signal: input.signal,
    emit: (status) => {
      emit(
        status.step === "applied" && limitedBy !== null
          ? { ...status, message: "Another conversation using this model still needs this much context, so it stopped here." }
          : status,
      );
    },
  });
}

/** Whether `convId` has no messages yet — the send about to write one opens
 * it. True for a conversation created by this send, one the agent created up
 * front to choose a workspace, and a routine's fresh run alike. */
export async function hasNoMessages(convId: string): Promise<boolean> {
  const [row] = await db.select({ n: count() }).from(messages).where(eq(messages.conversationId, convId));
  return row.n === 0;
}

/** A `context_stage` off the socket: a claim like any other field. Range is
 * checked against the model later; here only the shape. */
export function normalizeContextStage(raw: unknown): number | undefined {
  return typeof raw === "number" && Number.isInteger(raw) && raw >= 0 && raw < 16 ? raw : undefined;
}
