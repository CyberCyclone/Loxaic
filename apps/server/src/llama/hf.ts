import { getHfToken } from "./settings.ts";

/**
 * A thin client for the HuggingFace Hub API — search, a repo's details and
 * file list, its model card. Plain `fetch`, no SDK, the same shape as
 * `github/client.ts`.
 *
 * The base URL is `HF_ENDPOINT` (the variable HuggingFace's own tools read),
 * read at call time so the e2e harness and the tests can point it at a mock.
 * The optional token is sent only to that host, and scrubbed from every error.
 */

const TIMEOUT_MS = 15_000;
const CARD_MAX_BYTES = 64 * 1024;
/** The largest API answer read whole. A repo's recursive file tree is the
 * biggest thing asked for, and even a repo with thousands of files is well
 * under this. */
const JSON_MAX_BYTES = 32 * 1024 * 1024;

export function hfEndpoint(): string {
  return (process.env.HF_ENDPOINT ?? "https://huggingface.co").replace(/\/+$/, "");
}

export class HfError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "HfError";
    this.status = status;
  }
}

function redact(text: string): string {
  const token = getHfToken();
  return token ? text.split(token).join("[redacted]") : text;
}

export function hfHeaders(): Record<string, string> {
  const token = getHfToken();
  return { "User-Agent": "loxaic", ...(token ? { Authorization: `Bearer ${token}` } : {}) };
}

/**
 * One request, with a deadline that covers the *body*, not only the headers,
 * and a byte cap enforced while reading rather than after. `res.text()` would
 * buffer whatever the server sent before any cap applied, and a trickled body
 * would run past the abort timer once headers had arrived — on the process
 * that serves every other user's stream.
 */
async function hfFetchText(pathname: string, maxBytes: number): Promise<{ status: number; text: string; truncated: boolean }> {
  const controller = new AbortController();
  const timer = setTimeout(() => { controller.abort(); }, TIMEOUT_MS);
  try {
    const res = await fetch(`${hfEndpoint()}${pathname}`, { signal: controller.signal, headers: hfHeaders() });
    const { text, truncated } = await readCapped(res, maxBytes);
    return { status: res.status, text, truncated };
  } catch (err) {
    throw new HfError(redact(`Could not reach HuggingFace: ${err instanceof Error ? err.message : String(err)}`), 0);
  } finally {
    clearTimeout(timer);
  }
}

async function readCapped(res: Response, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
  if (!res.body) return { text: "", truncated: false };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (total + value.length > maxBytes) {
      chunks.push(value.subarray(0, maxBytes - total));
      truncated = true;
      await reader.cancel();
      break;
    }
    chunks.push(value);
    total += value.length;
  }
  return { text: Buffer.concat(chunks).toString("utf8"), truncated };
}

async function hfJson<T>(pathname: string): Promise<T> {
  const { status, text, truncated } = await hfFetchText(pathname, JSON_MAX_BYTES);
  if (status < 200 || status >= 300) {
    throw new HfError(redact(`HuggingFace answered HTTP ${String(status)}: ${text.slice(0, 300)}`), status);
  }
  if (truncated) throw new HfError("HuggingFace's answer was too large to read", 502);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new HfError("HuggingFace's answer was not JSON", 502);
  }
}

// ── Validation ──────────────────────────────────────────────────────────────

/** `owner/name`, as HuggingFace allows them. Everything that becomes a path on
 * disk or a preset section passes through here. */
export function isRepoId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}\/[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(value) && !value.includes("..");
}

// ── Search ──────────────────────────────────────────────────────────────────

export type HfSort = "downloads" | "likes" | "trending" | "recent";

interface RawModel {
  id: string;
  author?: string;
  downloads?: number;
  downloadsAllTime?: number;
  likes?: number;
  trendingScore?: number;
  createdAt?: string;
  lastModified?: string;
  gated?: boolean | "auto" | "manual";
  pipeline_tag?: string;
  tags?: string[];
  cardData?: { license?: string; base_model?: string | string[]; language?: string | string[] };
  gguf?: { total?: number; architecture?: string; context_length?: number };
  sha?: string;
}

export interface HfModelSummary {
  repo: string;
  publisher: string;
  name: string;
  downloads: number | null;
  downloadsAllTime: number | null;
  likes: number | null;
  trendingScore: number | null;
  createdAt: string | null;
  lastModified: string | null;
  license: string | null;
  pipelineTag: string | null;
  vision: boolean;
  gated: boolean;
  /** Parameter count, from the GGUF metadata HuggingFace indexes. */
  params: number | null;
  architecture: string | null;
  contextLength: number | null;
  tags: string[];
}

const EXPAND = [
  "author", "downloads", "downloadsAllTime", "likes", "trendingScore", "createdAt", "lastModified",
  "gated", "pipeline_tag", "tags", "cardData", "gguf", "sha",
];

/** Pipelines that are not a chat model. A search does not filter on
 * `pipeline_tag` (the API ANDs repeated values, so "text or vision" cannot be
 * asked for), so these are dropped afterwards. */
const NOT_CHAT = new Set([
  "text-to-image", "image-to-image", "feature-extraction", "sentence-similarity", "text-to-speech",
  "automatic-speech-recognition", "text-to-video", "image-to-video", "audio-to-audio", "text-classification",
  "token-classification", "fill-mask", "zero-shot-classification", "image-classification", "text-ranking",
]);

function first(v: string | string[] | undefined): string | null {
  if (Array.isArray(v)) return v[0] ?? null;
  return v ?? null;
}

export function summarize(m: RawModel): HfModelSummary {
  const [publisher, ...rest] = m.id.split("/");
  const tags = Array.isArray(m.tags) ? m.tags.filter((t) => typeof t === "string").slice(0, 40) : [];
  const license = m.cardData?.license ?? tags.find((t) => t.startsWith("license:"))?.slice("license:".length) ?? null;
  return {
    repo: m.id,
    publisher: m.author ?? publisher,
    name: rest.join("/"),
    downloads: m.downloads ?? null,
    downloadsAllTime: m.downloadsAllTime ?? null,
    likes: m.likes ?? null,
    trendingScore: m.trendingScore ?? null,
    createdAt: m.createdAt ?? null,
    lastModified: m.lastModified ?? null,
    license,
    pipelineTag: m.pipeline_tag ?? null,
    vision: m.pipeline_tag === "image-text-to-text",
    gated: Boolean(m.gated),
    params: typeof m.gguf?.total === "number" ? m.gguf.total : null,
    architecture: m.gguf?.architecture ?? null,
    contextLength: typeof m.gguf?.context_length === "number" ? m.gguf.context_length : null,
    tags,
  };
}

export interface SearchInput {
  q?: string;
  author?: string;
  sort?: HfSort;
  vision?: boolean;
  limit?: number;
}

const SORT_FIELD: Record<HfSort, string> = {
  downloads: "downloads",
  likes: "likes",
  trending: "trendingScore",
  recent: "lastModified",
};

/**
 * Search GGUF repos by model name and/or publisher. `publisher/name` typed
 * into the query is split into both, so "unsloth/qwen" finds unsloth's Qwen
 * repos; a bare word already matches publishers too, because HuggingFace's
 * `search` covers the whole repo id.
 */
export async function searchModels(input: SearchInput): Promise<HfModelSummary[]> {
  let q = (input.q ?? "").trim().slice(0, 100);
  let author = (input.author ?? "").trim().slice(0, 96);
  const slash = q.indexOf("/");
  if (!author && slash > 0) {
    author = q.slice(0, slash);
    q = q.slice(slash + 1);
  }
  const params = new URLSearchParams({ filter: "gguf", direction: "-1" });
  params.set("sort", SORT_FIELD[input.sort ?? "downloads"]);
  params.set("limit", String(Math.min(Math.max(input.limit ?? 40, 1), 100)));
  if (q) params.set("search", q);
  if (author && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(author)) params.set("author", author);
  if (input.vision) params.set("pipeline_tag", "image-text-to-text");
  for (const e of EXPAND) params.append("expand[]", e);
  const raw = await hfJson<RawModel[]>(`/api/models?${params.toString()}`);
  return raw.filter((m) => typeof m.id === "string" && !NOT_CHAT.has(m.pipeline_tag ?? "")).map(summarize);
}

// ── One repo ────────────────────────────────────────────────────────────────

interface RawTreeEntry {
  type: string;
  path: string;
  size?: number;
  lfs?: { oid?: string; size?: number };
}

export interface QuantFile {
  path: string;
  size: number;
  sha256: string | null;
}

export interface QuantOption {
  quant: string;
  files: QuantFile[];
  sizeBytes: number;
}

export interface RepoFiles {
  revision: string;
  quants: QuantOption[];
  /** Vision projectors, smallest first. */
  mmproj: QuantFile[];
}

function basename(p: string): string {
  return p.split("/").at(-1) ?? p;
}

const SPLIT_RE = /-(\d{5})-of-(\d{5})\.gguf$/i;
const QUANT_RE = /(?:^|[-_.])((?:UD-)?(?:I?Q\d(?:_[A-Z0-9]+)*|BF16|F16|F32|MXFP4(?:_MOE)?|TQ\d_\d))$/i;

/** The quant name a GGUF file belongs to, from its filename, or its directory
 * for repos that keep one quant per folder. */
export function quantOf(filePath: string): string {
  const parts = filePath.split("/");
  const base = (parts.at(-1) ?? "").replace(SPLIT_RE, "").replace(/\.gguf$/i, "");
  const fromBase = QUANT_RE.exec(base)?.[1];
  if (fromBase) return fromBase.toUpperCase().replace(/^UD-/, "UD-");
  const dir = parts.at(-2);
  const fromDir = dir ? QUANT_RE.exec(dir)?.[1] : undefined;
  if (fromDir) return fromDir.toUpperCase();
  return base.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 64) || "model";
}

/** Group a repo's GGUF files into downloadable quants. A split model is one
 * quant made of every part; one missing a part is not offered. */
export function groupQuants(entries: RawTreeEntry[]): { quants: QuantOption[]; mmproj: QuantFile[] } {
  // A GGUF with no LFS object id has no checksum to verify against, and a
  // download this server will mmap and run must never be accepted on length
  // alone — so such a file is simply not offered. On HuggingFace every GGUF is
  // an LFS object; one that is not is a repo worth being suspicious of anyway.
  const ggufs = entries.filter(
    (e) => e.type === "file" && /\.gguf$/i.test(e.path) && typeof e.lfs?.oid === "string" && /^[0-9a-f]{64}$/.test(e.lfs.oid),
  );
  const toFile = (e: RawTreeEntry): QuantFile => ({
    path: e.path,
    size: e.lfs?.size ?? e.size ?? 0,
    sha256: e.lfs?.oid ?? null,
  });
  const mmproj = ggufs.filter((e) => /^mmproj/i.test(basename(e.path))).map(toFile).sort((a, b) => a.size - b.size);
  const groups = new Map<string, QuantFile[]>();
  for (const e of ggufs) {
    if (/^mmproj/i.test(basename(e.path))) continue;
    const q = quantOf(e.path);
    groups.set(q, [...(groups.get(q) ?? []), toFile(e)]);
  }
  const quants: QuantOption[] = [];
  for (const [quant, files] of groups) {
    files.sort((a, b) => a.path.localeCompare(b.path));
    const split = files.map((f) => SPLIT_RE.exec(f.path)).filter(Boolean);
    if (split.length > 0) {
      const total = Number(split[0]?.[2]);
      // All parts present, and nothing else under the same quant name.
      if (split.length !== files.length || files.length !== total) continue;
    } else if (files.length > 1) {
      // Two unrelated files resolving to one quant name: offer each by path.
      for (const f of files) {
        const name = basename(f.path).replace(/\.gguf$/i, "").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 64);
        quants.push({ quant: name, files: [f], sizeBytes: f.size });
      }
      continue;
    }
    quants.push({ quant, files, sizeBytes: files.reduce((n, f) => n + f.size, 0) });
  }
  quants.sort((a, b) => a.sizeBytes - b.sizeBytes);
  return { quants, mmproj };
}

export async function repoFiles(repo: string): Promise<RepoFiles> {
  if (!isRepoId(repo)) throw new HfError("That is not a HuggingFace repository name", 400);
  const info = await hfJson<RawModel>(`/api/models/${repo}?expand[]=sha`);
  const revision = info.sha;
  if (!revision || !/^[0-9a-f]{40}$/.test(revision)) throw new HfError("HuggingFace did not say which revision to download", 502);
  // Pinned to the revision just read, so the files and their checksums
  // describe one commit even if the repo changes while we look.
  const tree = await hfJson<RawTreeEntry[]>(`/api/models/${repo}/tree/${revision}?recursive=true`);
  return { revision, ...groupQuants(tree) };
}

export interface RepoDetails {
  summary: HfModelSummary;
  baseModel: string | null;
  languages: string[];
  /** The model card's markdown, front matter removed, capped. Untrusted: the
   * client renders it as text. */
  card: string | null;
  cardTruncated: boolean;
  files: RepoFiles;
}

function stripFrontMatter(text: string): string {
  if (!text.startsWith("---")) return text;
  const end = text.indexOf("\n---", 3);
  return end < 0 ? text : text.slice(end + 4).replace(/^\s+/, "");
}

export async function repoDetails(repo: string): Promise<RepoDetails> {
  if (!isRepoId(repo)) throw new HfError("That is not a HuggingFace repository name", 400);
  const params = new URLSearchParams();
  for (const e of EXPAND) params.append("expand[]", e);
  const raw = await hfJson<RawModel>(`/api/models/${repo}?${params.toString()}`);
  const files = await repoFiles(repo);
  let card: string | null = null;
  let cardTruncated = false;
  try {
    // Read to the cap and no further: the card is a stranger's file of any size.
    const res = await hfFetchText(`/${repo}/resolve/${files.revision}/README.md`, CARD_MAX_BYTES);
    if (res.status === 200) {
      card = stripFrontMatter(res.text);
      cardTruncated = res.truncated;
    }
  } catch {
    // A missing card is not a failed lookup.
  }
  const langs = raw.cardData?.language;
  return {
    summary: summarize(raw),
    baseModel: first(raw.cardData?.base_model),
    languages: (Array.isArray(langs) ? langs : langs ? [langs] : []).slice(0, 20),
    card,
    cardTruncated,
    files,
  };
}

/** Where a file of a pinned revision downloads from. */
export function resolveUrl(repo: string, revision: string, filePath: string): string {
  return `${hfEndpoint()}/${repo}/resolve/${revision}/${filePath.split("/").map(encodeURIComponent).join("/")}`;
}

/** Explain an HTTP failure on a download in words an admin can act on. */
export function downloadErrorMessage(status: number, repo: string): string {
  if (status === 401 || status === 403) {
    return getHfToken()
      ? `HuggingFace refused the download. "${repo}" is gated: accept its terms on huggingface.co with the account the configured token belongs to, then retry.`
      : `"${repo}" is gated. Add a HuggingFace token under Local models > Settings, accept the model's terms on huggingface.co, then retry.`;
  }
  if (status === 404) return `HuggingFace no longer has this file in "${repo}". Delete the download and pick the model again.`;
  return `HuggingFace answered HTTP ${String(status)} for "${repo}".`;
}
