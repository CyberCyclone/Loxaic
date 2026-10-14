/**
 * The skills every Loxaic server ships (#283). Each is the full text of a
 * `SKILL.md`, kept as a string in code rather than a file beside it: the
 * desktop app ships only the bundled `dist/` of this package, so a loose
 * markdown file would not be there to read.
 *
 * They are read through the same parser as a person's own skills and a
 * workspace's (../format.ts), and `builtin.test.ts` parses every one, so a
 * built-in cannot be written in a way that format would refuse.
 *
 * Read-only and always on: a person changes one only by adding their own skill
 * of the same name, which supersedes it.
 */
import type { SkillAction } from "@loxaic/types";
import { parseSkillFile, type ParsedSkill } from "../format.ts";
import { CODE_REVIEW_SKILL } from "./code-review.ts";
import { COMMIT_SKILL } from "./commit.ts";
import { COMPACT_SKILL } from "./compact.ts";
import { CREATE_SKILL_SKILL } from "./create-skill.ts";
import { DEBUG_SKILL } from "./debug.ts";
import { PR_DESCRIPTION_SKILL } from "./pr-description.ts";
import { SECURITY_REVIEW_SKILL } from "./security-review.ts";
import { WRITE_TESTS_SKILL } from "./write-tests.ts";

interface BuiltinSkillDef {
  /** The whole `SKILL.md`. */
  file: string;
  /** Set when the harness performs the skill itself rather than handing
   * instructions to the model. */
  action?: SkillAction;
  /** It acts on a conversation that exists — there is nothing to compact
   * before the first message. */
  requiresConversation?: boolean;
}

export const BUILTIN_SKILL_FILES: readonly BuiltinSkillDef[] = [
  { file: COMPACT_SKILL, action: "compact", requiresConversation: true },
  { file: CODE_REVIEW_SKILL },
  { file: SECURITY_REVIEW_SKILL },
  { file: WRITE_TESTS_SKILL },
  { file: DEBUG_SKILL },
  { file: COMMIT_SKILL },
  { file: PR_DESCRIPTION_SKILL },
  { file: CREATE_SKILL_SKILL },
];

export interface BuiltinSkill extends ParsedSkill {
  action?: SkillAction;
  requiresConversation?: boolean;
}

let parsed: BuiltinSkill[] | null = null;

/** Every built-in, parsed once. A built-in the parser refuses is a bug in this
 * directory, so it throws rather than quietly shipping fewer skills. */
export function builtinSkills(): readonly BuiltinSkill[] {
  if (parsed) return parsed;
  parsed = BUILTIN_SKILL_FILES.map((def) => {
    const result = parseSkillFile(def.file);
    if (!result.ok) throw new Error(`built-in skill is invalid: ${result.error}`);
    return {
      ...result.skill,
      ...(def.action ? { action: def.action } : {}),
      ...(def.requiresConversation ? { requiresConversation: true } : {}),
    };
  });
  return parsed;
}
