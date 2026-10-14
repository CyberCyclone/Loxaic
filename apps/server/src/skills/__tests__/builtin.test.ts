import { describe, expect, it } from "vitest";
import { isValidSkillName } from "@loxaic/types";
import { BUILTIN_SKILL_FILES, builtinSkills } from "../builtin/index.ts";
import { parseSkillFile } from "../format.ts";

/** The built-ins are held to exactly the rules a person's own skill is. */
describe("the built-in skills", () => {
  it("each parse cleanly, with a valid unique name and a description that says when to use it", () => {
    const names = new Set<string>();
    for (const def of BUILTIN_SKILL_FILES) {
      const r = parseSkillFile(def.file);
      expect(r.ok).toBe(true);
      if (!r.ok) continue;
      expect(r.skill.warnings).toEqual([]);
      expect(isValidSkillName(r.skill.name)).toBe(true);
      expect(names.has(r.skill.name)).toBe(false);
      names.add(r.skill.name);
      expect(r.skill.body.length).toBeGreaterThan(0);
      expect(r.skill.body.split("\n").length).toBeLessThan(500);
    }
    expect([...names].sort()).toEqual(
      ["code-review", "commit", "compact", "create-skill", "debug", "pr-description", "security-review", "write-tests"],
    );
  });

  it("make compaction a skill only a person runs, which the harness performs", () => {
    const compact = builtinSkills().find((s) => s.name === "compact");
    expect(compact).toMatchObject({ action: "compact", modelInvocable: false, requiresConversation: true, argHint: "[guidance]" });
    expect(builtinSkills().filter((s) => s.action)).toHaveLength(1);
  });
});
