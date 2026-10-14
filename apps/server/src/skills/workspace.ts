/**
 * Skills in the workspace's own repository (#283), found where Claude Code,
 * OpenCode and Codex look for them — see AGENTS.md, "Skills".
 *
 * Only the catalog is stored (`conversations.repo_skills`): each skill's name,
 * description and directory, and a hash of what was read. The instructions
 * are read from the workspace when a skill is used, so a skill always runs as
 * the checkout has it, and its bundled files (scripts, references) are where
 * the model can read them.
 *
 * Read the way the project's AGENTS.md is (agent/instructions.ts): through the
 * executor for a direct local folder, inside a container or a GitHub checkout
 * only while it is live, through GitHub's contents API before a clone exists,
 * and never by starting something just to look. Every exec read is confined
 * to the workspace by real path, so a skill directory linked out of the
 * repository reads nothing.
 *
 * A workspace's skill is as untrusted as its AGENTS.md: the repository may be
 * a stranger's. Its instructions are framed as the project's, and they cannot
 * change what Loxaic asks before running.
 */
import { createHash } from "node:crypto";
import { posix } from "node:path";
import { db, eq } from "@loxaic/db";
import { conversations } from "@loxaic/db/schema";
import type { Workspace } from "@loxaic/types";
import { getOwnerToken } from "../github/connection.ts";
import { getFileText, listDirectory } from "../github/client.ts";
import {
  CKSUM_OF_R,
  R_INSIDE_ROOT,
  REAL_ROOT,
  readChunked,
  retryDelayMs,
  workspaceExec,
  type Exec,
} from "../agent/instructions.ts";
import { getConversationSandbox } from "../agent/sandbox-manager.ts";
import { MAX_SKILL_BODY_BYTES, parseSkillFile } from "./format.ts";

/** Where a repository's skills live, most specific to this client last; the
 * first directory to define a name wins. `.agents/skills` is the cross-client
 * convention the Agent Skills guide recommends; the others are where Claude
 * Code and OpenCode install theirs. */
export const SKILL_ROOTS = [".agents/skills", ".claude/skills", ".opencode/skills", ".opencode/skill"] as const;
/** Every skill's name and description is in the model's list on every
 * request, so a repository's are capped. */
export const MAX_REPO_SKILLS = 100;
/** Enough of a SKILL.md for its frontmatter and a hash; the instructions are
 * read again in full when used. */
const SCAN_BYTES = 64 * 1024;

export interface RepoSkill {
  name: string;
  description: string;
  /** Its directory, relative to the workspace root. */
  dir: string;
  modelInvocable: boolean;
  argHint?: string;
  /** A hash of what was read, so a change the model must hear of is told
   * apart from a file that was merely touched. */
  hash: string;
}

/** What `conversations.repo_skills` holds. */
export type RepoSkillScan =
  | {
      status: "scanned";
      skills: RepoSkill[];
      /** `cksum` of each SKILL.md by directory, when read through an exec —
       * how a later run learns, cheaply, that something changed. Null when
       * read through GitHub's API, which the first exec then replaces. */
      cksums: Record<string, string> | null;
      scannedAt: string;
      /** What could not be loaded, and why. */
      problems?: string[];
    }
  | { status: "unavailable"; attempts: number; retryAfter: string };

export function coerceScan(raw: unknown): RepoSkillScan | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (r.status === "unavailable" && typeof r.attempts === "number" && typeof r.retryAfter === "string") {
    return { status: "unavailable", attempts: r.attempts, retryAfter: r.retryAfter };
  }
  if (r.status !== "scanned" || !Array.isArray(r.skills)) return null;
  const skills = r.skills.filter((s): s is RepoSkill => {
    const x = s as Partial<RepoSkill> | null;
    return !!x && typeof x.name === "string" && typeof x.description === "string" && typeof x.dir === "string" && typeof x.hash === "string";
  });
  const cksums = r.cksums && typeof r.cksums === "object" ? (r.cksums as Record<string, string>) : null;
  return { status: "scanned", skills, cksums, scannedAt: typeof r.scannedAt === "string" ? r.scannedAt : "" };
}

/** The skills a conversation's scan found, for the catalog. */
export async function storedRepoSkills(conversationId: string): Promise<RepoSkill[]> {
  const row = await db.query.conversations.findFirst({
    where: eq(conversations.id, conversationId),
    columns: { repoSkills: true },
  });
  const scan = coerceScan(row?.repoSkills);
  return scan?.status === "scanned" ? scan.skills : [];
}

// ── Scanning ──────────────────────────────────────────────

interface Candidate { dir: string; size: number; cksum: string }

/** Every `<root>/<name>/SKILL.md` that is a file inside the workspace by real
 * path, in `SKILL_ROOTS` order, with its size and `cksum`, in one exec.
 * NUL-separated: directory names are the repository's to choose. */
export async function listSkillFiles(exec: Exec): Promise<Candidate[]> {
  const res = await exec([
    "bash", "-c",
    REAL_ROOT +
      'n=0; for base in "$@"; do [ -d "$base" ] || continue; for d in "$base"/*/; do ' +
      '[ "$n" -ge ' + String(MAX_REPO_SKILLS * 2) + ' ] && break 2; ' +
      'p="${d%/}/SKILL.md"; [ -f "$p" ] || continue; r=$(realpath -- "$p" 2>/dev/null) || continue; ' +
      `${R_INSIDE_ROOT} || continue; n=$((n+1)); ` +
      `printf "%s\\0%s\\0%s\\0" "\${d%/}" "$(wc -c < "$r" | tr -d " ")" "${CKSUM_OF_R}"; ` +
      "done; done",
    "_", ...SKILL_ROOTS,
  ]);
  if (res.exitCode !== 0) throw new Error(res.stderr.trim() || "listing the workspace's skills failed");
  const fields = res.stdout.split("\0");
  const out: Candidate[] = [];
  for (let i = 0; i + 2 < fields.length; i += 3) {
    if (fields[i]) out.push({ dir: fields[i], size: Number(fields[i + 1]) || 0, cksum: fields[i + 2].trim() });
  }
  return out;
}

const hashOf = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16);

/** Parsed skills from read files, first definition of a name winning, capped. */
export function collectSkills(files: { dir: string; text: string }[]): { skills: RepoSkill[]; problems: string[] } {
  const skills: RepoSkill[] = [];
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const f of files) {
    const parsed = parseSkillFile(f.text, { dirName: posix.basename(f.dir) });
    if (!parsed.ok) {
      problems.push(`${f.dir}: ${parsed.error}`);
      continue;
    }
    const s = parsed.skill;
    if (seen.has(s.name)) {
      problems.push(`${f.dir}: "${s.name}" is already defined earlier, so this one is not used`);
      continue;
    }
    if (skills.length >= MAX_REPO_SKILLS) {
      problems.push(`${f.dir}: past the limit of ${String(MAX_REPO_SKILLS)} skills`);
      continue;
    }
    seen.add(s.name);
    skills.push({
      name: s.name,
      description: s.description,
      dir: f.dir,
      modelInvocable: s.modelInvocable,
      ...(s.argHint ? { argHint: s.argHint } : {}),
      hash: hashOf(f.text),
    });
  }
  return { skills, problems };
}

async function scanWithExec(exec: Exec, candidates?: Candidate[]): Promise<Extract<RepoSkillScan, { status: "scanned" }>> {
  const found = candidates ?? (await listSkillFiles(exec));
  const files: { dir: string; text: string }[] = [];
  for (const c of found) {
    const read = await readChunked(exec, `${c.dir}/SKILL.md`, c.size, SCAN_BYTES);
    files.push({ dir: c.dir, text: read.text });
  }
  const { skills, problems } = collectSkills(files);
  return {
    status: "scanned",
    skills,
    cksums: Object.fromEntries(found.map((c) => [c.dir, c.cksum])),
    scannedAt: new Date().toISOString(),
    ...(problems.length ? { problems } : {}),
  };
}

async function scanWithGithub(
  workspace: Extract<Workspace, { kind: "github" }>,
  token: string,
  signal?: AbortSignal,
): Promise<Extract<RepoSkillScan, { status: "scanned" }>> {
  const [owner, repo] = workspace.repo.split("/");
  const files: { dir: string; text: string }[] = [];
  let looked = 0;
  for (const root of SKILL_ROOTS) {
    const entries = await listDirectory(token, owner, repo, root, workspace.baseBranch, signal);
    for (const e of entries ?? []) {
      if (e.type !== "dir" || looked >= MAX_REPO_SKILLS * 2) continue;
      looked++;
      const dir = `${root}/${e.name}`;
      const got = await getFileText(token, owner, repo, `${dir}/SKILL.md`, workspace.baseBranch, SCAN_BYTES, signal);
      if (got) files.push({ dir, text: got.text });
    }
  }
  const { skills, problems } = collectSkills(files);
  return { status: "scanned", skills, cksums: null, scannedAt: new Date().toISOString(), ...(problems.length ? { problems } : {}) };
}

function sameCksums(a: Record<string, string> | null, b: Candidate[]): boolean {
  if (!a) return false;
  const keys = Object.keys(a);
  return keys.length === b.length && b.every((c) => a[c.dir] === c.cksum);
}

/**
 * Before a run in a github or local workspace: scan the repository's skills
 * if nobody has, or again when a cheap `cksum` check says something changed.
 * A change reaches the model through the conversation's skill catalog
 * (skills/session.ts), as a notice. Never throws; a scan that cannot finish is
 * recorded as unavailable with when to try again, and nothing is started just
 * to look.
 */
export async function refreshRepoSkills(input: {
  convId: string;
  ownerId: string;
  workspace: Workspace;
  signal?: AbortSignal;
  now?: () => number;
}): Promise<void> {
  const { convId, workspace, signal } = input;
  if (workspace.kind === "scratch") return;
  const now = input.now ?? Date.now;
  try {
    const row = await db.query.conversations.findFirst({
      where: eq(conversations.id, convId),
      columns: { repoSkills: true },
    });
    const stored = coerceScan(row?.repoSkills);
    if (stored?.status === "unavailable" && now() < Date.parse(stored.retryAfter)) return;
    const exec = await workspaceExec(workspace, convId, signal);

    let next: RepoSkillScan | null = null;
    try {
      if (exec) {
        const candidates = await listSkillFiles(exec);
        if (stored?.status === "scanned" && sameCksums(stored.cksums, candidates)) return;
        next = await scanWithExec(exec, candidates);
      } else if (stored?.status === "scanned") {
        // Nothing to look with that is already running: the next run with one
        // catches up.
        return;
      } else if (workspace.kind === "github") {
        const token = await getOwnerToken(input.ownerId);
        if (!token) return;
        next = await scanWithGithub(workspace, token, signal);
      } else {
        return;
      }
    } catch (err) {
      if (signal?.aborted) return;
      console.warn(`scanning the skills of ${convId} failed: ${(err as Error).message}`);
      const attempts = (stored?.status === "unavailable" ? stored.attempts : 0) + 1;
      next = { status: "unavailable", attempts, retryAfter: new Date(now() + retryDelayMs(attempts)).toISOString() };
      // An earlier scan stays in use rather than being lost to one failure.
      if (stored?.status === "scanned") return;
    }
    if (signal?.aborted) return;
    await db.update(conversations).set({ repoSkills: next }).where(eq(conversations.id, convId));
  } catch (err) {
    console.warn(`refreshing the skills of ${convId} failed: ${(err as Error).message}`);
  }
}

// ── Using one ─────────────────────────────────────────────

/** At most this many of a skill's other files are listed to the model. */
const MAX_LISTED_FILES = 50;

/**
 * A workspace skill's instructions and its other files, read from the
 * workspace now. Using a skill is an explicit act, so this may start the
 * conversation's sandbox (a GitHub clone, a paused container) when nothing is
 * running to read with, as `fs_read` does.
 */
export async function readWorkspaceSkill(input: {
  /** The conversation whose workspace it is (a sub-agent's parent's). */
  convId: string;
  /** Who is running it, for starting the sandbox. */
  userId: string;
  workspace: Workspace;
  dir: string;
  signal?: AbortSignal;
}): Promise<{ ok: true; body: string; files: string[] } | { ok: false; error: string }> {
  const { workspace, dir } = input;
  if (workspace.kind === "scratch") return { ok: false, error: "This conversation has no workspace to read the skill from." };
  try {
    let exec = await workspaceExec(workspace, input.convId, input.signal);
    if (!exec) {
      const handle = await getConversationSandbox(input.userId, input.convId);
      exec = (command) => handle.exec(command, { ...(input.signal ? { signal: input.signal } : {}), timeoutMs: 10_000 });
    }
    const size = await exec([
      "bash", "-c",
      REAL_ROOT + 'r=$(realpath -- "$1/SKILL.md" 2>/dev/null) || exit 3; ' +
        `${R_INSIDE_ROOT} || exit 4; [ -f "$r" ] || exit 3; wc -c < "$r" | tr -d " "`,
      "_", dir,
    ]);
    if (size.exitCode === 4) return { ok: false, error: `${dir}/SKILL.md leads outside the workspace.` };
    if (size.exitCode !== 0) return { ok: false, error: `${dir}/SKILL.md is no longer in the workspace.` };
    const read = await readChunked(exec, `${dir}/SKILL.md`, Number(size.stdout.trim()) || 0, MAX_SKILL_BODY_BYTES + SCAN_BYTES);
    const parsed = parseSkillFile(read.text, { dirName: posix.basename(dir) });
    if (!parsed.ok) return { ok: false, error: `${dir}/SKILL.md cannot be read as a skill: ${parsed.error}` };
    const listed = await exec([
      "bash", "-c",
      // Files only, never followed through a link, and nothing past the cap.
      'find "$1" -type f ! -path "$1/SKILL.md" 2>/dev/null | head -n ' + String(MAX_LISTED_FILES + 1),
      "_", dir,
    ]);
    const files = listed.exitCode === 0 ? listed.stdout.split("\n").filter(Boolean) : [];
    return { ok: true, body: parsed.skill.body, files };
  } catch (err) {
    return { ok: false, error: `Could not read the skill from the workspace: ${(err as Error).message}` };
  }
}

export { MAX_LISTED_FILES };
