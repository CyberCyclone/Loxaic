import { db, eq } from "@loxaic/db";
import { inferenceProviders } from "@loxaic/db/schema";
import { DEFAULT_PROVIDER_ID, isProviderSlug, parseModelRef } from "@loxaic/types";
import { decryptApiKey, encryptApiKey, ProviderKeyUnreadableError } from "./provider-secrets.ts";

/**
 * Which backends this deployment can reach, and which model reference goes to
 * which one.
 *
 * The backend `INFERENCE_BASE_URL` names is **not** a row. It is synthesized
 * here at call time, so a deployment that never opens the providers screen
 * behaves exactly as it did before this module existed, and so an operator can
 * still move it by editing the environment. Everything else is an admin-added
 * row in `inference_providers`.
 *
 * Rows are read through a short-lived async cache rather than a boot-loaded
 * synchronous one like `settings.ts`'s. Nothing on this path has a synchronous
 * contract — the run starters, `streamCompletion` and the scheduler are all
 * async already — and a cluster shares one database, so a sync snapshot taken
 * at boot would leave one instance serving a provider another instance had
 * deleted. Resolution happens per *request*, not per run, which is what makes
 * "delete the provider to stop the spend" take effect on a run already in
 * flight rather than at the end of it.
 */

export type ProviderPreset = "openrouter" | "openai" | "anthropic";

export interface ResolvedProvider {
  /** `"default"` for the built-in backend, else the row's uuid. */
  id: string;
  /** Null for the built-in backend — its models are stored unqualified. */
  slug: string | null;
  name: string;
  preset: ProviderPreset | null;
  /** API base *including* the version segment: `${apiBase}/chat/completions`. */
  apiBase: string;
  /** `apiBase` with a trailing `/v1` removed — where llama.cpp's `/props` and
   * LM Studio's `/api/v0/models` live. Only probed for custom providers. */
  nativeRoot: string;
  apiKey: string | null;
  headers: Record<string, string>;
  maxConcurrentRuns: number | null;
  /** Upstream ids a user may pick, or null for "whatever it lists". */
  modelAllowlist: string[] | null;
  enabled: boolean;
  /** True for the synthesized built-in backend. The mock inference backend and
   * the `host_id` stamp apply to it and to nothing else. */
  isDefault: boolean;
}

export type ProviderRow = typeof inferenceProviders.$inferSelect;

/** A model reference that cannot be served: an unknown or deleted provider, a
 * disabled one, or a model its admin did not allow. Never a fallthrough to the
 * default backend — llama.cpp ignores the `model` field entirely, so a deleted
 * provider's reference would be answered by the local model with nothing
 * anywhere saying the request had gone somewhere else. */
export class ModelRefError extends Error {
  readonly code: "unknown_provider" | "provider_disabled" | "model_not_allowed";

  constructor(message: string, code: ModelRefError["code"]) {
    super(message);
    this.name = "ModelRefError";
    this.code = code;
  }
}

/** Bad input from an admin route — a malformed URL, a refused header. */
export class ProviderInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderInputError";
  }
}

// ── The built-in backend ─────────────────────────────────────────────────────

// Read at call time, not module load — the desktop supervisor sets this in the
// child's environment, and a module-scope read would freeze it before any
// caller could act. Same reason as `provider.ts`'s own closure.
const DEFAULT_BASE_URL = () => process.env.INFERENCE_BASE_URL ?? "http://localhost:4002";

export function defaultProvider(): ResolvedProvider {
  const root = DEFAULT_BASE_URL().replace(/\/+$/, "");
  return {
    id: DEFAULT_PROVIDER_ID,
    slug: null,
    name: "Built-in",
    preset: null,
    apiBase: `${root}/v1`,
    nativeRoot: root,
    apiKey: null,
    headers: {},
    maxConcurrentRuns: null,
    modelAllowlist: null,
    enabled: true,
    isDefault: true,
  };
}

// ── The row cache ────────────────────────────────────────────────────────────

const CACHE_TTL_MS = 5_000;
let cache: { at: number; rows: ProviderRow[] } | null = null;

/** Drop the cached rows. Called after every write in this process; other
 * instances pick the change up within CACHE_TTL_MS. */
export function invalidateProviderCache(): void {
  cache = null;
}

async function providerRows(): Promise<ProviderRow[]> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.rows;
  const rows = await db.select().from(inferenceProviders);
  cache = { at: Date.now(), rows };
  return rows;
}

function normalizeHeaders(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

function normalizeAllowlist(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  const out = raw.filter((v): v is string => typeof v === "string" && v.length > 0);
  // An empty array would mean "no models at all", which no admin means by it —
  // the UI writes null for "all models". Treat it as unset.
  return out.length > 0 ? out : null;
}

/**
 * Decrypt a row's key into the shape the rest of the server uses. The one
 * decrypt site outside this module's tests.
 */
export function resolveRow(row: ProviderRow): ResolvedProvider {
  let apiKey: string | null = null;
  if (row.encryptedApiKey) {
    try {
      apiKey = decryptApiKey(row.encryptedApiKey);
    } catch {
      throw new ProviderKeyUnreadableError(row.name);
    }
  }
  const apiBase = row.baseUrl.replace(/\/+$/, "");
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    preset: row.preset,
    apiBase,
    nativeRoot: apiBase.replace(/\/v1$/, ""),
    apiKey,
    headers: normalizeHeaders(row.headers),
    maxConcurrentRuns: row.maxConcurrentRuns,
    modelAllowlist: normalizeAllowlist(row.modelAllowlist),
    enabled: row.enabled,
    isDefault: false,
  };
}

/** Every provider that can currently serve a request, built-in first. The
 * order is what puts the built-in backend's models at the top of the picker,
 * which is what keeps a new user off a paid model by accident. */
export async function listEnabledProviders(): Promise<ResolvedProvider[]> {
  const rows = await providerRows();
  const resolved: ResolvedProvider[] = [defaultProvider()];
  for (const row of rows) {
    if (!row.enabled) continue;
    try {
      resolved.push(resolveRow(row));
    } catch {
      // An unreadable key is a provider that cannot answer anything. Skipping
      // it keeps the picker and the models route working for every other
      // provider; the admin screen reports the same row as broken.
    }
  }
  return resolved;
}

/** Provider rows as stored, for the admin routes. */
export async function listProviderRows(): Promise<ProviderRow[]> {
  return [...(await providerRows())].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
}

export async function getProviderRow(id: string): Promise<ProviderRow | null> {
  const rows = await providerRows();
  return rows.find((r) => r.id === id) ?? null;
}

export async function getProviderById(id: string): Promise<ResolvedProvider | null> {
  if (id === DEFAULT_PROVIDER_ID) return defaultProvider();
  const row = await getProviderRow(id);
  return row ? resolveRow(row) : null;
}

// ── Reference resolution ─────────────────────────────────────────────────────

export interface ResolvedModelRef {
  provider: ResolvedProvider;
  /** What goes on the wire as the request's `model` field. */
  upstreamModel: string;
}

/**
 * Where a stored model reference should be sent, and under what name.
 *
 * Throws rather than falling back for every failure an added provider can
 * have. The one thing that is *not* an error is a reference with no provider
 * prefix: that is every model this deployment had before providers existed,
 * and it goes to the built-in backend unchanged.
 */
export async function resolveModelRef(ref: string): Promise<ResolvedModelRef> {
  const { providerSlug, upstreamModel } = parseModelRef(ref);
  if (providerSlug === null) return { provider: defaultProvider(), upstreamModel };

  const rows = await providerRows();
  const row = rows.find((r) => r.slug === providerSlug);
  if (!row) {
    throw new ModelRefError(
      `This conversation's model came from a provider that is no longer configured ("${providerSlug}"). Pick another model.`,
      "unknown_provider",
    );
  }
  if (!row.enabled) {
    throw new ModelRefError(
      `The "${row.name}" provider is switched off. Pick another model, or ask an admin to turn it back on.`,
      "provider_disabled",
    );
  }
  const provider = resolveRow(row);
  if (provider.modelAllowlist && !provider.modelAllowlist.includes(upstreamModel)) {
    throw new ModelRefError(
      `"${upstreamModel}" is not among the models an admin allowed for "${row.name}". Pick another model.`,
      "model_not_allowed",
    );
  }
  return { provider, upstreamModel };
}

/**
 * Refuse a model reference before anything is written.
 *
 * Called by the run starters beside `assertAttachmentsOwned`, and for the same
 * reason: a request that cannot be served must fail before it has created a
 * conversation, a message row and a stream nobody can complete. The allowlist
 * in particular is only a spending limit if it is enforced here — hiding a
 * model in the picker is presentation.
 */
export async function assertModelUsable(ref: string): Promise<void> {
  await resolveModelRef(ref);
}

// ── Admin write path ─────────────────────────────────────────────────────────

const NAME_MAX = 60;
const HEADER_COUNT_MAX = 12;
const HEADER_VALUE_MAX = 2048;

/** Headers a caller may not set: ours to build (auth, content), or the
 * transport's to own. An admin who could set `authorization` here would
 * silently defeat the encrypted key column beside it. */
/**
 * Headers that *are* a credential under another name. `x-api-key` is how
 * Anthropic authenticates natively and `api-key` is Azure OpenAI's spelling, so
 * an admin filling in headers for either has an entirely plausible reason to
 * put a live key here — where it would be stored in the clear and returned to
 * every admin by the list route, beside an encrypted column that exists to
 * prevent exactly that. `redactSecrets` already treats header values as worth
 * scrubbing; this is the write path agreeing with it. Refused by name, with a
 * message that says where the key belongs.
 */
const CREDENTIAL_HEADERS = new Set(["x-api-key", "api-key", "proxy-authorization", "x-auth-token"]);

const FORBIDDEN_HEADERS = new Set([
  "authorization",
  "host",
  "content-length",
  "content-type",
  "transfer-encoding",
  "connection",
  "cookie",
]);

function isControl(ch: string): boolean {
  const code = ch.codePointAt(0) ?? 0;
  return code < 0x20 || code === 0x7f;
}

export function normalizeName(raw: unknown): string {
  if (typeof raw !== "string") throw new ProviderInputError("A provider needs a name");
  // Control characters strip rather than reject: the realistic source is a
  // paste, and the name is rendered as a group header in every client.
  // Filtered by code point rather than by a regex, which would need the
  // control characters written literally into this file.
  const name = Array.from(raw, (ch) => (isControl(ch) ? "" : ch)).join("").trim();
  if (!name) throw new ProviderInputError("A provider needs a name");
  if (name.length > NAME_MAX) throw new ProviderInputError(`A provider name is at most ${String(NAME_MAX)} characters`);
  return name;
}

/**
 * Normalize an admin-entered base URL into the API base a request is built on.
 *
 * Deliberately *not* behind the SSRF guard that `web_fetch` and http MCP
 * servers use. A llama.cpp host at 192.168.1.50 is the core case this feature
 * exists for, this is admin-only deployment configuration of the same kind as
 * `INFERENCE_BASE_URL`, and the address never reaches a non-admin — network
 * errors are rewritten without host:port before they reach a client.
 */
export function normalizeBaseUrl(raw: unknown): string {
  if (typeof raw !== "string" || !raw.trim()) throw new ProviderInputError("A provider needs a base URL");
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new ProviderInputError("That base URL is not a valid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ProviderInputError("A provider base URL must be http or https");
  }
  if (url.username || url.password) {
    // Credentials in the URL would be stored in the clear in `base_url` and
    // shown back to every admin, beside an encrypted column that exists to
    // stop exactly that.
    throw new ProviderInputError("Put the credential in the API key field, not in the URL");
  }
  url.hash = "";
  url.search = "";
  const path = url.pathname.replace(/\/+$/, "");
  // An empty path means the admin pasted an origin. Every OpenAI-compatible
  // backend serves the API under /v1 there (llama.cpp, LM Studio, vLLM,
  // Ollama), so appending it is what they meant; OpenRouter's /api/v1 and
  // anything else already-versioned is left exactly as typed.
  return `${url.origin}${path || "/v1"}`;
}

export function normalizeHeaderInput(raw: unknown): Record<string, string> | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) throw new ProviderInputError("Headers must be an object");
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > HEADER_COUNT_MAX) {
    throw new ProviderInputError(`At most ${String(HEADER_COUNT_MAX)} custom headers`);
  }
  const out: Record<string, string> = {};
  for (const [name, value] of entries) {
    if (typeof value !== "string") throw new ProviderInputError(`Header "${name}" must be a string`);
    if (!/^[A-Za-z0-9!#$%&'*+\-.^_`|~]+$/.test(name)) throw new ProviderInputError(`"${name}" is not a header name`);
    if (CREDENTIAL_HEADERS.has(name.toLowerCase())) {
      throw new ProviderInputError(
        `"${name}" carries a credential, and headers are stored unencrypted and shown to every admin. Put the key in the API key field instead — it is sent as a bearer token.`,
      );
    }
    if (FORBIDDEN_HEADERS.has(name.toLowerCase())) {
      throw new ProviderInputError(`Loxaic sets the "${name}" header itself`);
    }
    // A CR or LF in a value is header injection, not a typo.
    if (/[\r\n]/.test(value)) throw new ProviderInputError(`Header "${name}" may not contain a line break`);
    if (value.length > HEADER_VALUE_MAX) throw new ProviderInputError(`Header "${name}" is too long`);
    out[name] = value;
  }
  return Object.keys(out).length > 0 ? out : null;
}

export function normalizeAllowlistInput(raw: unknown): string[] | null {
  if (raw === null || raw === undefined) return null;
  if (!Array.isArray(raw)) throw new ProviderInputError("A model allowlist must be an array of model ids");
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v !== "string" || !v.trim()) throw new ProviderInputError("Every allowlisted model id must be a string");
    const id = v.trim();
    if (!out.includes(id)) out.push(id);
  }
  return out.length > 0 ? out : null;
}

export function normalizeMaxConcurrent(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1 || raw > 64) {
    throw new ProviderInputError("Concurrent runs must be a whole number between 1 and 64");
  }
  return raw;
}

function normalizePreset(raw: unknown): ProviderPreset | null {
  if (raw === null || raw === undefined) return null;
  if (raw === "openrouter" || raw === "openai" || raw === "anthropic") return raw;
  throw new ProviderInputError("Unknown provider preset");
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/g, "");
}

/**
 * A free, slug-shaped identifier derived from the name.
 *
 * Derived rather than typed because it is immutable and invisible in ordinary
 * use — it exists to prefix stored model references, and asking an admin to
 * choose one would be asking them to care about something they can never
 * change. `default` is reserved: `ws/chat.ts` sends the literal string
 * "default" when a client names no model.
 */
export async function allocateSlug(name: string): Promise<string> {
  const base = slugify(name) || "provider";
  const rows = await providerRows();
  const taken = new Set(rows.map((r) => r.slug));
  taken.add(DEFAULT_PROVIDER_ID);
  let candidate = base;
  if (!isProviderSlug(candidate)) candidate = "provider";
  for (let n = 2; taken.has(candidate); n++) {
    const suffix = `-${String(n)}`;
    candidate = `${base.slice(0, 32 - suffix.length).replace(/-+$/g, "")}${suffix}`;
  }
  return candidate;
}

export interface CreateProviderInput {
  // Every field is `unknown` and optional: this is a request body, so nothing
  // about it is established until the normalizers below say so. `name` and
  // `baseUrl` are required in the sense that their normalizers refuse
  // `undefined` — enforced there rather than by the type, which a client
  // cannot be held to.
  name?: unknown;
  baseUrl?: unknown;
  preset?: unknown;
  apiKey?: unknown;
  headers?: unknown;
  maxConcurrentRuns?: unknown;
  modelAllowlist?: unknown;
  enabled?: unknown;
}

export async function createProvider(input: CreateProviderInput, createdBy: string): Promise<ProviderRow> {
  const name = normalizeName(input.name);
  const row = {
    name,
    slug: await allocateSlug(name),
    preset: normalizePreset(input.preset),
    baseUrl: normalizeBaseUrl(input.baseUrl),
    encryptedApiKey: typeof input.apiKey === "string" && input.apiKey ? encryptApiKey(input.apiKey) : null,
    headers: normalizeHeaderInput(input.headers),
    maxConcurrentRuns: normalizeMaxConcurrent(input.maxConcurrentRuns),
    modelAllowlist: normalizeAllowlistInput(input.modelAllowlist),
    enabled: input.enabled === undefined ? true : Boolean(input.enabled),
    createdBy,
  };
  const [created] = await db.insert(inferenceProviders).values(row).returning();
  invalidateProviderCache();
  return created;
}

export interface UpdateProviderInput {
  name?: unknown;
  baseUrl?: unknown;
  preset?: unknown;
  /** A string sets the key, null clears it, absent leaves it alone — the same
   * three-way shape `routes/mcp.ts` uses for MCP secrets. Absent has to mean
   * "keep" because the key is never sent back to the client to round-trip. */
  apiKey?: unknown;
  headers?: unknown;
  maxConcurrentRuns?: unknown;
  modelAllowlist?: unknown;
  enabled?: unknown;
  slug?: unknown;
}

export async function updateProvider(id: string, input: UpdateProviderInput): Promise<ProviderRow | null> {
  if (input.slug !== undefined) {
    throw new ProviderInputError(
      "A provider's id cannot be changed — it is stored in every message that used one of its models. Delete it and add a new one instead.",
    );
  }
  const existing = await getProviderRow(id);
  if (!existing) return null;

  const patch: Partial<typeof inferenceProviders.$inferInsert> = { updatedAt: new Date() };
  if (input.name !== undefined) patch.name = normalizeName(input.name);
  if (input.baseUrl !== undefined) patch.baseUrl = normalizeBaseUrl(input.baseUrl);
  if (input.preset !== undefined) patch.preset = normalizePreset(input.preset);
  if (input.headers !== undefined) patch.headers = normalizeHeaderInput(input.headers);
  if (input.maxConcurrentRuns !== undefined) patch.maxConcurrentRuns = normalizeMaxConcurrent(input.maxConcurrentRuns);
  if (input.modelAllowlist !== undefined) patch.modelAllowlist = normalizeAllowlistInput(input.modelAllowlist);
  if (input.enabled !== undefined) patch.enabled = Boolean(input.enabled);
  if (input.apiKey !== undefined) {
    if (input.apiKey === null) patch.encryptedApiKey = null;
    else if (typeof input.apiKey === "string" && input.apiKey) patch.encryptedApiKey = encryptApiKey(input.apiKey);
    else if (input.apiKey !== "") throw new ProviderInputError("An API key must be a string, or null to clear it");
  }

  const [updated] = await db
    .update(inferenceProviders)
    .set(patch)
    .where(eq(inferenceProviders.id, id))
    .returning();
  invalidateProviderCache();
  return updated;
}

/** Hard delete, matching MCP servers and the GitHub connection: a stored
 * credential must not outlive the intent to remove it. Conversations that
 * named one of its models keep the reference and report it as unconfigured,
 * which is the honest answer. */
export async function deleteProvider(id: string): Promise<boolean> {
  const deleted = await db.delete(inferenceProviders).where(eq(inferenceProviders.id, id)).returning();
  invalidateProviderCache();
  return deleted.length > 0;
}

export async function recordProviderCheck(id: string, error: string | null): Promise<void> {
  await db
    .update(inferenceProviders)
    .set({ lastCheckedAt: new Date(), lastError: error })
    .where(eq(inferenceProviders.id, id));
  invalidateProviderCache();
}

/** What the API exposes about a provider. Never the key: `hasApiKey` is the
 * whole of what a client is told, the same way `secretKeys` names MCP secrets
 * without their values. */
export function toApi(row: ProviderRow) {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    preset: row.preset,
    baseUrl: row.baseUrl,
    hasApiKey: row.encryptedApiKey !== null,
    headers: normalizeHeaders(row.headers),
    enabled: row.enabled,
    maxConcurrentRuns: row.maxConcurrentRuns,
    modelAllowlist: normalizeAllowlist(row.modelAllowlist),
    lastCheckedAt: row.lastCheckedAt ? row.lastCheckedAt.toISOString() : null,
    lastError: row.lastError,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Test seam: the cache is process-global and vitest shares one process. */
export function __resetProviderCacheForTest(): void {
  cache = null;
}
