import type { ContextStageReason, ContextStageStatus, PromptProgress } from "@loxaic/types";
import { acquireExclusiveSlot } from "../inference/scheduler.ts";
import { runsUsingModel } from "../streams/registry.ts";
import { getLocalModelRow, updateLocalModelRow, type LocalModelMeta, type LocalModelRow } from "./catalog.ts";
import { activeStageIndex, rowStages, settingsForStage, stageContexts, yarnFactorOf } from "./context-stages.ts";
import { perRequestWindow } from "./load-settings.ts";
import { loadWithRoom } from "./room.ts";
import { routerEndpoint, syncPreset } from "./router.ts";

/**
 * Moving a model from one context stage to another — model-wide, because a
 * llama.cpp load is shared by everyone using the model.
 *
 * The switch takes the built-in backend **exclusively**
 * (`acquireExclusiveSlot`): it waits for every run ahead of it in line to
 * finish, and once it reaches the front nothing behind it starts. So a reload
 * never lands under a reply, and a steady stream of new runs cannot starve it —
 * they queue behind the switch and run at the new stage. Every local model
 * shares the built-in queue (one run at a time unless the router has spare
 * slots), so "waits for the reply running now" includes a reply on another
 * local model; that is the queue every run already waits in.
 *
 * Then, still holding the backend: write `active_stage`, rewrite the preset
 * (the router unloads the changed section), load the model at the new stage
 * explicitly — making room like any load — and, when the caller can supply one,
 * re-read the caller's conversation so its cache is warm for the next turn.
 * Each step is reported through `emit`, which a stage run turns into
 * `context.stage` events for the pill.
 */

type Emit = (status: ContextStageStatus) => void;

interface Pending {
  target: number;
  abort: AbortController;
  byUserId: string | null;
  /** The conversation it was started from, which decides who else may cancel it. */
  conversationId?: string;
  since: number;
}

/** model id -> the switch waiting or in progress for it. One per model: a
 * newer request replaces an older one still waiting. */
const pending = new Map<string, Pending>();

/** The stage a switch is heading to, while one is waiting or running. */
export function pendingStage(modelId: string): number | null {
  return pending.get(modelId)?.target ?? null;
}

/** Who started the switch waiting or running for this model, for the checks
 * on who may replace or withdraw it. */
export function pendingSwitch(modelId: string): { byUserId: string | null; conversationId?: string } | null {
  const p = pending.get(modelId);
  return p ? { byUserId: p.byUserId, conversationId: p.conversationId } : null;
}

/** Withdraw a switch that has not applied yet. True when there was one. */
export function withdrawStageChange(modelId: string): boolean {
  const p = pending.get(modelId);
  if (!p) return false;
  p.abort.abort();
  return true;
}

/** model id -> the last switch that applied, so a conversation whose next
 * request finds the model reloading can be told why. */
const lastApplied = new Map<string, { at: number; toTokens: number | null; conversationId?: string }>();

/** How long a person who may change the stage must wait after the last switch
 * before asking for another (milliseconds). Every switch takes the whole
 * backend and reloads the model for everyone, so "who may ask" is not the only
 * limit a shared model needs: without this one signed-in user can alternate two
 * stages and stall every other conversation for as long as they like.
 * Admins, the model's own `whenFull` extension and a new conversation's
 * step-down are not subject to it. Read at call time. */
export function stageCooldownMs(): number {
  const v = Number(process.env.CONTEXT_STAGE_COOLDOWN_MS);
  return process.env.CONTEXT_STAGE_COOLDOWN_MS !== undefined && process.env.CONTEXT_STAGE_COOLDOWN_MS !== "" && Number.isFinite(v) && v >= 0 ? v : 30_000;
}

/** Milliseconds until a person may switch this model again; 0 when they may. */
export function stageCooldownRemaining(modelId: string): number {
  const s = lastApplied.get(modelId);
  return s ? Math.max(0, s.at + stageCooldownMs() - Date.now()) : 0;
}

/** A switch made by another conversation in the last half hour, if any. */
export function recentSwitch(modelId: string, conversationId: string): { toTokens: number | null } | null {
  const s = lastApplied.get(modelId);
  if (!s || s.conversationId === conversationId || Date.now() - s.at > 30 * 60_000) return null;
  return { toTokens: s.toTokens };
}

/** `${id}|${ctx}` -> how long the last load at that context took. An ETA for
 * the reload step, never shown as a promise: absent until measured once. */
const loadTimes = new Map<string, number>();

export function stageWindows(row: LocalModelRow): (number | null)[] {
  return stageContexts(row).map((ctx, i) => (ctx === null ? null : perRequestWindow(settingsForStage(row, i), ctx)));
}

type StatusBase = Pick<ContextStageStatus, "reason" | "auto" | "model" | "from_stage" | "to_stage" | "from_tokens" | "to_tokens" | "yarn_factor">;
type StepFields = Omit<ContextStageStatus, keyof StatusBase>;

function statusBase(row: LocalModelRow, from: number, to: number, reason: ContextStageReason, auto: boolean): StatusBase {
  const contexts = stageContexts(row);
  const stage = to > 0 ? rowStages(row)?.stages[to - 1] : undefined;
  return {
    reason,
    auto,
    model: row.id,
    from_stage: from,
    to_stage: to,
    from_tokens: contexts[from] ?? null,
    to_tokens: contexts[to] ?? null,
    yarn_factor: stage ? yarnFactorOf(stage, row.meta as LocalModelMeta) : null,
  };
}

export type StageOutcome =
  | { kind: "applied"; stage: number }
  | { kind: "unchanged"; stage: number }
  | { kind: "cancelled" }
  | { kind: "failed"; message: string };

const LOAD_WAIT_MS = 15 * 60_000;

export async function applyStageChange(opts: {
  modelId: string;
  target: number;
  reason: ContextStageReason;
  auto: boolean;
  byUserId: string | null;
  /** The conversation asking, left out of "replying on this model now". */
  conversationId?: string;
  signal: AbortSignal;
  emit?: Emit;
  /** Re-read the caller's conversation after the load, reporting the
   * backend's progress. Supplied by a stage run that has the conversation's
   * request shape; failures are the caller's to swallow. */
  warm?: (signal: AbortSignal, onProgress: (p: PromptProgress) => void) => Promise<void>;
}): Promise<StageOutcome> {
  const row0 = await getLocalModelRow(opts.modelId);
  if (!row0) return { kind: "failed", message: "This model is no longer installed." };
  const stages = rowStages(row0);
  const target = Math.max(0, Math.min(opts.target, stages?.stages.length ?? 0));
  const from = activeStageIndex(row0);
  const base = statusBase(row0, from, target, opts.reason, opts.auto);
  const emit = (s: StepFields) => opts.emit?.({ ...base, ...s });
  if (target === from && !pending.has(opts.modelId)) {
    emit({ step: "applied" });
    return { kind: "unchanged", stage: from };
  }

  // A newer request replaces one still waiting; the older one ends cancelled.
  pending.get(opts.modelId)?.abort.abort();
  const abort = new AbortController();
  const mine: Pending = { target, abort, byUserId: opts.byUserId, conversationId: opts.conversationId, since: Date.now() };
  pending.set(opts.modelId, mine);
  const onOuter = () => { abort.abort(); };
  opts.signal.addEventListener("abort", onOuter, { once: true });
  if (opts.signal.aborted) abort.abort();

  let slot: { release(): void } | null = null;
  // The stage the row held before this switch wrote its own, set once it has:
  // what a cancelled switch has to put back.
  let movedFrom: number | null = null;
  try {
    slot = await acquireExclusiveSlot({
      signal: abort.signal,
      onQueued: (position) => {
        emit({ step: "waiting", position, running: runsUsingModel(opts.modelId, opts.conversationId).length });
      },
    });
    if (!slot) return { kind: "cancelled" };

    // Read again: the stages may have changed while this waited.
    const row = await getLocalModelRow(opts.modelId);
    if (!row) return { kind: "failed", message: "This model is no longer installed." };
    const before = activeStageIndex(row);
    const now = Math.max(0, Math.min(target, rowStages(row)?.stages.length ?? 0));
    if (now === before) {
      emit({ step: "applied" });
      return { kind: "unchanged", stage: now };
    }

    const ctx = stageContexts(row)[now] ?? null;
    const key = `${row.id}|${String(ctx)}`;
    emit({ step: "reloading", eta_ms: loadTimes.get(key) ?? null });
    await updateLocalModelRow(row.id, { activeStage: now });
    movedFrom = before;
    console.log(
      `[llama] ${row.id}: context stage ${String(before)} → ${String(now)} (${opts.reason}${opts.byUserId ? `, by ${opts.byUserId}` : ", automatic"})`,
    );
    await syncPreset();
    await invalidateModelList();

    if (routerEndpoint()) {
      const started = Date.now();
      let loaded = false;
      try {
        loaded = await loadWithRoom(row.id, abort.signal, LOAD_WAIT_MS);
      } catch (err) {
        if (abort.signal.aborted) throw err;
        loaded = false;
        console.warn(`[llama] ${row.id} did not load at stage ${String(now)}: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (!loaded) {
        // Put it back as it was, so the model is usable at the stage it had.
        await putBack(row.id, before);
        movedFrom = null;
        const message = `llama.cpp could not load ${row.displayName} at ${formatTokens(ctx)} — it is back at ${formatTokens(stageContexts(row)[before] ?? null)}.`;
        emit({ step: "failed", message });
        return { kind: "failed", message };
      }
      loadTimes.set(key, Date.now() - started);
    }

    if (opts.warm) {
      try {
        await opts.warm(abort.signal, (progress) => { emit({ step: "rereading", progress }); });
      } catch (err) {
        // Warming is a courtesy: the stage has changed either way, and the
        // next turn will read the conversation itself.
        if (!abort.signal.aborted) console.warn(`[llama] warm-up after the stage change failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    lastApplied.set(row.id, { at: Date.now(), toTokens: ctx, conversationId: opts.conversationId });
    movedFrom = null;
    emit({ step: "applied" });
    return { kind: "applied", stage: now };
  } catch (err) {
    if (abort.signal.aborted) {
      // `cancelled` has to mean "nothing changed", which the client acts on.
      // An abort after the stage was written (during the reload, or while
      // the preset was being rewritten) leaves the row and the preset on the
      // new stage unless it is put back — the same step a failed load takes.
      if (movedFrom !== null) {
        const back = movedFrom;
        movedFrom = null;
        await putBack(row0.id, back).catch((e: unknown) => {
          console.warn(`[llama] ${row0.id}: could not put stage ${String(back)} back after a cancelled switch: ${e instanceof Error ? e.message : String(e)}`);
        });
      }
      return { kind: "cancelled" };
    }
    const message = err instanceof Error ? err.message : String(err);
    emit({ step: "failed", message });
    return { kind: "failed", message };
  } finally {
    slot?.release();
    opts.signal.removeEventListener("abort", onOuter);
    if (pending.get(opts.modelId) === mine) pending.delete(opts.modelId);
  }
}

/** Write a stage back and re-render the preset, so the row, the router's
 * section and the listing agree again. */
async function putBack(modelId: string, stage: number): Promise<void> {
  await updateLocalModelRow(modelId, { activeStage: stage });
  await syncPreset();
  await invalidateModelList();
}

/** The model list caches each model's window; a stage change moves it.
 * Imported lazily: the model layer reaches the listing, which reaches this. */
async function invalidateModelList(): Promise<void> {
  const { invalidateBackendModels } = await import("../inference/models.ts");
  const { DEFAULT_PROVIDER_ID } = await import("@loxaic/types");
  invalidateBackendModels(DEFAULT_PROVIDER_ID);
}

// Three formatters say a window in words — this, `label` in context-stage-policy.ts and
// `formatWindow` in the client's lib/contextStages.ts. They are not shared across the
// server/client line; keep the wording of one in step with the others when it changes.
export function formatTokens(n: number | null): string {
  if (n === null) return "its standard context";
  if (n >= 1024 * 1024 && n % (1024 * 1024) === 0) return `${String(n / (1024 * 1024))}M`;
  if (n >= 1024) return `${String(Math.round(n / 1024))}K`;
  return String(n);
}

/** Test seam. */
export function __resetStageSwitchForTest(): void {
  for (const p of pending.values()) p.abort.abort();
  pending.clear();
  loadTimes.clear();
  lastApplied.clear();
}
