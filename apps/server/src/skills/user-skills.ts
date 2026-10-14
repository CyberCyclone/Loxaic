/**
 * What a person may save as their own skill (#283), checked before it is
 * written. The same limits the format gives a `SKILL.md` (skills/format.ts),
 * stated as the reasons a form can show.
 */
import { isValidSkillName } from "@loxaic/types";
import { MAX_SKILL_BODY_BYTES, MAX_SKILL_DESCRIPTION } from "./format.ts";

/** Every skill's name and description is in the model's list on every
 * request, so a person's own are capped. */
export const MAX_USER_SKILLS = 100;

export interface SkillInput {
  name: string;
  description: string;
  body: string;
  modelInvocable: boolean;
}

/**
 * The fields of a create (`partial: false`, every field but `modelInvocable`
 * required) or an edit (`partial: true`, only what is present), or the reason
 * they cannot be saved.
 */
export function validateSkillInput(
  raw: unknown,
  partial: boolean,
): { ok: true; value: Partial<SkillInput> } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object") return { ok: false, error: "Send the skill as JSON." };
  const r = raw as Record<string, unknown>;
  const out: Partial<SkillInput> = {};

  if (r.name !== undefined || !partial) {
    if (typeof r.name !== "string") return { ok: false, error: "A skill needs a name." };
    const name = r.name.trim();
    if (!isValidSkillName(name)) {
      return {
        ok: false,
        error: "A name uses lowercase letters, digits and single hyphens (not at either end), up to 64 characters.",
      };
    }
    out.name = name;
  }
  if (r.description !== undefined || !partial) {
    if (typeof r.description !== "string" || !r.description.trim()) {
      return { ok: false, error: "A skill needs a description: what it does, and when to use it." };
    }
    const description = r.description.trim().replace(/\s+/g, " ");
    if (description.length > MAX_SKILL_DESCRIPTION) {
      return { ok: false, error: `A description is at most ${String(MAX_SKILL_DESCRIPTION)} characters.` };
    }
    out.description = description;
  }
  if (r.body !== undefined || !partial) {
    if (typeof r.body !== "string" || !r.body.trim()) {
      return { ok: false, error: "A skill needs instructions." };
    }
    const body = r.body.trim();
    if (Buffer.byteLength(body, "utf8") > MAX_SKILL_BODY_BYTES) {
      return { ok: false, error: `Instructions are at most ${String(MAX_SKILL_BODY_BYTES / 1024)} KB.` };
    }
    out.body = body;
  }
  if (r.modelInvocable !== undefined) {
    if (typeof r.modelInvocable !== "boolean") return { ok: false, error: "modelInvocable must be true or false." };
    out.modelInvocable = r.modelInvocable;
  }
  if (partial && Object.keys(out).length === 0) return { ok: false, error: "Nothing to change." };
  return { ok: true, value: out };
}
