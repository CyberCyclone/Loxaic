/**
 * Which skills a conversation can use, and the pure decisions made about them
 * — see AGENTS.md, "Skills".
 *
 * A name defined in more than one place resolves to the most specific
 * definition: a workspace's, then the person's own, then the built-in. That is
 * the Agent Skills convention (project overrides user), and it is how a person
 * changes a built-in: by adding their own skill of the same name. `/compact`
 * is no exception.
 */
import { createHash } from "node:crypto";
import type { PaletteSkill, SkillAction, SkillSource } from "@loxaic/types";
import { builtinSkills } from "./builtin/index.ts";

export interface CatalogSkill {
  name: string;
  description: string;
  source: SkillSource;
  /** The instructions the model is given; for an action skill, what the
   * Skills screen shows a person. */
  body: string;
  /** False for a skill only a person may run. */
  modelInvocable: boolean;
  argHint?: string;
  action?: SkillAction;
  requiresConversation?: boolean;
}

/** One layer per source, least specific first; a later layer's skill
 * replaces an earlier one of the same name. Order within the result: each
 * name where it first appeared. */
export function mergeSkillLayers(layers: readonly (readonly CatalogSkill[])[]): CatalogSkill[] {
  const byName = new Map<string, CatalogSkill>();
  for (const layer of layers) for (const skill of layer) byName.set(skill.name, skill);
  return [...byName.values()];
}

export function builtinCatalogSkills(): CatalogSkill[] {
  return builtinSkills().map((s) => ({
    name: s.name,
    description: s.description,
    source: "builtin" as const,
    body: s.body,
    modelInvocable: s.modelInvocable,
    ...(s.argHint ? { argHint: s.argHint } : {}),
    ...(s.action ? { action: s.action } : {}),
    ...(s.requiresConversation ? { requiresConversation: true } : {}),
  }));
}

/**
 * The live catalog for a conversation's owner: every skill they can use right
 * now. Resolved for the **owner**, never the sender: two editors with two
 * catalogs would announce each other's skills to the model on every turn
 * they alternated.
 */
export function resolveSkillCatalog(_input: { ownerId: string; conversationId?: string | null }): Promise<CatalogSkill[]> {
  return Promise.resolve(mergeSkillLayers([builtinCatalogSkills(), testLayer]));
}

/** Skills a test adds on top of the built-ins, standing in for a person's
 * own: what lets a test change the live catalog under a conversation. */
let testLayer: CatalogSkill[] = [];
export function __setTestSkillsForTest(skills: CatalogSkill[]): void {
  testLayer = skills;
}

// ── What the model is told ────────────────────────────────

/** A skill as the frozen catalog records it: enough to list it, and a hash
 * that changes when anything the model would read of it changes. */
export interface SkillSummary {
  name: string;
  description: string;
  source: SkillSource;
  hash: string;
}

export function summarize(skill: CatalogSkill): SkillSummary {
  const hash = createHash("sha256").update(`${skill.description}\n\u0000${skill.body}`).digest("hex").slice(0, 16);
  return { name: skill.name, description: skill.description, source: skill.source, hash };
}

/** The skills the model may load itself, as the catalog records them — the
 * ones a person alone may run are never listed to it. Sorted by name, so the
 * listing does not move when a source reorders its own. */
export function modelCatalog(skills: readonly CatalogSkill[]): SkillSummary[] {
  return skills
    .filter((s) => s.modelInvocable && !s.action)
    .map(summarize)
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

export const SKILL_CONTENT_TAG = "skill-content";
export const SKILLS_UPDATE_TAG = "skills-update";

/** What a closing marker inside a skill becomes, so its text cannot end its
 * own wrapper — the neutralisation wrapDocument and the instructions use. */
export function neutraliseSkillText(text: string): string {
  return text
    .split(`</${SKILL_CONTENT_TAG}`).join(`</\u200b${SKILL_CONTENT_TAG}`)
    .split(`</${SKILLS_UPDATE_TAG}`).join(`</\u200b${SKILLS_UPDATE_TAG}`);
}

function attr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

/** A skill's instructions as the model receives them, from the tool or from a
 * person's "/name". Deterministic: it is persisted and replayed. */
export function renderSkillContent(skill: Pick<CatalogSkill, "name" | "source" | "body">): string {
  return (
    `<${SKILL_CONTENT_TAG} name="${attr(skill.name)}" source="${skill.source}">\n` +
    `${neutraliseSkillText(skill.body)}\n` +
    `</${SKILL_CONTENT_TAG}>`
  );
}

/** What precedes a person's own message when it began "/name". */
export function renderInvocation(skill: Pick<CatalogSkill, "name" | "source" | "body">): string {
  return (
    `The user invoked the "${skill.name}" skill for the message that follows. Follow its instructions, ` +
    `treating the rest of the message as the task and any details it gives.\n` +
    renderSkillContent(skill)
  );
}

/**
 * How the catalog the model knows (`known`) differs from the live one, as the
 * notice it is given and the line a client shows — or null when nothing it
 * would read changed. Only the names, descriptions and a "load it again" for
 * changed instructions: the instructions themselves arrive only when loaded,
 * as everywhere else.
 */
export function describeCatalogChange(
  known: readonly SkillSummary[],
  now: readonly SkillSummary[],
): { text: string; summary: string } | null {
  const before = new Map(known.map((s) => [s.name, s]));
  const after = new Map(now.map((s) => [s.name, s]));
  const added = now.filter((s) => !before.has(s.name));
  const removed = known.filter((s) => !after.has(s.name));
  const changed = now.filter((s) => {
    const b = before.get(s.name);
    return b !== undefined && b.hash !== s.hash;
  });
  if (!added.length && !removed.length && !changed.length) return null;

  const lines: string[] = [
    `<${SKILLS_UPDATE_TAG}>`,
    "Loxaic's notice, not the user's: the skills available to you have changed since the list in the skill " +
      "tool's description was written. Use this list from now on.",
  ];
  const one = (s: SkillSummary) => `- ${s.name}: ${neutraliseSkillText(s.description)}`;
  if (added.length) lines.push("New skills:", ...added.map(one));
  if (changed.length) {
    lines.push("Changed skills (if you are following one, load it again with the skill tool before continuing):");
    for (const s of changed) {
      const b = before.get(s.name);
      lines.push(b && b.description !== s.description ? one(s) : `- ${s.name}`);
    }
  }
  if (removed.length) lines.push(`No longer available: ${removed.map((s) => s.name).join(", ")}`);
  lines.push(`</${SKILLS_UPDATE_TAG}>`);

  const parts: string[] = [];
  if (added.length) parts.push(`added ${added.map((s) => s.name).join(", ")}`);
  if (changed.length) parts.push(`changed ${changed.map((s) => s.name).join(", ")}`);
  if (removed.length) parts.push(`removed ${removed.map((s) => s.name).join(", ")}`);
  return { text: lines.join("\n"), summary: `Skills changed: ${parts.join("; ")}` };
}

// ── What the palette lists ────────────────────────────────

export interface SkillUse {
  count: number;
  lastUsedAt: string;
}

/**
 * The palette's list: every skill, most-used first, then most recently used,
 * then by name. The person's own counts decide the order — what they reach
 * for comes first.
 */
export function paletteSkills(
  skills: readonly CatalogSkill[],
  usage: Readonly<Record<string, SkillUse | undefined>>,
): PaletteSkill[] {
  const rows = skills.map((s) => {
    const use = usage[s.name];
    return {
      skill: s,
      count: use && Number.isFinite(use.count) ? use.count : 0,
      last: use ? Date.parse(use.lastUsedAt) || 0 : 0,
    };
  });
  rows.sort((a, b) => b.count - a.count || b.last - a.last || (a.skill.name < b.skill.name ? -1 : a.skill.name > b.skill.name ? 1 : 0));
  return rows.map(({ skill: s, count }) => ({
    name: s.name,
    description: s.description,
    source: s.source,
    ...(s.argHint ? { argHint: s.argHint } : {}),
    ...(s.action ? { action: s.action } : {}),
    ...(s.requiresConversation ? { requiresConversation: true } : {}),
    uses: count,
  }));
}
