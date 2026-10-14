import { describe, expect, it } from "vitest";
import { MAX_SKILL_BODY_BYTES, MAX_SKILL_DESCRIPTION, parseSkillFile, quoteColonValues } from "../format.ts";

/**
 * One parser for every skill Loxaic loads. Lenient the way the Agent Skills
 * client guide asks — a skill written for another tool should load here — and
 * strict only where a skill would be unusable: no description (nothing to tell
 * the model), or a name that cannot be typed after a slash.
 */
const file = (front: string, body = "Do the thing.") => `---\n${front}\n---\n${body}\n`;

describe("parseSkillFile", () => {
  it("reads name, description and body", () => {
    const r = parseSkillFile(file("name: pdf-tools\ndescription: Work with PDFs. Use when given one.", "# PDF\n\n1. Read it."));
    expect(r).toEqual({
      ok: true,
      skill: { name: "pdf-tools", description: "Work with PDFs. Use when given one.", body: "# PDF\n\n1. Read it.", modelInvocable: true, warnings: [] },
    });
  });

  it("refuses a file without frontmatter, or without a description", () => {
    expect(parseSkillFile("# Just markdown").ok).toBe(false);
    const r = parseSkillFile(file("name: empty"));
    expect(r).toEqual({ ok: false, error: '"empty" has no description' });
  });

  it("repairs an unquoted value with a colon in it, the commonest invalid YAML in the wild", () => {
    const r = parseSkillFile(file("name: x\ndescription: Use this when: the user asks about PDFs"));
    expect(r.ok && r.skill.description).toBe("Use this when: the user asks about PDFs");
    expect(quoteColonValues('description: a: b "c"')).toBe('description: "a: b \\"c\\""');
  });

  it("takes the directory's name when the file has none, and warns when they differ", () => {
    const named = parseSkillFile(file("description: d"), { dirName: "from-dir" });
    expect(named.ok && named.skill.name).toBe("from-dir");
    const differ = parseSkillFile(file("name: other\ndescription: d"), { dirName: "from-dir" });
    expect(differ.ok && differ.skill.warnings.join(" ")).toMatch(/does not match its directory/);
  });

  it("forgives a name that can still be typed, and refuses one that cannot", () => {
    const upper = parseSkillFile(file("name: PDF-Tools\ndescription: d"));
    expect(upper.ok && upper.skill.name).toBe("pdf-tools");
    expect(upper.ok && upper.skill.warnings.length).toBe(1);
    expect(parseSkillFile(file("name: has spaces\ndescription: d")).ok).toBe(false);
    expect(parseSkillFile(file("name: ../../etc\ndescription: d")).ok).toBe(false);
  });

  it("reads disable-model-invocation and argument-hint", () => {
    const r = parseSkillFile(file('name: x\ndescription: d\ndisable-model-invocation: true\nargument-hint: "[file]"'));
    expect(r.ok && r.skill.modelInvocable).toBe(false);
    expect(r.ok && r.skill.argHint).toBe("[file]");
  });

  it("puts a folded description on one line, and cuts an oversized one", () => {
    const folded = parseSkillFile(file("name: x\ndescription: >\n  first line\n  second line"));
    expect(folded.ok && folded.skill.description).toBe("first line second line");
    const long = parseSkillFile(file(`name: x\ndescription: ${"d".repeat(MAX_SKILL_DESCRIPTION + 50)}`));
    expect(long.ok && long.skill.description.length).toBe(MAX_SKILL_DESCRIPTION);
  });

  it("cuts an oversized body on a character boundary", () => {
    const r = parseSkillFile(file("name: x\ndescription: d", "é".repeat(MAX_SKILL_BODY_BYTES)));
    expect(r.ok && Buffer.byteLength(r.skill.body, "utf8")).toBeLessThanOrEqual(MAX_SKILL_BODY_BYTES);
    expect(r.ok && r.skill.body.endsWith("é")).toBe(true);
  });

  it("refuses YAML aliases rather than expanding them", () => {
    const laughs = ["a: &a [x, x, x, x, x, x, x, x]", "b: &b [*a, *a, *a, *a, *a, *a, *a, *a]", "c: [*b, *b, *b, *b, *b, *b, *b, *b]"];
    expect(parseSkillFile(file(`name: x\ndescription: d\n${laughs.join("\n")}`)).ok).toBe(false);
  });

  it("accepts CRLF line endings and a byte-order mark", () => {
    const r = parseSkillFile("\uFEFF---\r\nname: x\r\ndescription: d\r\n---\r\nBody\r\n");
    expect(r.ok && r.skill.body).toBe("Body");
  });
});
