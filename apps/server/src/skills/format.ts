/**
 * The Agent Skills format (agentskills.io): a `SKILL.md` whose YAML
 * frontmatter carries `name` and `description`, followed by markdown
 * instructions. One parser for every skill Loxaic loads — the built-ins, a
 * person's own, a workspace's — so all three are held to one rule.
 *
 * Lenient where the spec's client guide says to be: skills written for other
 * tools often carry YAML their parsers happened to accept (an unquoted value
 * with a colon in it), and a name that breaks the format's rules still loads,
 * with a warning, when it can be typed after a slash. What cannot load is a
 * file with no description (there would be nothing to tell the model) or one
 * whose frontmatter cannot be read at all.
 *
 * The input may be a stranger's file (a workspace's skills), so the
 * frontmatter is capped before YAML sees it and aliases are refused: a
 * billion-laughs document must cost nothing.
 */
import { parse as parseYaml } from "yaml";
import { isValidSkillName, SKILL_NAME_MAX } from "@loxaic/types";

/** The format's own limit on a description. */
export const MAX_SKILL_DESCRIPTION = 1024;
/** The most of a body that is ever given to the model. The format advises
 * under 500 lines; this only stops a pathological file. */
export const MAX_SKILL_BODY_BYTES = 256 * 1024;
/** Frontmatter is a handful of short fields; anything this long is not one. */
const MAX_FRONTMATTER_CHARS = 16 * 1024;

export interface ParsedSkill {
  name: string;
  description: string;
  /** The markdown after the frontmatter, trimmed. */
  body: string;
  /** False when the file sets `disable-model-invocation: true`: only a person
   * may run it, by typing its name. */
  modelInvocable: boolean;
  /** `argument-hint`, shown muted after the name in the palette. */
  argHint?: string;
  /** What was wrong but forgiven, for whoever wants to show it. */
  warnings: string[];
}

export type ParseResult = { ok: true; skill: ParsedSkill } | { ok: false; error: string };

/**
 * Reads one `SKILL.md`. `dirName`, when the file was found in a skill
 * directory, is the name it should carry — the format requires the two to
 * match, and a file with no name of its own takes it.
 */
export function parseSkillFile(raw: string, opts: { dirName?: string } = {}): ParseResult {
  const text = raw.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const split = splitFrontmatter(text);
  if (!split) return { ok: false, error: "SKILL.md must start with YAML frontmatter between --- lines" };
  if (split.frontmatter.length > MAX_FRONTMATTER_CHARS) {
    return { ok: false, error: "the frontmatter is too long" };
  }
  const fields = readFrontmatter(split.frontmatter);
  if (!fields) return { ok: false, error: "the frontmatter is not valid YAML" };

  const warnings: string[] = [];
  const rawName = typeof fields.name === "string" ? fields.name.trim() : "";
  let name = rawName !== "" ? rawName : (opts.dirName ?? "");
  if (!rawName && opts.dirName) warnings.push(`no name; using its directory's, "${opts.dirName}"`);
  if (!isValidSkillName(name)) {
    // Forgiven only as far as it can still be typed after a slash and named
    // in a tool call: lowercase, letters, digits and hyphens.
    const lowered = name.toLowerCase();
    if (!isUsableSkillName(lowered)) {
      return { ok: false, error: name ? `"${name}" is not a usable skill name` : "the skill has no name" };
    }
    warnings.push(`"${name}" does not follow the format's naming rules`);
    name = lowered;
  }
  if (opts.dirName && opts.dirName !== name) {
    warnings.push(`its name, "${name}", does not match its directory, "${opts.dirName}"`);
  }

  let description = typeof fields.description === "string" ? fields.description.trim() : "";
  if (!description) return { ok: false, error: `"${name}" has no description` };
  // One line in the catalog the model reads: the format allows a folded
  // block, whose line breaks mean nothing.
  description = description.replace(/\s+/g, " ");
  if (description.length > MAX_SKILL_DESCRIPTION) {
    warnings.push(`its description is longer than ${String(MAX_SKILL_DESCRIPTION)} characters and was cut`);
    description = cutChars(description, MAX_SKILL_DESCRIPTION);
  }

  let body = split.body.trim();
  if (Buffer.byteLength(body, "utf8") > MAX_SKILL_BODY_BYTES) {
    warnings.push(`its instructions are longer than ${String(MAX_SKILL_BODY_BYTES / 1024)} KiB and were cut`);
    body = cutBytes(body, MAX_SKILL_BODY_BYTES);
  }

  const argHint = typeof fields["argument-hint"] === "string" ? fields["argument-hint"].trim() : "";
  return {
    ok: true,
    skill: {
      name,
      description,
      body,
      modelInvocable: fields["disable-model-invocation"] !== true,
      ...(argHint ? { argHint: cutChars(argHint, 80) } : {}),
      warnings,
    },
  };
}

/** The frontmatter between the opening `---` line and the next one, and
 * everything after it. Null when the file does not open with one. */
function splitFrontmatter(text: string): { frontmatter: string; body: string } | null {
  if (!text.startsWith("---\n") && text !== "---") return null;
  const rest = text.slice(4);
  // The closing line may be the file's last, with no newline after it.
  const m = /^---[ \t]*$/m.exec(rest);
  if (!m) return null;
  return { frontmatter: rest.slice(0, m.index), body: rest.slice(m.index + m[0].length) };
}

/** The frontmatter's top-level fields, or null when it cannot be read even
 * after the usual repair. */
function readFrontmatter(frontmatter: string): Record<string, unknown> | null {
  for (const attempt of [frontmatter, quoteColonValues(frontmatter)]) {
    try {
      const value: unknown = parseYaml(attempt, { maxAliasCount: 0, uniqueKeys: false });
      if (value == null) return {};
      if (typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
      return null;
    } catch {
      // Try the repaired text, then give up.
    }
  }
  return null;
}

/**
 * The commonest invalid YAML in skills written for other tools: an unquoted
 * value containing ": " (`description: Use this when: the user asks`). Each
 * top-level `key: value` line whose value is plain and contains one is quoted.
 * Lines that are indented, already quoted, or start a block are left alone.
 */
export function quoteColonValues(frontmatter: string): string {
  return frontmatter
    .split("\n")
    .map((line) => {
      const m = /^([A-Za-z0-9_-]+):[ \t]+(.+)$/.exec(line);
      if (!m) return line;
      const value = m[2].trimEnd();
      if (!value.includes(": ") || /^["'|>[{&*!]/.test(value)) return line;
      return `${m[1]}: "${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
    })
    .join("\n");
}

/** At most `max` characters, never splitting a surrogate pair. */
function cutChars(s: string, max: number): string {
  return Array.from(s).slice(0, max).join("");
}

/** At most `max` UTF-8 bytes, cut on a character boundary. */
function cutBytes(s: string, max: number): string {
  const buf = Buffer.from(s, "utf8").subarray(0, max);
  // A cut inside a multi-byte sequence decodes to U+FFFD; drop it.
  return buf.toString("utf8").replace(/\uFFFD+$/, "");
}

/**
 * Whether a lowercased name can be a skill's at all: what a file whose name
 * breaks the format's rules is still forgiven as (letters, digits and
 * hyphens, at most twice the format's length), and so the widest set a
 * lookup by name can ever match.
 */
export function isUsableSkillName(name: string): boolean {
  return name.length <= SKILL_NAME_MAX * 2 && /^[a-z0-9][a-z0-9-]*$/.test(name);
}
