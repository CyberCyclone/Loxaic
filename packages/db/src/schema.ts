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
  kind: text("kind", { enum: ["chat", "agent", "routine"] }).notNull().default("chat"),
  activeLeafId: uuid("active_leaf_id"),
  modelPref: jsonb("model_pref"),
  /** Per-conversation MCP overrides, e.g. { disabledServerIds: string[] }. */
  mcpOverrides: jsonb("mcp_overrides"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
  deletedAt: timestamp("deleted_at"),
});

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
  cachedTokens: integer("cached_tokens").notNull().default(0),
  outputTokens: integer("output_tokens").notNull(),
  ttftMs: integer("ttft_ms"),
  promptMs: integer("prompt_ms"),
  predictMs: integer("predict_ms"),
  totalMs: integer("total_ms"),
  promptTps: real("prompt_tps"),
  predictedTps: real("predicted_tps"),
  /** What this turn's prompt was made of — see ContextBreakdown in
   * @shannon/types. Nullable: rows predating this column have none. */
  contextBreakdown: jsonb("context_breakdown"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

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
  status: text("status").notNull().default("creating"),
  repoUrl: text("repo_url"),
  branch: text("branch"),
  limits: jsonb("limits"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
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
  lastRunAt: timestamp("last_run_at"),
  nextRunAt: timestamp("next_run_at"),
});

// ── Routine Runs ──
export const routineRuns = pgTable("routine_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  routineId: uuid("routine_id").notNull(),
  conversationId: uuid("conversation_id").notNull(),
  status: text("status").notNull().default("running"),
  startedAt: timestamp("started_at").defaultNow().notNull(),
  finishedAt: timestamp("finished_at"),
});

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
  userId: text("user_id").primaryKey().references(() => user.id),
  /** Builtin tool names the user has allowlisted ("allow always") — these
   * stop asking for approval anywhere the tool loop runs (chat and agent
   * manual mode alike). MCP tools have their own per-server toolPolicies
   * allowlist instead. */
  toolAllowlist: jsonb("tool_allowlist").notNull().default([]),
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
