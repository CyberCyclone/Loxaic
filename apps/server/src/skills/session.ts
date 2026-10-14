/**
 * A conversation's skills over its life — see AGENTS.md, "Skills".
 *
 * The `skill` tool's description lists the skills the model may load, and the
 * tools array is the front of every prompt: a description that changed between
 * two turns would make the backend re-read the whole conversation. So the list
 * is frozen on the conversation's first run (`conversations.skill_catalog`),
 * and a skill added, edited or removed later reaches the model as a notice on
 * the next user message, appended at the end of the prompt where it costs only
 * its own tokens — the way a changed AGENTS.md does
 * (agent/instruction-updates.ts). The frozen list takes the live one only when
 * a compaction moves the front of the prompt anyway.
 *
 * The same pass reads a person's "/name" off the run's user message and puts
 * that skill's instructions on the row, so the live request and every replay
 * read them from storage.
 *
 * Runs once per run, before the toolset is built and the history is loaded.
 */
import { db, eq } from "@loxaic/db";
import { conversations, messages } from "@loxaic/db/schema";
import type { SkillListing } from "@loxaic/agent";
import { parseCommand, type ContentBlock, type SkillSource } from "@loxaic/types";
import type { StreamProducer } from "../streams/broker.ts";
import {
  describeCatalogChange,
  modelCatalog,
  renderInvocation,
  resolveSkillCatalog,
  type CatalogSkill,
  type SkillSummary,
} from "./catalog.ts";
import { recordSkillUse } from "./usage.ts";

/** What `conversations.skill_catalog` holds. */
export interface SkillCatalogSnapshot {
  /** What the `skill` tool's description lists: the catalog when it was last
   * frozen. */
  base: SkillSummary[];
  /** What the model has been told since, through notices. Absent when nothing
   * has changed since `base`. */
  latest?: SkillSummary[];
  /** The front of the prompt (`historyFront`) `base` was frozen against. */
  frontKey: string;
}

/** What a run needs of its skills. */
export interface RunSkills {
  /** The `skill` tool's listing, or null to leave the tool out. */
  listing: SkillListing[] | null;
  /** A skill the model may load, by name, from the live catalog — a skill
   * announced since the list was frozen included. */
  find(name: string): CatalogSkill | undefined;
  /** Every name `find` answers, for a refusal that lists them. */
  names(): string[];
}

const NO_SKILLS: RunSkills = { listing: null, find: () => undefined, names: () => [] };

export function coerceSnapshot(raw: unknown): SkillCatalogSnapshot | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<SkillCatalogSnapshot>;
  if (!Array.isArray(r.base) || typeof r.frontKey !== "string") return null;
  const ok = (s: unknown): s is SkillSummary =>
    !!s && typeof s === "object" &&
    typeof (s as SkillSummary).name === "string" &&
    typeof (s as SkillSummary).description === "string" &&
    typeof (s as SkillSummary).hash === "string";
  return {
    base: r.base.filter(ok),
    ...(Array.isArray(r.latest) ? { latest: r.latest.filter(ok) } : {}),
    frontKey: r.frontKey,
  };
}

/** The pure decision: what to store, and what to tell the model. */
export function advanceSnapshot(
  stored: SkillCatalogSnapshot | null,
  live: SkillSummary[],
  front: string,
): { snapshot: SkillCatalogSnapshot; notice: { text: string; summary: string } | null; dirty: boolean } {
  if (!stored) return { snapshot: { base: live, frontKey: front }, notice: null, dirty: true };
  // A compaction moved the front, so this request re-reads everything after
  // the system prompt anyway: the tool description may change with it.
  if (stored.frontKey !== front) return { snapshot: { base: live, frontKey: front }, notice: null, dirty: true };
  const notice = describeCatalogChange(stored.latest ?? stored.base, live);
  if (!notice) return { snapshot: stored, notice: null, dirty: false };
  return { snapshot: { ...stored, latest: live }, notice, dirty: true };
}

/** The listing the tool is offered with, from the frozen list. Offered
 * whenever the model can load anything: a conversation whose frozen list was
 * empty and has since been told of a skill needs the tool to load it. */
export function listingFor(snapshot: SkillCatalogSnapshot): SkillListing[] | null {
  if ((snapshot.latest ?? snapshot.base).length === 0) return null;
  return snapshot.base.map((s) => ({ name: s.name, description: s.description }));
}

function lookup(live: readonly CatalogSkill[]): Pick<RunSkills, "find" | "names"> {
  const usable = live.filter((s) => s.modelInvocable && !s.action);
  const byName = new Map(usable.map((s) => [s.name, s]));
  return { find: (name) => byName.get(name), names: () => [...byName.keys()].sort() };
}

/**
 * Before a run's toolset is built: freeze or advance the conversation's
 * catalog, attach a notice of any change and a "/name" invocation to this
 * run's user message, and return what the run needs. Never throws: a failure
 * leaves the run without the skill tool rather than without a reply.
 */
export async function prepareRunSkills(input: {
  convId: string;
  /** The sender, whose use of a "/name" is counted. */
  userId: string;
  userMsgId: string;
  /** `historyFront` of the conversation now. */
  front: string;
  producer: Pick<StreamProducer, "emit">;
  /** Set for a sub-agent: it is one run long, so it takes its parent owner's
   * live catalog and keeps nothing. */
  parentConvId?: string;
}): Promise<RunSkills> {
  try {
    const ownerConvId = input.parentConvId ?? input.convId;
    const row = await db.query.conversations.findFirst({
      where: eq(conversations.id, ownerConvId),
      columns: { ownerId: true, skillCatalog: true },
    });
    if (!row) return NO_SKILLS;
    const live = await resolveSkillCatalog({ ownerId: row.ownerId, conversationId: ownerConvId });
    const found = lookup(live);
    const liveSummaries = modelCatalog(live);

    if (input.parentConvId) {
      return { ...found, listing: liveSummaries.length ? liveSummaries.map(({ name, description }) => ({ name, description })) : null };
    }

    const step = advanceSnapshot(coerceSnapshot(row.skillCatalog), liveSummaries, input.front);
    const blocks: ContentBlock[] = [];
    if (step.notice) blocks.push({ kind: "skills_update", text: step.notice.text, summary: step.notice.summary });

    const message = await db.query.messages.findFirst({
      where: eq(messages.id, input.userMsgId),
      columns: { content: true, authorType: true },
    });
    const content = (message?.content ?? []) as ContentBlock[];
    // A retry answers the same row again: its invocation is already there.
    const invoked =
      message?.authorType === "user" && !content.some((b) => b.kind === "skill")
        ? invokedSkill(content, live)
        : null;
    if (invoked) {
      blocks.push({ kind: "skill", name: invoked.name, source: invoked.source, text: renderInvocation(invoked) });
    }

    if (blocks.length && message) {
      await db
        .update(messages)
        .set({ content: [...content, ...blocks] })
        .where(eq(messages.id, input.userMsgId));
      if (step.notice) input.producer.emit({ kind: "skills.update", message_id: input.userMsgId, summary: step.notice.summary });
      if (invoked) {
        input.producer.emit({ kind: "skill.invoked", message_id: input.userMsgId, name: invoked.name, source: invoked.source });
        await recordSkillUse(input.userId, invoked.name);
      }
    }
    if (step.dirty) {
      await db.update(conversations).set({ skillCatalog: step.snapshot }).where(eq(conversations.id, input.convId));
    }
    return { ...found, listing: listingFor(step.snapshot) };
  } catch (err) {
    console.warn(`preparing the skills of ${input.convId} failed: ${(err as Error).message}`);
    return NO_SKILLS;
  }
}

/** The skill a message's text invokes ("/name …"), if it names one that hands
 * instructions to the model. An action skill (`/compact`) is not sent as a
 * message, and an unknown name is ordinary text. */
export function invokedSkill(
  content: readonly ContentBlock[],
  live: readonly CatalogSkill[],
): (CatalogSkill & { source: SkillSource }) | null {
  const text = content
    .filter((b): b is Extract<ContentBlock, { kind: "text" }> => b.kind === "text")
    .map((b) => b.text)
    .join("\n");
  const parsed = parseCommand(text);
  if (!parsed) return null;
  const skill = live.find((s) => s.name === parsed.name);
  if (!skill || skill.action) return null;
  return skill;
}
