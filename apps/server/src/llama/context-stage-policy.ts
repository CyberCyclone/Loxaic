import { and, db, desc, eq, gt, isNotNull, ne, sql } from "@loxaic/db";
import { conversations, usageRecords } from "@loxaic/db/schema";
import { CONTEXT_STAGE_PROMPT_AT } from "@loxaic/types";
import { prefillRate } from "../inference/prefill-rate.ts";
import { runsUsingModel } from "../streams/registry.ts";
import { AUTO_COMPACT_THRESHOLD } from "../streams/runs/auto-compact.ts";
import { rowMeta, type LocalModelRow } from "./catalog.ts";
import { pendingStage, pendingSwitch, stageCooldownRemaining, stageWindows } from "./context-stage-switch.ts";
import { activeStageIndex, rowStages, settingsForStage, yarnFactorOf, type WhenFull, type WhoMayChange } from "./context-stages.ts";
import { fitFor } from "./downloads.ts";
import type { FitEstimate } from "./fit.ts";
import { refreshMemory } from "./memory.ts";
import { NoRoomError, checkStageRoom } from "./room.ts";

/**
 * Who may move a model's context stage, to where, and what the person asking
 * should be told first. Pure decisions (`smallestStageFor`, `neededByOthers`)
 * sit beside the database reads that feed them.
 *
 * "Others" means conversations other than the caller's that used this model
 * in the last `OTHERS_WINDOW_MS`. A step down is refused when one of them
 * would no longer fit: shrinking the window under a long conversation someone
 * is in the middle of would truncate it on their next turn, which is worse
 * than a short chat paying for YaRN. A conversation idle longer than that is
 * not held to: it pays one reload if its owner comes back.
 */

export const OTHERS_WINDOW_MS = 2 * 60 * 60_000;

/** What a window can hold before it counts as full — the auto-compaction
 * threshold, so "fits a stage" and "would compact at that stage" agree. */
function fitAt(): number {
  return AUTO_COMPACT_THRESHOLD > 0 ? AUTO_COMPACT_THRESHOLD : 0.85;
}

/** The smallest stage whose window holds `tokens` with room to spare, or the
 * largest when none does. Unknown windows are skipped. */
export function smallestStageFor(tokens: number, windows: (number | null)[], share: number = fitAt()): number {
  for (let i = 0; i < windows.length; i++) {
    const w = windows[i];
    if (w !== null && tokens < w * share) return i;
  }
  return Math.max(0, windows.length - 1);
}

export interface ConversationUse {
  conversationId: string;
  tokens: number;
  at: Date;
}

/** The lowest stage every other active conversation still fits in. */
export function neededByOthers(uses: ConversationUse[], windows: (number | null)[]): number {
  return uses.reduce((need, u) => Math.max(need, smallestStageFor(u.tokens, windows)), 0);
}

/** Each other conversation's newest use of `model` in the window. */
export async function recentUses(model: string, exceptConversationId?: string | null): Promise<ConversationUse[]> {
  const since = new Date(Date.now() - OTHERS_WINDOW_MS);
  const rows = await db
    .selectDistinctOn([usageRecords.conversationId], {
      conversationId: usageRecords.conversationId,
      tokens: sql<number>`(${usageRecords.inputTokens} + ${usageRecords.outputTokens})::float8`,
      at: usageRecords.createdAt,
    })
    .from(usageRecords)
    // A deleted conversation is nobody's to protect; an erased one has no row.
    .innerJoin(conversations, and(eq(conversations.id, usageRecords.conversationId), sql`${conversations.deletedAt} IS NULL`))
    .where(
      and(
        eq(usageRecords.model, model),
        gt(usageRecords.createdAt, since),
        isNotNull(usageRecords.conversationId),
        exceptConversationId ? ne(usageRecords.conversationId, exceptConversationId) : undefined,
      ),
    )
    .orderBy(usageRecords.conversationId, desc(usageRecords.createdAt));
  return rows.flatMap((r) => (r.conversationId ? [{ conversationId: r.conversationId, tokens: r.tokens, at: r.at }] : []));
}

/** This conversation's last prompt plus reply — what its next turn starts from. */
export async function conversationTokens(conversationId: string): Promise<number | null> {
  const rows = await db
    .select({ tokens: sql<number>`(${usageRecords.inputTokens} + ${usageRecords.outputTokens})::float8` })
    .from(usageRecords)
    .where(eq(usageRecords.conversationId, conversationId))
    .orderBy(desc(usageRecords.createdAt))
    .limit(1);
  const row = rows.at(0);
  return row ? row.tokens : null;
}

export interface StageView {
  index: number;
  /** The window one request gets at this stage (per slot). */
  context_tokens: number | null;
  /** The whole load's context (what `ctx-size` is set to). */
  load_tokens: number | null;
  yarn: boolean;
  /** The YaRN factor this stage loads with (2 = 2×); null for standard. */
  yarn_factor: number | null;
  fit: FitEstimate;
  /** Memory beyond the active stage's, when both are known. */
  extra_bytes: number;
}

export interface StageInfo {
  model: string;
  active: number;
  pending: number | null;
  who_may_change: WhoMayChange;
  may_change: boolean;
  when_full: WhenFull;
  stages: StageView[];
  /** The smallest stage this conversation fits in; 0 for a new one. */
  recommended: number;
  conversation_tokens: number | null;
  others: { count: number; last_used_at: string | null; running: number };
  /** Stepping below this would shrink the window under another conversation. */
  blocked_down_to: number;
  /** How long re-reading this conversation after a reload would take, from
   * this model's measured prefill rate. Null when either is unknown. */
  reread_seconds: number | null;
}

/** Everything the modals and the Context settings sheet show. */
export async function stageInfo(input: { row: LocalModelRow; isAdmin: boolean; conversationId?: string | null }): Promise<StageInfo> {
  const { row } = input;
  const config = rowStages(row);
  const windows = stageWindows(row);
  const loads = [0, ...(config?.stages ?? []).map((_, i) => i + 1)].map((i) => {
    const ctx = settingsForStage(row, i).ctxSize;
    return typeof ctx === "number" ? ctx : (rowMeta(row).nCtxTrain ?? null);
  });
  await refreshMemory();
  const active = activeStageIndex(row);
  const fits = windows.map((_, i) => fitFor(row.sizeBytes, rowMeta(row), settingsForStage(row, i), row.id));
  const uses = await recentUses(row.id, input.conversationId);
  const tokens = input.conversationId ? await conversationTokens(input.conversationId) : null;
  const rate = prefillRate(row.id);
  const lastAt = uses.reduce<Date | null>((latest, u) => (latest && latest > u.at ? latest : u.at), null);
  const whoMayChange = config?.whoMayChange ?? "everyone";
  return {
    model: row.id,
    active,
    pending: pendingStage(row.id),
    who_may_change: whoMayChange,
    may_change: config !== null && (input.isAdmin || whoMayChange === "everyone"),
    when_full: config?.whenFull ?? "compact",
    stages: windows.map((w, i) => ({
      index: i,
      context_tokens: w,
      load_tokens: loads[i],
      yarn: i > 0 && config !== null && yarnFactorOf(config.stages[i - 1], rowMeta(row)) !== null,
      yarn_factor: i > 0 && config ? yarnFactorOf(config.stages[i - 1], rowMeta(row)) : null,
      fit: fits[i],
      extra_bytes: Math.max(0, fits[i].requiredBytes - fits[active].requiredBytes),
    })),
    recommended: tokens === null ? 0 : smallestStageFor(tokens, windows, CONTEXT_STAGE_PROMPT_AT),
    conversation_tokens: tokens,
    others: {
      count: uses.length,
      last_used_at: lastAt?.toISOString() ?? null,
      running: runsUsingModel(row.id, input.conversationId ?? undefined).length,
    },
    blocked_down_to: neededByOthers(uses, windows),
    reread_seconds: tokens !== null && rate ? Math.round(tokens / rate) : null,
  };
}

export type StageRefusal =
  | "not_staged"
  | "not_allowed"
  | "others_need_stage"
  | "no_room"
  | "conversation_too_large"
  | "too_soon"
  | "switch_pending";

export class StageRequestError extends Error {
  constructor(
    readonly code: StageRefusal,
    message: string,
    readonly status = 409,
  ) {
    super(message);
    this.name = "StageRequestError";
  }
}

/**
 * May `target` be requested now? Throws `StageRequestError` with a sentence
 * the person asking can act on. `auto` is the model's own `whenFull` or a new
 * conversation stepping down: the admin chose it, so `whoMayChange` does not
 * apply — and a step down that others block is not refused but *limited*
 * (the resolved target is returned), since nobody asked for a precise stage.
 */
export async function checkStageRequest(input: {
  row: LocalModelRow;
  target: number;
  isAdmin: boolean;
  conversationId?: string | null;
  compactFirst?: boolean;
  auto?: boolean;
  /** Who is asking, so a person cannot replace another person's waiting switch. */
  userId?: string;
}): Promise<{ target: number; limitedBy: number | null }> {
  const { row } = input;
  const config = rowStages(row);
  if (!config) throw new StageRequestError("not_staged", "This model has no extended context stages.", 400);
  const windows = stageWindows(row);
  if (!Number.isInteger(input.target) || input.target < 0 || input.target >= windows.length) {
    throw new StageRequestError("not_staged", "There is no such stage.", 400);
  }
  if (!input.auto && !input.isAdmin && config.whoMayChange === "admins") {
    throw new StageRequestError("not_allowed", "An admin controls this model's context.", 403);
  }
  const active = activeStageIndex(row);
  if (!input.auto && !input.isAdmin && input.target !== active) {
    // A switch takes the whole backend, so how often one person may ask is
    // limited as well as whether they may (see `stageCooldownMs`).
    const wait = stageCooldownRemaining(row.id);
    if (wait > 0) {
      throw new StageRequestError("too_soon", `The context was switched a moment ago. You can change it again in ${String(Math.ceil(wait / 1000))} s.`, 429);
    }
    // A newer request replaces one still waiting, which is right for the same
    // person changing their mind and wrong for someone else cancelling it.
    const waiting = pendingSwitch(row.id);
    if (waiting && waiting.byUserId !== (input.userId ?? null)) {
      throw new StageRequestError("switch_pending", "Someone else's switch is already waiting or under way for this model. Try again once it has applied.");
    }
  }
  let target = input.target;
  let limitedBy: number | null = null;
  if (target < active) {
    const need = neededByOthers(await recentUses(row.id, input.conversationId), windows);
    if (target < need) {
      if (!input.auto) {
        throw new StageRequestError(
          "others_need_stage",
          `Another conversation using this model still needs ${label(windows[need])}, so it can't go lower than that yet.`,
        );
      }
      target = need;
      limitedBy = need;
    }
  }
  if (target > active) {
    try {
      await checkStageRoom(row, target);
    } catch (err) {
      if (err instanceof NoRoomError) {
        throw new StageRequestError("no_room", `There isn't enough GPU memory for ${label(windows[target])} while ${err.blockers.map((b) => `"${b.displayName}"`).join(", ")} ${err.blockers.length > 1 ? "are" : "is"} pinned.`);
      }
      throw err;
    }
  }
  if (input.conversationId && !input.compactFirst) {
    const tokens = await conversationTokens(input.conversationId);
    const w = windows[target];
    if (tokens !== null && w !== null && tokens >= w * fitAt()) {
      throw new StageRequestError(
        "conversation_too_large",
        `This conversation is about ${label(tokens)} tokens, too large for ${label(w)}. Compact it first.`,
      );
    }
  }
  return { target, limitedBy };
}

// See `formatTokens` in context-stage-switch.ts: three formatters, one wording.
function label(n: number | null | undefined): string {
  if (n == null) return "its standard context";
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(n % (1024 * 1024) === 0 ? 0 : 1)}M`;
  return `${String(Math.round(n / 1024))}K`;
}
