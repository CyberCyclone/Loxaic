import { pgTable, uuid, text, timestamp, integer, bigint, real, jsonb, boolean, serial, index, primaryKey, uniqueIndex } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";

// ── Better-Auth (auto-managed, needed for adapter schema) ──
export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  createdAt: timestamp("created_at").notNull(),
  updatedAt: timestamp("updated_at").notNull(),
  // Better-auth admin plugin fields — see apps/server/src/auth/index.ts.
  role: text("role"),
  banned: boolean("banned").default(false),
  banReason: text("ban_reason"),
  banExpires: timestamp("ban_expires"),
  // Set by a password reset (an admin's, or the reset-password CLI's) and
  // cleared by POST /api/auth/change-password. Enforced in
  // apps/server/src/auth/middleware.ts beside `banned`: until it is cleared the
  // user can sign in, read their session, change their password and sign out,
  // and nothing else.
  mustChangePassword: boolean("must_change_password").notNull().default(false),
});

export const session = pgTable("session", {
  id: text("id").primaryKey(),
  expiresAt: timestamp("expires_at").notNull(),
  token: text("token").notNull().unique(),
  createdAt: timestamp("created_at").notNull(),
  updatedAt: timestamp("updated_at").notNull(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  userId: text("user_id").notNull().references(() => user.id),
  // Better-auth admin plugin field (set while an admin impersonates a user).
  impersonatedBy: text("impersonated_by"),
});

export const account = pgTable("account", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  userId: text("user_id").notNull().references(() => user.id),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: timestamp("access_token_expires_at"),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at"),
  scope: text("scope"),
  password: text("password"),
  createdAt: timestamp("created_at").notNull(),
  updatedAt: timestamp("updated_at").notNull(),
});

export const verification = pgTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at"),
  updatedAt: timestamp("updated_at"),
});

// ── Devices ──
export const devices = pgTable("devices", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: text("user_id").notNull().references(() => user.id),
  name: text("name").notNull(),
  platform: text("platform").notNull(),
  lastSeenAt: timestamp("last_seen_at").defaultNow(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ── Conversations ──
export const conversations = pgTable("conversations", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerId: text("owner_id").notNull().references(() => user.id),
  title: text("title").notNull().default("New conversation"),
  /** `subagent` is a conversation a parent run spawned (streams/runs/
   * subagentRun.ts): it holds one child agent's transcript, is listed nowhere,
   * and is reached only through its parent — see the `parent*` columns. */
  kind: text("kind", { enum: ["chat", "agent", "routine", "subagent"] }).notNull().default("chat"),
  activeLeafId: uuid("active_leaf_id"),
  modelPref: jsonb("model_pref"),
  /** Per-conversation MCP choices, `McpOverrides` in packages/types:
   * { disabledServerIds?: string[], enabledServerIds?: string[] }. A server in
   * neither list follows its per-kind default (`mcp_servers.on_in_*`). */
  mcpOverrides: jsonb("mcp_overrides"),
  /** A `Workspace` (packages/types). Null means scratch — every row that
   * predates the column, and every conversation created without choosing. Set
   * once at creation and never patched: the system prompt is built from it. */
  workspace: jsonb("workspace"),
  /** `ProjectInstructions` (packages/types): the workspace's AGENTS.md as read
   * before the first request, frozen so the system prompt built from it stays
   * byte-identical. Null means not looked for yet (scratch, chat, or a
   * conversation whose lookup has not succeeded). See agent/instructions.ts. */
  instructions: jsonb("instructions"),
  /** The thinking level (`ThinkingLevel` in packages/types) its last run was
   * sent with, recorded by the run. What a run nobody sent can follow — a
   * compaction after a restart, which has no in-memory request shape — rather
   * than the default. Null until a run names one. */
  thinkingLevel: text("thinking_level"),
  /**
   * Set only on a `subagent` conversation: the conversation whose run spawned
   * it. No foreign key, like `messages.conversation_id` — erasing a parent
   * erases its children by hand, in `conversations/delete.ts`, where their
   * messages (which no cascade could reach) go in the same transaction.
   * Everything about who may see or act on a child is answered by its parent
   * (`resolveAccess`).
   */
  parentConversationId: uuid("parent_conversation_id"),
  /** The parent's assistant message whose `subagent` tool call spawned this
   * child, and that call's id. Both, because a model's call ids repeat across
   * messages (`call_0`); together they name one card in the parent's thread. */
  parentMessageId: uuid("parent_message_id"),
  parentCallId: text("parent_call_id"),
  /** A `SubAgentInfo` (packages/types): what the child was asked to do, on
   * which model, and how it ended. Null on every other kind. */
  subagent: jsonb("subagent"),
  /**
   * The model references this conversation's `subagent` tool offers as its
   * `model` argument, frozen the first time the tool is offered. Recomputed
   * per run it would follow the sender's recently-used list, which reorders on
   * every send and differs between editors — and the tools array is the front
   * of every prompt. Null until then, and on a conversation that never offers
   * the choice.
   */
  subagentModels: jsonb("subagent_models"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
  /**
   * When the owner deleted this conversation, on a deployment whose admin
   * turned retention on. It is not the ordinary outcome of a delete: with
   * retention off — the default — deleting erases the row and its messages
   * outright (see `conversations/delete.ts`), and this column is never set.
   *
   * While set, the conversation is gone as far as every ordinary path is
   * concerned: `resolveAccess` refuses it, so the owner, its share-holders and
   * every socket see exactly what they would see if the row had been erased.
   * Only the admin audit routes can still read it, until the sweep in
   * `conversations/reaper.ts` erases it for good.
   */
  deletedAt: timestamp("deleted_at"),
  /**
   * Holds a deleted conversation past its purge date, indefinitely, until an
   * admin releases or erases it. Separate from `deletedAt` because the two
   * answer different questions — "when did this become deleted" is a fact,
   * "may the sweep have it" is a decision — and an admin who is auditing
   * something must be able to make that decision without the retention window
   * deciding for them halfway through.
   */
  deletedHold: boolean("deleted_hold").notNull().default(false),
}, (t) => [
  // "This thread's sub-agents" — asked by the ⋮ list, by every access check on
  // a child, and by a delete.
  index("conversations_parent_idx").on(t.parentConversationId),
]);

/**
 * Who besides the owner may see a conversation, and what they may do in it.
 *
 * Ownership stays on `conversations.ownerId` and is deliberately *not*
 * represented here: an owner row would be a second source of truth for the
 * same fact, and the two would eventually disagree. Absence of a row means no
 * access — the table only ever grants.
 *
 * Roles are ordered (viewer < editor < owner). `viewer` reads and streams;
 * `editor` also sends, stops runs, and answers tool approvals. Anything that
 * reconfigures the conversation — sharing, renaming, deleting, model and MCP
 * preferences — stays with the owner, as does the sandbox terminal, which is
 * arbitrary code execution rather than participation in a chat.
 */
export const conversationShares = pgTable(
  "conversation_shares",
  {
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    role: text("role", { enum: ["viewer", "editor"] }).notNull().default("viewer"),
    /** Who granted it. Kept for the admin view: "shared by the owner" and
     * "shared by an admin" are different facts an admin needs to tell apart. */
    createdBy: text("created_by").notNull().references(() => user.id),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.conversationId, t.userId] }),
    // Every sidebar load asks "which conversations are shared with me", so
    // that lookup gets its own index rather than scanning by conversation.
    index("conversation_shares_user_idx").on(t.userId),
  ],
);

// ── Messages (tree via parent_id) ──
export const messages = pgTable(
  "messages",
  {
    id: uuid("id").primaryKey(),
    conversationId: uuid("conversation_id").notNull(),
    parentId: uuid("parent_id"),
    authorType: text("author_type", { enum: ["user", "assistant", "system", "tool", "summary"] }).notNull(),
    authorUserId: text("author_user_id").references(() => user.id),
    origin: text("origin", { enum: ["server", "device"] }).notNull().default("server"),
    deviceId: uuid("device_id"),
    model: text("model"),
    lamport: bigint("lamport", { mode: "number" }).notNull(),
    content: jsonb("content").notNull(),
    status: text("status", { enum: ["streaming", "complete", "error", "cancelled"] }).notNull().default("streaming"),
    /** Why a `status: "error"` turn failed, as shown under it. Null for every
     * other status — a user stop is not an error — and for failed rows written
     * before this column, which the client answers with a plain fallback. */
    error: text("error"),
    /** A `StreamErrorCode` beside `error`, when the client offers a way out
     * of it (a reply that could not fit: "Edit message", #166). Null for every
     * other failure. */
    errorCode: text("error_code"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    deletedAt: timestamp("deleted_at"),
  },
  (t) => [
    // Every history load and the boot-time orphan sweep filter by
    // conversation; previously an unindexed seq scan on every request.
    index("messages_conversation_created_idx").on(t.conversationId, t.createdAt),
    // Serves the agent tool loop's history ordering ([desc(lamport), desc(createdAt)]).
    index("messages_conversation_lamport_idx").on(t.conversationId, t.lamport),
  ],
);

// ── File checkpoints (agent/checkpoints.ts) ──
/**
 * What a file was before a turn's first `fs_write` or `fs_edit` of it, so a
 * rewind can put it back (#166). The bytes are a copy in the workspace itself
 * (or, for a folder on the person's own machine, beside it in their home
 * directory), never here: this is the manifest, which lets the rewind dialog
 * say whether a point has changes to restore without asking the workspace.
 *
 * Keyed to the conversation whose workspace the file is in and the user
 * message whose turn wrote it — a sub-agent's edits are its parent's turn's.
 * No foreign keys, like `messages`: erasing a conversation erases these in
 * `conversations/delete.ts`.
 */
export const checkpointFiles = pgTable(
  "checkpoint_files",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    conversationId: uuid("conversation_id").notNull(),
    turnMessageId: uuid("turn_message_id").notNull(),
    /** Absolute, as `resolvePath` gave it inside the workspace. */
    path: text("path").notNull(),
    /** `saved`: a copy exists; `missing`: the file did not exist, so restoring
     * deletes it; `too_large`, `symlink`, `not_file`: nothing was copied, and a
     * restore reports the path as skipped with that reason; `unknown`: the
     * state was never learned (the copy failed, or the server stopped
     * mid-way), so a restore leaves the file alone and says so. */
    state: text("state", { enum: ["saved", "missing", "too_large", "symlink", "not_file", "unknown"] }).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    // The first write of a path in a turn is its state before the turn; a
    // second one must not replace it.
    uniqueIndex("checkpoint_files_turn_path_idx").on(t.conversationId, t.turnMessageId, t.path),
    index("checkpoint_files_conversation_idx").on(t.conversationId, t.createdAt),
  ],
);

// ── Attachments (uploaded files; bytes live on disk under UPLOADS_DIR, with
// a document's extracted text cached beside them as `<ref>.txt`) ──
export const attachments = pgTable("attachments", {
  /** The public "ref" handed to clients and stored in message content blocks. */
  id: uuid("id").primaryKey().defaultRandom(),
  ownerId: text("owner_id").notNull().references(() => user.id),
  mime: text("mime").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  /** As picked, sanitized (basename only, no control chars, length-capped).
   * The model is told this name, the UI labels the chip with it, and the serve
   * route puts it in Content-Disposition. Defaulted rather than nullable so
   * every read site has a string; rows predating documents get "". */
  filename: text("filename").default("").notNull(),
  /** Text-extraction outcome: "none" for images (nothing to extract), "ok",
   * "failed" (parser error/timeout — the file is still stored), or
   * "unsupported". Never blocks the upload; it drives what the prompt and the
   * chip say. */
  extractStatus: text("extract_status").default("none").notNull(),
  /** Bytes of the cached `<ref>.txt`, so the prompt budget can be spent
   * without stat-ing every attachment in a long history. */
  extractBytes: integer("extract_bytes").default(0).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ── Sync Ops ──
export const syncOps = pgTable("sync_ops", {
  seq: serial("seq").primaryKey(),
  userId: text("user_id").notNull().references(() => user.id),
  deviceId: uuid("device_id"),
  opType: text("op_type").notNull(),
  entityId: uuid("entity_id").notNull(),
  payload: jsonb("payload").notNull(),
  lamport: bigint("lamport", { mode: "number" }).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ── Usage Records ──
export const usageRecords = pgTable("usage_records", {
  id: uuid("id").primaryKey(),
  userId: text("user_id").notNull().references(() => user.id),
  deviceId: uuid("device_id"),
  conversationId: uuid("conversation_id"),
  messageId: uuid("message_id"),
  runId: uuid("run_id"),
  model: text("model").notNull(),
  origin: text("origin", { enum: ["server", "device"] }).notNull().default("server"),
  inputTokens: integer("input_tokens").notNull(),
  /**
   * Tokens the *backend* reported reusing from its KV cache — ground truth,
   * and deliberately nullable: "the backend does not report this" is not the
   * same fact as "nothing was cached". llama.cpp reports it (`timings.cache_n`);
   * LM Studio reports nothing about caching at all, and storing that as 0 is
   * what pinned the stats screen's cache-hit rate at a permanent 0%.
   */
  cachedTokens: integer("cached_tokens"),
  /**
   * Tokens of this prompt that were a token-identical prefix of the previous
   * request we sent for the same conversation, model and toolset — i.e. what
   * we *offered* the backend to reuse. Computed by us (see
   * `inference/prompt-reuse.ts`), so it is available on every backend, and it
   * is the figure the aggregate charts use. It is not proof the backend
   * reused it; `cachedTokens` is the only thing that proves that.
   */
  reusableTokens: integer("reusable_tokens"),
  outputTokens: integer("output_tokens").notNull(),
  ttftMs: integer("ttft_ms"),
  promptMs: integer("prompt_ms"),
  predictMs: integer("predict_ms"),
  totalMs: integer("total_ms"),
  /**
   * Prompt-evaluation rate over the tokens actually *evaluated*. Null when the
   * backend does not say how many that was — it was previously derived as
   * `prompt_tokens / ttft`, which on a cache hit is not a rate of anything
   * (47,742 tok/s was observed and rendered as "Prompt speed").
   */
  promptTps: real("prompt_tps"),
  predictedTps: real("predicted_tps"),
  /**
   * Speculative decoding (an MTP head, apps/server/src/llama/load-settings.ts):
   * tokens the draft proposed, and how many of them the model accepted. Null
   * when the request was not speculated — never 0, which would read as a head
   * whose every guess was wrong. llama.cpp reports them as `timings.draft_n`
   * and `timings.draft_n_accepted`.
   */
  draftTokens: integer("draft_tokens"),
  draftAcceptedTokens: integer("draft_accepted_tokens"),
  /** What this turn's prompt was made of — see ContextBreakdown in
   * @loxaic/types. Nullable: rows predating this column have none. */
  contextBreakdown: jsonb("context_breakdown"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => [
  // Who else is using a model right now, asked whenever a context stage might
  // change (llama/context-stage-policy.ts). Without it that question is a scan
  // of the fastest-growing table in the database.
  index("usage_records_model_created_idx").on(t.model, t.createdAt),
  // "This conversation's requests, newest first": a thread's sub-agent listing
  // asks it twice per child (their figures come from here), as do the context
  // meter's fallback and a stage change's size check.
  index("usage_records_conversation_created_idx").on(t.conversationId, t.createdAt),
]);

// ── Workspaces ──
export const workspaces = pgTable("workspaces", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerId: text("owner_id").notNull().references(() => user.id),
  name: text("name").notNull(),
  hostPath: text("host_path").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ── Sandboxes ──
export const sandboxes = pgTable("sandboxes", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerId: text("owner_id").notNull().references(() => user.id),
  conversationId: uuid("conversation_id"),
  containerId: text("container_id").notNull(),
  /** "container" (dockerode ref) or "host" (a host directory path). */
  provider: text("provider").notNull().default("container"),
  image: text("image").notNull(),
  /**
   * "creating" → "running" → "stopped" → "destroyed".
   *
   * **"stopped" means paused, not gone**: the container still exists and its
   * filesystem is intact, so the next tool call resumes it with the work still
   * there. Only "destroyed" is terminal, and only two things produce it —
   * deleting the conversation, and the abandoned-sandbox reaper.
   */
  status: text("status").notNull().default("creating"),
  repoUrl: text("repo_url"),
  branch: text("branch"),
  limits: jsonb("limits"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  /**
   * When a tool call last used this sandbox. Drives both reapers: idle-stop
   * (pause it) and abandoned-destroy (reclaim it).
   *
   * Written on create, on resume, when a sandbox is stopped, and flushed for
   * live sandboxes on each reaper tick — never on every tool call, which
   * would be a database write per `bash`. A running sandbox's row can
   * therefore lag by up to one tick; that is harmless, because nothing is
   * destroyed on a timescale a five-minute lag can reach.
   */
  lastUsedAt: timestamp("last_used_at").defaultNow().notNull(),
  stoppedAt: timestamp("stopped_at"),
});

// ── Routines ──
export const routines = pgTable("routines", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerId: text("owner_id").notNull().references(() => user.id),
  name: text("name").notNull(),
  cron: text("cron").notNull(),
  prompt: text("prompt").notNull(),
  target: jsonb("target"),
  enabled: boolean("enabled").notNull().default(true),
  /**
   * The model every run of this routine uses — one opaque reference, the same
   * string a conversation's `model_pref` holds (`slug::id`, or a bare id for
   * the built-in backend). Nothing ever substitutes for it: a run whose model
   * is missing or unusable fails and says so, rather than quietly spending an
   * admin's provider key on whatever else happens to be loaded.
   *
   * Nullable only for routines written before this column existed (and for an
   * older client that posts without one). Those fail every run until someone
   * edits the routine and picks a model.
   */
  model: text("model"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  lastRunAt: timestamp("last_run_at"),
  nextRunAt: timestamp("next_run_at"),
});

// ── Routine Runs ──
export const routineRuns = pgTable(
  "routine_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Cascades: deleting a routine must not leave rows pointing at it, and
     * the delete route's own pass over the conversations is what erases the
     * chats those rows name. */
    routineId: uuid("routine_id")
      .notNull()
      .references(() => routines.id, { onDelete: "cascade" }),
    conversationId: uuid("conversation_id").notNull(),
    status: text("status").notNull().default("running"),
    startedAt: timestamp("started_at").defaultNow().notNull(),
    finishedAt: timestamp("finished_at"),
  },
  (t) => [
    index("routine_runs_routine_started_idx").on(t.routineId, t.startedAt),
    // Erasing any conversation now looks for run rows naming it.
    index("routine_runs_conversation_idx").on(t.conversationId),
  ],
);

// ── Model Registry ──
export const modelRegistry = pgTable("model_registry", {
  id: text("id").primaryKey(),
  displayName: text("display_name").notNull(),
  ggufUrl: text("gguf_url"),
  sizeBytes: bigint("size_bytes", { mode: "number" }),
  quant: text("quant"),
  contextTokens: integer("context_tokens"),
  capabilities: jsonb("capabilities"),
  location: text("location", { enum: ["server", "device", "both"] }).notNull().default("server"),
});

// ── MCP Servers ──
export const mcpServers = pgTable(
  "mcp_servers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: text("owner_id").notNull().references(() => user.id),
    name: text("name").notNull(),
    /** Short [a-z0-9-] identifier; namespaces the server's tools as `slug__tool`. */
    slug: text("slug").notNull(),
    transport: text("transport", { enum: ["stdio", "http"] }).notNull(),
    // stdio transport
    command: text("command"),
    args: jsonb("args"),
    // http transport
    url: text("url"),
    headers: jsonb("headers"),
    /** Non-secret environment variables for stdio servers. */
    env: jsonb("env"),
    /** Encrypted secret blob (see apps/server/src/mcp/secrets.ts); never returned raw. */
    secrets: text("secrets"),
    /** Set when the row was created from the built-in catalog (e.g. 'brave'). */
    builtinKey: text("builtin_key"),
    enabled: boolean("enabled").notNull().default(true),
    /** User-confirmed opt-out of the SSRF guard for http servers on private addresses. */
    allowPrivateNetwork: boolean("allow_private_network").notNull().default(false),
    /** The owner's default for each kind of conversation — whether a chat,
     * agent or routine conversation that has made no choice of its own is
     * offered this server's tools. Resolved live by `mcpServerActive`
     * (packages/types), never copied into a conversation. */
    onInChat: boolean("on_in_chat").notNull().default(true),
    onInAgent: boolean("on_in_agent").notNull().default(true),
    onInRoutines: boolean("on_in_routines").notNull().default(true),
    /** Per-tool policy map: { [remoteName]: { enabled, approval: 'ask'|'allow', readOnly } }. */
    toolPolicies: jsonb("tool_policies").notNull().default({}),
    /** Last-discovered tool snapshot (hashes) for change detection. */
    knownTools: jsonb("known_tools").notNull().default({}),
    lastConnectedAt: timestamp("last_connected_at"),
    lastError: text("last_error"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [uniqueIndex("mcp_servers_owner_slug_idx").on(t.ownerId, t.slug)],
);

// ── Inference providers ──
/**
 * An LLM backend an admin added through the GUI, beyond the built-in local
 * llama.cpp runtime. Every row is OpenAI-compatible
 * (`POST {baseUrl}/chat/completions`), which covers OpenRouter, OpenAI,
 * Anthropic's compatibility endpoint, and any other llama.cpp / LM Studio /
 * vLLM / Ollama host on the network.
 *
 * There is deliberately no row for the built-in backend: it is the managed
 * llama.cpp router, synthesized at call time (see
 * apps/server/src/inference/providers.ts). A deployment that used to set
 * `INFERENCE_BASE_URL` has that backend converted into a row here once, at
 * boot (inference/legacy-migration.ts).
 *
 * Deployment-wide, not per-user: the key is the admin's and every signed-in
 * user spends it, which is why `model_allowlist` exists and why every route
 * that touches this table is behind `requireAdmin`.
 */
export const inferenceProviders = pgTable(
  "inference_providers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Admin-chosen label, and exactly what users see as the group header in
     * the model picker. Free text, renameable at any time — two rows may share
     * a preset ("Work OpenRouter" / "Personal OpenRouter"), which is the case
     * that makes it load-bearing rather than decorative. */
    name: text("name").notNull(),
    /** Immutable [a-z0-9-] identifier, derived from the name at creation. It is
     * baked into every stored model reference (`slug::upstreamId`) in
     * conversations.model_pref, messages.model and usage_records.model, so a
     * rename must not touch it. */
    slug: text("slug").notNull(),
    /** Which vendor's defaults were used to fill this row in, or null for a
     * hand-entered one. Decides whether the LM Studio-native and /props probes
     * are worth attempting, and nothing else. */
    preset: text("preset", { enum: ["openrouter", "openai", "anthropic"] }),
    /** The API base *including* the version segment
     * (`https://openrouter.ai/api/v1`). "Root plus /v1" cannot express
     * OpenRouter, whose API lives under /api/v1. */
    baseUrl: text("base_url").notNull(),
    /** Encrypted blob (see apps/server/src/inference/provider-secrets.ts);
     * never returned by any route, not even to an admin. */
    encryptedApiKey: text("encrypted_api_key"),
    /** Non-secret extra request headers, e.g. OpenRouter's HTTP-Referer and
     * X-Title. Hop-by-hop and auth headers are refused on write. */
    headers: jsonb("headers"),
    enabled: boolean("enabled").notNull().default(true),
    /** Outranks every other concurrency source for this provider's own queue.
     * Null resolves through a /props probe and then the floor of 1. */
    maxConcurrentRuns: integer("max_concurrent_runs"),
    /** Model ids (upstream, unqualified) users may pick, or null for "whatever
     * the provider lists". Enforced server-side at send time — hiding a model
     * in the picker is presentation, not a spending limit. Doubles as a manual
     * model list when the provider's own /models call fails. */
    modelAllowlist: jsonb("model_allowlist"),
    /** Context sizes an admin set, in tokens: by upstream model id, and under
     * "*" for every model the provider does not report one for. OpenAI's
     * /models reports none, and a conversation on a model whose size is
     * unknown can never be compacted — it grows until the provider refuses a
     * request, and stays stuck. Null when none are set. */
    contextWindows: jsonb("context_windows"),
    lastCheckedAt: timestamp("last_checked_at"),
    lastError: text("last_error"),
    /** Attribution only, so `set null` rather than the default `no action`
     * (which would make an admin who ever added a provider undeletable) or
     * `cascade` (which would remove deployment-wide configuration, and orphan
     * every conversation referencing its slug, because the person who typed it
     * in left). The row outlives its author, the way `usage_records` outlive
     * the conversation they were spent on. */
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [uniqueIndex("inference_providers_slug_idx").on(t.slug)],
);

// ── Local models (the managed llama.cpp runtime) ──
/**
 * A GGUF an admin downloaded from HuggingFace for the built-in llama.cpp
 * router to serve. The row's `id` *is* the model reference users send — bare,
 * `<repo>:<quant>`, the default provider's namespace — and the router's preset
 * section name, so the three can never disagree.
 *
 * A row is served only when `status = 'ready' AND enabled`, and that is
 * enforced server-side at send time (`assertModelUsable`), not only in the
 * picker. Downloading a model and offering it to every user are separate
 * decisions.
 */
export const localModels = pgTable(
  "local_models",
  {
    /** `<hf-repo>:<quant>`, e.g. `unsloth/Qwen3-8B-GGUF:Q4_K_M`. */
    id: text("id").notNull(),
    /** Which server instance holds the files — part of the key, because files
     * live on one machine's disk: a cluster sharing this database must not
     * offer another host's download as if it were here, and two hosts may each
     * download the same model. `""` for an instance with no registered identity
     * (a dev server, Compose). */
    hostId: text("host_id").notNull().default(""),
    repo: text("repo").notNull(),
    /** The commit the files were resolved at — downloads are pinned to it, so
     * a repo force-pushed mid-download cannot splice two revisions together. */
    revision: text("revision").notNull(),
    quant: text("quant").notNull(),
    /** `[{ path, size, sha256 }]`, the weights in shard order. */
    files: jsonb("files").notNull(),
    /** The vision projector, when one was downloaded with the weights. */
    mmproj: jsonb("mmproj"),
    /** A separate multi-token-prediction head (a repo's `MTP/mtp-*.gguf`),
     * with its own revision and download state:
     * `{ path, size, sha256, revision, status, bytesDone, error, layers }`.
     * Downloaded after the model, while the model stays usable. Null for none —
     * a model whose own file carries a head needs none (`meta.mtp`). */
    mtpHead: jsonb("mtp_head"),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    status: text("status", { enum: ["queued", "downloading", "paused", "failed", "ready"] }).notNull(),
    bytesDone: bigint("bytes_done", { mode: "number" }).notNull().default(0),
    error: text("error"),
    enabled: boolean("enabled").notNull().default(false),
    /** Kept loaded: loaded when pinned and after every runtime restart, and
     * never unloaded to make room for another model. Only an enabled model can
     * be pinned; disabling one unpins it. */
    pinned: boolean("pinned").notNull().default(false),
    /** Admin-set load settings (see apps/server/src/llama/load-settings.ts),
     * validated before they are stored and again before they reach the preset
     * file — an unknown key there stops the router from starting at all. */
    loadSettings: jsonb("load_settings").notNull().default({}),
    /** Options passed to llama.cpp as an admin typed them, `[{ key, value }]`
     * (apps/server/src/llama/extra-options.ts). Kept apart from `loadSettings`,
     * whose keys are a whitelist: a key here is checked against the build's own
     * `--help` when written, and again whenever the preset is. Null for none. */
    extraOptions: jsonb("extra_options"),
    /** GGUF facts from HuggingFace, for the settings sheet's ranges and the
     * fit estimate: `{ nLayers?, nCtxTrain?, nParams?, architecture? }`. */
    meta: jsonb("meta").notNull().default({}),
    /** YaRN context stages (see apps/server/src/llama/context-stages.ts):
     * `{ enabled, whoMayChange, whenFull, stages: [{ ctxSize, … }] }`. Null
     * until an admin sets them up. Stage 0 is always `loadSettings` as is. */
    contextStages: jsonb("context_stages"),
    /** Which stage the model loads at now — model-wide, since a load is shared
     * by everyone using the model. 0 is the standard context. */
    activeStage: integer("active_stage").notNull().default(0),
    displayName: text("display_name").notNull(),
    publisher: text("publisher").notNull(),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [primaryKey({ columns: [t.hostId, t.id] })],
);

/**
 * One row per server instance sharing this database. The set of rows *is* the
 * cluster: identity lives in the database, so pointing an instance at a
 * different database makes it part of a different cluster by construction,
 * with nothing to reconcile.
 *
 * `id` is the desktop install's stable `instanceId` (config.json), not a
 * generated key — a Solo→Host switch must update this machine's row rather
 * than register the same machine twice.
 *
 * `name` is user-chosen at onboarding (defaulting to the machine's hostname).
 * It is the label shown against every model in the picker, so it is how a user
 * tells "the model on the GPU box" from "the model on the laptop".
 */
export const hosts = pgTable("hosts", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  advertiseUrl: text("advertise_url").notNull(),
  /** Where this host's own inference backend listens. Phase 4 fans out over
   * these; today it records what the single host is using. */
  inferenceBaseUrl: text("inference_base_url"),
  version: text("version"),
  /** Refreshed while the instance is alive. A stale heartbeat is what marks a
   * host (and its models) as gone without deleting its conversations. */
  lastHeartbeatAt: timestamp("last_heartbeat_at").defaultNow().notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

/** Server-level (not per-user) configuration set through the admin GUI, e.g.
 * the agent sandbox's mode/engine/network. Key-value so a new setting group
 * costs a row rather than a migration. Environment variables always take
 * precedence over anything stored here — see apps/server/src/settings.ts. */
export const serverSettings = pgTable("server_settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull().default({}),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const userPrefs = pgTable("user_prefs", {
  /** Cascades, matching `github_connections`. A row here is settings *about* a
   * user and has no meaning without them — and now that starting a run records
   * a recently-used model, every active user has one, so without the cascade
   * a user could not be deleted until something thought to delete a table it
   * never touched. */
  userId: text("user_id").primaryKey().references(() => user.id, { onDelete: "cascade" }),
  /** Builtin tool names the user has allowlisted ("allow always") — these
   * stop asking for approval anywhere the tool loop runs (chat and agent
   * manual mode alike). MCP tools have their own per-server toolPolicies
   * allowlist instead. */
  toolAllowlist: jsonb("tool_allowlist").notNull().default([]),
  /**
   * How many tool round-trips the agent takes for one message before it pauses
   * and asks whether to keep going — a cadence, not a ceiling. It used to be a
   * ceiling and the run simply died there (#157); now the loop hands its
   * inference slot back and waits for an answer, exactly as it does at a tool
   * approval. Bounded by the route, not just the column: a zero would make the
   * agent unable to act at all, and an unbounded value is a way for one run to
   * hold a shared backend for a very long time without anyone being asked.
   */
  maxIterations: integer("max_iterations").notNull().default(100),
  /**
   * How long a step check-in waits for an answer, in ms. **Null means "the
   * server's default"** (`APPROVAL_TIMEOUT_MS`, else ten minutes), and the
   * nullability is load-bearing: a NOT NULL default here would override the
   * operator's env for every user who has ever changed any other preference —
   * and every test that pins a short window through the env for a user with a
   * prefs row would then wait ten real minutes.
   */
  checkinTimeoutMs: integer("checkin_timeout_ms"),
  /** The same, for a tool approval. Separate because an unanswered approval
   * blocks the model mid-turn, which is a different thing to wait on. */
  approvalTimeoutMs: integer("approval_timeout_ms"),
  /** Stretch either window to twice the run's slowest model request, so a slow
   * backend is not held to a deadline shorter than one of its own steps. */
  adaptiveTimeout: boolean("adaptive_timeout").notNull().default(true),
  /** How many unanswered check-ins in a row carry on by themselves before the
   * run wraps up. Each is another full step window of unattended work. */
  checkinAutoContinues: integer("checkin_auto_continues").notNull().default(2),
  /** `off` | `relaxed` | `normal` — how eagerly the loop detector asks. */
  loopSensitivity: text("loop_sensitivity").notNull().default("normal"),
  /**
   * Model references this user most recently *sent* with, newest first, capped
   * at RECENT_MODELS_MAX. Stored rather than derived from `usage_records`,
   * which has no index on user_id — a sequential scan every time the picker
   * opens, on the table that grows fastest.
   *
   * Server-owned: written by the run starters, refused by PATCH /v1/prefs. A
   * send is what counts as use, not a tap in the picker, so the list describes
   * what the user actually ran rather than what they browsed past.
   */
  recentModels: jsonb("recent_models").notNull().default([]),
  /**
   * Which model a sub-agent runs on: `choose` (the parent's, unless the parent
   * names another it is offered), `parent` (always the parent's), or `fixed`
   * (`subagentModel`, whatever the parent is on). See `subagentModelFor` in
   * streams/runs/subagent-policy.ts.
   */
  subagentModelMode: text("subagent_model_mode").notNull().default("choose"),
  /** The model reference `fixed` uses. Kept when the mode moves away from
   * `fixed`, so going back offers it again; null until one is picked. */
  subagentModel: text("subagent_model"),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// ── GitHub connections ──
/**
 * One personal access token per user, for cloning a workspace repo and
 * committing/pushing/opening a PR on their behalf (see agent/workspace.ts,
 * a later stage). `userId` is the primary key rather than a generated one —
 * a user has at most one GitHub connection, the same shape `userPrefs` uses.
 */
export const githubConnections = pgTable("github_connections", {
  userId: text("user_id").primaryKey().references(() => user.id, { onDelete: "cascade" }),
  /** Encrypted blob (see server/src/github/secrets.ts); never returned raw. */
  encryptedToken: text("encrypted_token").notNull(),
  login: text("login").notNull(),
  /** For `git config user.name`/`user.email` at clone time (a later stage) —
   * captured now so the connection doesn't need re-fetching for it then. */
  name: text("name"),
  email: text("email"),
  /** `X-OAuth-Scopes` off the validating request. Null for a fine-grained PAT,
   * which the GitHub API does not report scopes for — null must read as
   * "unknown", never as "no access". */
  scopes: text("scopes"),
  validatedAt: timestamp("validated_at").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// ── Relations ──
export const conversationsRelations = relations(conversations, ({ many }) => ({
  messages: many(messages),
}));

export const messagesRelations = relations(messages, ({ one }) => ({
  conversation: one(conversations, {
    fields: [messages.conversationId],
    references: [conversations.id],
  }),
  parent: one(messages, {
    fields: [messages.parentId],
    references: [messages.id],
  }),
}));
