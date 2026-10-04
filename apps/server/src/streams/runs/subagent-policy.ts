import { and, db, eq, isNull } from "@loxaic/db";
import { conversations, userPrefs } from "@loxaic/db/schema";
import {
  DEFAULT_SUBAGENT_MODEL_MODE,
  isSubAgentModelMode,
  type SubAgentModelMode,
  type SubAgentStatus,
} from "@loxaic/types";
import { assertModelResolvable } from "../../inference/providers.ts";
import { normalizeRecentModels } from "../../inference/recent-models.ts";

/**
 * Which model a sub-agent runs on, and what a parent is told about how one
 * ended. The rules of sub-agents that are decisions rather than plumbing —
 * kept apart from subagentRun.ts so each can be tested without a run.
 */

/** A user's sub-agent model setting, as stored. */
export interface SubagentModelPolicy {
  mode: SubAgentModelMode;
  /** The model `fixed` uses; null when none was ever saved. Only read in
   * that mode. */
  model: string | null;
}

/**
 * The sender's policy. A failed read answers `parent`, not the default
 * `choose`: a sub-agent on the parent's model is the outcome that cannot spend
 * anything the conversation was not already spending.
 */
export async function loadSubagentPolicy(userId: string): Promise<SubagentModelPolicy> {
  try {
    const row = await db.query.userPrefs.findFirst({
      where: eq(userPrefs.userId, userId),
      columns: { subagentModelMode: true, subagentModel: true },
    });
    const mode = isSubAgentModelMode(row?.subagentModelMode) ? row.subagentModelMode : DEFAULT_SUBAGENT_MODEL_MODE;
    return { mode, model: typeof row?.subagentModel === "string" && row.subagentModel ? row.subagentModel : null };
  } catch {
    return { mode: "parent", model: null };
  }
}

/**
 * Whether the parent is offered a choice of model at all.
 *
 * Only under `choose`, and never in a routine. A routine runs with nobody
 * watching, and a model its owner did not pick is exactly what a routine's own
 * model rule forbids (see AGENTS.md, "Routines") — so there `choose` behaves
 * as `parent`. `fixed` still applies in a routine: that one the person chose.
 */
export function offersModelChoice(policy: SubagentModelPolicy, routine: boolean): boolean {
  return policy.mode === "choose" && !routine;
}

/** How many models the tool's `model` argument names at most: the parent's
 * plus the recently-used list, which is itself capped at eight. */
const MAX_OFFERED_MODELS = 9;

/**
 * The models this conversation's `subagent` tool names, frozen on first use.
 *
 * The list rides in the tools array, which is the front of every prompt. Built
 * per run from the sender's recently-used models it would move whenever they
 * sent with a different model anywhere, and whenever a different editor sent
 * into a shared conversation — each a full prompt re-evaluation for a change
 * nobody made on purpose. So it is decided once, stored on the conversation,
 * and read back; sorted, so it does not depend on the order it was found in.
 *
 * The cost is stated plainly: a model added after this was frozen is not
 * offered to this conversation's sub-agents. The parent's own model always
 * is (it is the default when `model` is omitted), whatever the list says.
 *
 * Null when there is nothing to choose between, which leaves the argument off
 * the tool entirely.
 */
export async function offeredSubagentModels(input: {
  conversationId: string;
  userId: string;
  parentModel: string;
}): Promise<string[] | null> {
  const row = await db.query.conversations.findFirst({
    where: eq(conversations.id, input.conversationId),
    columns: { subagentModels: true },
  });
  if (Array.isArray(row?.subagentModels)) return usableList(row.subagentModels);

  const prefs = await db.query.userPrefs.findFirst({
    where: eq(userPrefs.userId, input.userId),
    columns: { recentModels: true },
  });
  const candidates = [input.parentModel, ...normalizeRecentModels(prefs?.recentModels)];
  const resolvable: string[] = [];
  for (const ref of new Set(candidates)) {
    if (!ref || ref === "default") continue;
    // Database only — no provider is asked — so this costs the run nothing it
    // would notice, and a deleted provider's reference is simply not offered.
    if (await assertModelResolvable(ref).then(() => true, () => false)) resolvable.push(ref);
    if (resolvable.length >= MAX_OFFERED_MODELS) break;
  }
  const list = resolvable.sort();
  // Only if still unset: two runs cannot start on one conversation at once,
  // but a racing writer must lose rather than replace what a request already
  // went out with.
  await db
    .update(conversations)
    .set({ subagentModels: list })
    .where(and(eq(conversations.id, input.conversationId), isNull(conversations.subagentModels)));
  const stored = await db.query.conversations.findFirst({
    where: eq(conversations.id, input.conversationId),
    columns: { subagentModels: true },
  });
  return usableList(Array.isArray(stored?.subagentModels) ? stored.subagentModels : list);
}

function usableList(raw: unknown[]): string[] | null {
  const list = raw.filter((v): v is string => typeof v === "string" && v.length > 0);
  return list.length > 1 ? list : null;
}

/**
 * The model one sub-agent call runs on, or the reason it cannot.
 *
 * Pure. An unknown `requested` is an error the parent reads, never a quiet
 * fall back to another model: the parent asked for something specific, and a
 * child answering from a different model with nothing saying so is the
 * failure `assertModelUsable` exists to prevent everywhere else.
 */
export function subagentModelFor(input: {
  policy: SubagentModelPolicy;
  parentModel: string;
  /** What the call's `model` argument said, if anything. */
  requested: unknown;
  /** What the tool offered this run (`offeredSubagentModels`), or null. */
  offered: readonly string[] | null;
  routine: boolean;
}): { model: string } | { error: string } {
  const { policy, parentModel, requested, offered } = input;
  if (policy.mode === "fixed") return { model: policy.model ?? parentModel };
  if (!offersModelChoice(policy, input.routine)) return { model: parentModel };
  if (requested === undefined || requested === null || requested === "") return { model: parentModel };
  if (typeof requested === "string" && (requested === parentModel || offered?.includes(requested))) {
    return { model: requested };
  }
  const choices = offered?.length ? ` Choose one of: ${offered.join(", ")}; or omit \`model\`.` : " Omit `model`.";
  return { error: `Unknown model for a sub-agent: ${JSON.stringify(requested)}.${choices}` };
}

/** The most of a child's final reply a parent is given. A sub-agent exists to
 * keep its working out of the parent's window; a reply that brought it all
 * back would defeat that. */
export const MAX_SUBAGENT_RESULT_BYTES = 16 * 1024;

const RESULT_CLOSE = "</subagent-result>";

/**
 * What the parent's model reads as the result of a `subagent` call.
 *
 * Pure and deterministic — the same child outcome always renders the same
 * text — because this is persisted as the tool result and replayed on every
 * later turn, where a byte of difference would cost the parent its cached
 * prefix.
 *
 * Wrapped in markers for the reason a document and an MCP result are: the
 * reply is a model's output that may quote anything, and the parent should
 * read it as a report, not as its user speaking. A literal closing marker
 * inside it is broken with a zero-width space so the report cannot end itself
 * early.
 */
export function subagentResultText(input: {
  description: string;
  status: Exclude<SubAgentStatus, "running">;
  text: string;
  error?: string | null;
}): string {
  const body = truncateUtf8(input.text.trim(), MAX_SUBAGENT_RESULT_BYTES).replaceAll(RESULT_CLOSE, "</subagent-​result>");
  const label = input.description.replace(/["<>\r\n]/g, " ").trim();
  const wrap = (inner: string) => `<subagent-result description="${label}">\n${inner}\n${RESULT_CLOSE}`;
  if (input.status === "complete") {
    return wrap(body || "The sub-agent finished without a final reply.");
  }
  const head =
    input.status === "cancelled"
      ? "This sub-agent was stopped before it finished."
      : `This sub-agent failed${input.error ? `: ${input.error}` : "."}`;
  return wrap(body ? `${head} What it had written so far:\n\n${body}` : head);
}

/** Cuts at a character boundary at or below `maxBytes`, saying so. */
function truncateUtf8(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxBytes) return text;
  let end = maxBytes;
  // A continuation byte is 10xxxxxx; step back to the start of the character.
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return `${bytes.subarray(0, end).toString("utf8")}\n\n[The sub-agent's reply was cut here: it was longer than ${String(maxBytes / 1024)} KB.]`;
}

/** Said to the parent for a `subagent` call past the per-message cap. */
export function tooManySubagentsText(max: number): string {
  return `Not started: one message may start at most ${String(max)} sub-agents. Start this one in a later step if it is still needed.`;
}
