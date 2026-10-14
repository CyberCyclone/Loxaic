/**
 * Slash invocations: what the composer's palette lists, and how a typed
 * "/name args" is read.
 *
 * Everything the palette offers is a skill (#283) — the built-ins, the
 * user's own, and a workspace's — and the list comes from the server
 * (`GET /v1/skills`), which is also what decides what a name means when it
 * arrives. `/compact` is one of the built-ins: a skill whose `action` is the
 * harness's compaction rather than instructions for the model, which is why
 * it rides `command.run` instead of being sent as a message.
 */

/** Where a skill comes from. A name defined in more than one place resolves
 * to the most specific: workspace, then the user's own, then built-in. */
export type SkillSource = "builtin" | "user" | "workspace";

/** The one action a skill can carry instead of instructions. */
export type SkillAction = "compact";

/** A skill as the palette lists it. */
export interface PaletteSkill {
  name: string;
  description: string;
  source: SkillSource;
  /** Shown muted after the name, e.g. "[guidance]". */
  argHint?: string;
  /** Set for a skill the harness runs itself (`/compact`): sent as
   * `command.run`, never as a message. */
  action?: SkillAction;
  /** True when it acts on an existing thread — nothing to compact in a
   * conversation that hasn't started. */
  requiresConversation?: boolean;
  /** How many times this person has invoked it. The list arrives already
   * sorted most-used first; this is for display and tests. */
  uses: number;
}

/** The longest skill name the Agent Skills format allows. */
export const SKILL_NAME_MAX = 64;

/** Whether `name` is a skill name as the Agent Skills format allows it:
 * lowercase letters, digits and single hyphens, not at either end, at most 64
 * characters. No lookbehind, which not every JavaScript engine the app runs on
 * has. */
export function isValidSkillName(name: string): boolean {
  return name.length <= SKILL_NAME_MAX && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name);
}

/** A command name (or prefix of one) still being typed: slash, then only name
 * characters, nothing else. The instant a space lands the user is writing
 * arguments (or prose), so the palette must close. */
const QUERY_RE = /^\/([a-z0-9-]*)$/i;

/**
 * The prefix being typed after "/", or null when the palette must not be open.
 * "" (bare "/") means "show everything".
 */
export function commandQuery(text: string): string | null {
  const m = QUERY_RE.exec(text);
  return m ? m[1].toLowerCase() : null;
}

const COMMAND_RE = /^\/([a-z0-9-]+)(?:\s+([\s\S]*))?$/i;

/**
 * Parse a would-be invocation at send time. Returns null for anything that
 * isn't shaped like one — and callers must ALSO check the name against the
 * skills: an unknown "/foo bar" is deliberately sent as ordinary text,
 * because people do start messages with a slash.
 */
export function parseCommand(text: string): { name: string; args: string } | null {
  const m = COMMAND_RE.exec(text.trim());
  if (!m) return null;
  return { name: m[1].toLowerCase(), args: (m[2] || "").trim() };
}

/** One of a person's own skills, as the Skills screen edits it. */
export interface UserSkill {
  id: string;
  name: string;
  description: string;
  body: string;
  /** False: only a person runs it, by typing its name. */
  modelInvocable: boolean;
  /** Its name is a built-in's, which it supersedes for its owner. */
  overridesBuiltin: boolean;
  createdAt: string;
  updatedAt: string;
}

/** A built-in as the Skills screen shows it: read-only. */
export interface BuiltinSkillView {
  name: string;
  description: string;
  body: string;
  modelInvocable: boolean;
  argHint?: string;
  action?: SkillAction;
  /** The id of the person's own skill that supersedes it, or null. */
  overriddenBy: string | null;
}

/** `GET /v1/skills/mine`. */
export interface MySkills {
  builtin: BuiltinSkillView[];
  mine: UserSkill[];
}

/** What creating or editing one of a person's own skills sends. */
export interface SkillInput {
  name: string;
  description: string;
  body: string;
  modelInvocable?: boolean;
}
