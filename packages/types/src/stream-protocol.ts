import type { FileDiff } from "./index";

/** Duplicated (structurally, not nominally) from @loxaic/agent so this
 * package stays dependency-free — packages/agent is the authority for
 * agent-loop *logic* (toolRequiresApproval etc.), this is only the wire shape. */
export type PermissionMode = "planning" | "manual" | "auto";

export interface Todo { id?: string; text: string; status: "pending" | "in_progress" | "completed" }

/** An uploaded file attached to a user message. `ref` is the id returned by
 * `POST /v1/files`; `mime` and `name` are advisory for rendering (the server's
 * DB row is the authority for both). */
export interface AttachmentRef { ref: string; mime: string; name?: string }

/** Shared client/server limits for attachments — one source so the composer's
 * caps and the upload route's rejections can't drift apart, and so no platform
 * can end up with a cap of its own. */
export const MAX_ATTACHMENTS = 4;

/** Images. Sniffable by magic bytes, sent to the model as `image_url` parts. */
export const IMAGE_MIMES = ["image/jpeg", "image/png", "image/webp", "image/gif"] as const;

/** Text-ish formats: no parser, so no sandbox. These are read straight off
 * disk, validated as UTF-8, and inlined — which is why they stay available
 * when SANDBOX_MODE is "off" and DOCUMENT_MIMES do not. */
export const TEXT_MIMES = [
  "text/plain",
  "text/markdown",
  "text/csv",
  "text/tab-separated-values",
  "text/html",
  "text/xml",
  "application/xml",
  "text/yaml",
  "application/yaml",
  "application/json",
] as const;

/** Formats needing a real parser run over a file the server did not author.
 * Extraction happens inside the sandbox container, so these are rejected at
 * upload when no sandbox is configured.
 *
 * Everything here except PDF and RTF is a zip container, which is why the
 * in-sandbox extractor runs a decompression-bomb guard before reading one.
 * All of them are text-only: images embedded in a document are not read. */
export const DOCUMENT_MIMES = [
  "application/pdf",
  // Office Open XML (.docx/.xlsx/.pptx)
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  // OpenDocument (.odt)
  "application/vnd.oasis.opendocument.text",
  // Rich Text and EPUB
  "application/rtf",
  "text/rtf",
  "application/epub+zip",
] as const;

export const ATTACHMENT_MIMES = [...IMAGE_MIMES, ...TEXT_MIMES, ...DOCUMENT_MIMES] as const;

export type AttachmentClass = "image" | "text" | "document";

/** Which pipeline a mime takes. Returns null for anything not allowlisted —
 * callers treat that as "reject", never as a default class. */
export function attachmentClass(mime: string): AttachmentClass | null {
  const m = mime.toLowerCase();
  if ((IMAGE_MIMES as readonly string[]).includes(m)) return "image";
  if ((TEXT_MIMES as readonly string[]).includes(m)) return "text";
  if ((DOCUMENT_MIMES as readonly string[]).includes(m)) return "document";
  return null;
}

/** Images keep their own 10 MB cap; documents may be larger because what
 * bounds their prompt cost is MAX_EXTRACTED_BYTES, not the upload size. */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024;

/** Ceiling on one attachment's extracted text. Deliberately far below what a
 * hosted assistant would allow: this text is inlined into a local model's
 * window, so the binding constraint is the window, not the disk. */
export const MAX_EXTRACTED_BYTES = 256 * 1024;

/** Ceiling on the cached `<ref>.txt` sidecar written at extraction time —
 * distinct from MAX_EXTRACTED_BYTES, which bounds what enters the *prompt*.
 * This is a disk/sandbox-paging ceiling: it exists so a big document still
 * has something for the agent to grep/fs_read through after the prompt-facing
 * copy has been truncated, without letting one attachment's cache grow
 * unbounded. Comfortably above MAX_EXTRACTED_BYTES; not meant to be tight. */
export const MAX_CACHED_EXTRACTION_BYTES = 4 * 1024 * 1024;

/** Pages `pdftotext` is allowed to walk. Bounds extraction time on a
 * pathological PDF independently of the byte cap. */
export const MAX_PDF_PAGES = 200;

/** The largest upload the route will accept, across all classes — what
 * @fastify/multipart's `limits.fileSize` is set to. Per-class caps are checked
 * after the bytes land, once the real size is known. */
export const MAX_UPLOAD_BYTES = Math.max(MAX_ATTACHMENT_BYTES, MAX_DOCUMENT_BYTES);

/** Per-class upload ceiling, for the size check after the bytes land. */
export function maxBytesForMime(mime: string): number {
  return attachmentClass(mime) === "image" ? MAX_ATTACHMENT_BYTES : MAX_DOCUMENT_BYTES;
}

/**
 * Browsers report `File.type` as "" for plenty of text formats — .md, .ts,
 * .yml, often .csv — so a strict mime allowlist alone would silently reject
 * exactly the source files a coding assistant is most likely to be handed.
 * Shared so the composer and the upload route agree on what an extension
 * means; the server still confirms the bytes independently.
 */
const EXTENSION_MIMES: Record<string, string> = {
  txt: "text/plain", text: "text/plain", log: "text/plain",
  md: "text/markdown", markdown: "text/markdown",
  csv: "text/csv", tsv: "text/tab-separated-values",
  json: "application/json", jsonl: "application/json",
  xml: "text/xml", html: "text/html", htm: "text/html",
  yaml: "text/yaml", yml: "text/yaml",
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  odt: "application/vnd.oasis.opendocument.text",
  rtf: "application/rtf",
  epub: "application/epub+zip",
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png",
  webp: "image/webp", gif: "image/gif",
  // Source files. All plain text to us — the extension only has to get them
  // past the allowlist; nothing downstream cares which language it is.
  ts: "text/plain", tsx: "text/plain", js: "text/plain", jsx: "text/plain",
  py: "text/plain", rb: "text/plain", go: "text/plain", rs: "text/plain",
  java: "text/plain", c: "text/plain", h: "text/plain", cpp: "text/plain",
  cs: "text/plain", php: "text/plain", swift: "text/plain", kt: "text/plain",
  sh: "text/plain", bash: "text/plain", zsh: "text/plain", sql: "text/plain",
  toml: "text/plain", ini: "text/plain", cfg: "text/plain", conf: "text/plain",
  env: "text/plain", diff: "text/plain", patch: "text/plain",
  // Extensionless dotfiles: ".gitignore".split(".") yields "gitignore",
  // so these key the same way any other extension does.
  gitignore: "text/plain", gitattributes: "text/plain", dockerignore: "text/plain",
  editorconfig: "text/plain", npmrc: "text/plain", nvmrc: "text/plain",
  bashrc: "text/plain", zshrc: "text/plain", profile: "text/plain",
};

/**
 * Best-effort mime for a picked file. A usable declared type always wins; the
 * extension is only consulted when the picker gave us nothing (or a generic
 * octet-stream). Returns null when neither yields an allowlisted mime, which
 * callers must treat as "reject".
 */
export function resolveAttachmentMime(declared: string | undefined, filename: string): string | null {
  const d = declared?.toLowerCase().trim();
  if (d && d !== "application/octet-stream" && attachmentClass(d)) return d;
  const ext = filename.toLowerCase().split(".").pop();
  if (!ext || ext === filename.toLowerCase()) return null;
  const byExt = EXTENSION_MIMES[ext];
  return byExt && attachmentClass(byExt) ? byExt : null;
}

/** Longest filename kept. Long enough for any real name, short enough that a
 * pathological one can't dominate the prompt or a response header. */
export const MAX_FILENAME_LENGTH = 200;

/**
 * A filename safe to put in a `Content-Disposition` header, a prompt, and the
 * UI. Everything the client sends is a claim: this keeps the basename only
 * (so no path component can survive), drops control characters — which in a
 * header would be response splitting, and in a prompt would be an escape
 * attempt — and caps the length. Never returns "", so a caller always has
 * something to render.
 */
export function sanitizeFilename(raw: unknown): string {
  if (typeof raw !== "string") return "file";
  // Decode *before* splitting, and that order is load-bearing: a name
  // containing %2F decodes to a separator, and decoding after the split would
  // reintroduce one that the split had already removed. Android's document
  // picker returns percent-encoded names off the content:// URI — a real
  // upload arrived as
  // "SESSION%202%20Accountability%20BIBLE%20DISCOVERY%20%26%20DISCUSSION%20QUESTIONS.docx"
  // which is what the user then saw on the chip, what the model was told the
  // file was called, and what went into Content-Disposition.
  //
  // decodeURIComponent throws on a stray "%" (a legitimate "100% done.pdf"),
  // so a failed decode keeps the original rather than rejecting the name.
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    // Not percent-encoded, or not validly so — the raw name is the best we have.
  }
  // Both separators, so a Windows-style path can't smuggle a component past a
  // POSIX-only split.
  const base = decoded.split(/[/\\]/).pop() ?? "";
  const cleaned = base
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, "")
    .trim();
  // A leading dot is kept: the path split above already removed every
  // directory component, so stripping it was never the traversal defence — it
  // just mangled dotfiles. It also broke them outright, because the upload
  // route resolves the mime from this name and `.env` arriving as `env` looks
  // extensionless to resolveAttachmentMime, which then 415s a file the client
  // had already accepted. A name that is *only* dots has nothing left to be a
  // filename, so it falls back.
  if (!cleaned || /^\.+$/.test(cleaned)) return "file";
  return cleaned.length > MAX_FILENAME_LENGTH ? cleaned.slice(0, MAX_FILENAME_LENGTH) : cleaned;
}

/**
 * The "is this send well-formed" gate shared word-for-word by `chat.send`
 * and `agent.send` — pure so it's testable without a live socket. An
 * attachment-only message is valid (empty text is only an error when nothing
 * is attached either); returns the error string to send back, or null to
 * proceed.
 */
export function validateSendAttachments(content: unknown, attachments: unknown): string | null {
  const atts: unknown = attachments ?? [];
  if (!Array.isArray(atts) || atts.length > MAX_ATTACHMENTS) {
    return `Attach at most ${String(MAX_ATTACHMENTS)} files`;
  }
  // Elements too, not just the array. TypeScript's `string[]` on the wire type
  // is a claim about a JSON payload, not a fact, and the downstream ref check
  // is a regex — `RegExp.test` stringifies, so `[["<uuid>"]]` would otherwise
  // read as a valid uuid and reach a uuid-typed query.
  if (!atts.every((a: unknown) => typeof a === "string")) {
    return `Attach at most ${String(MAX_ATTACHMENTS)} files`;
  }
  if (typeof content !== "string" || (!content.trim() && atts.length === 0)) {
    return "Content required";
  }
  return null;
}

/**
 * What a turn's prompt was made of. Attribution has to happen server-side:
 * the agent ships its tool schemas in `body.tools`, which never appears in
 * `messages` at all, so no client-side estimate can ever account for it —
 * and on a small window that's the single largest slice.
 */
export type ContextCategory =
  | "system" /** System prompt. */
  | "tools" /** JSON tool schemas, sent out-of-band in `body.tools`. */
  | "summary" /** The newest compaction summary, replayed in place of everything before it. */
  | "history" /** Prior user + assistant turns replayed into the prompt. */
  | "reasoning" /** Prior thinking blocks re-fed. Legacy category — always 0 now. */
  | "tool_io" /** tool_call args + tool_result output. Unbounded; the runaway one. */
  | "current" /** The user message that triggered this turn. */
  | "response"; /** The reply just generated — measured, never apportioned. */

export interface ContextPart { category: ContextCategory; tokens: number }

export interface ContextBreakdown {
  /** `parts` sum to exactly this. Includes the response: it's in the window
   * now and will be in the next prompt, so the bar and the ring agree. */
  used_tokens: number;
  parts: ContextPart[];
  /** How many prior messages were actually replayed, and the cap that applied. */
  history_messages: number;
  history_limit: number;
  /** True when older turns had already been dropped by the cap. */
  history_truncated: boolean;
  /** The window the prompt was actually assembled against. Belt-and-braces on
   * top of the client's model-list refresh: it closes the races refresh can't
   * (refresh in flight, model changed mid-conversation, MOCK_INFERENCE). */
  window_tokens?: number | null;
}

export interface TurnUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  /**
   * Prompt-evaluation rate over the tokens actually evaluated. **Null when
   * the backend does not report how many that was** (LM Studio reports
   * nothing about caching anywhere), in which case there is no honest rate to
   * show — render `prompt_tokens` against `ttft_ms` instead. It must never be
   * derived as `prompt_tokens / ttft_ms`: a cached 30k-token prompt returns
   * its first token in ~400 ms, which that formula turns into "47,742 tok/s".
   */
  prompt_tps: number | null;
  gen_tps: number | null;
  total_ms: number;
  /** Wall-clock time to the first token — the prompt-evaluation cost, and the
   * honest thing to show beside `prompt_tokens` when `prompt_tps` is null. */
  ttft_ms?: number | null;
  /** Tokens the backend reported reusing from its KV cache. Null = the
   * backend does not report it, which is not the same as zero. */
  cached_tokens?: number | null;
  /** Tokens of this prompt that were a token-identical prefix of the previous
   * request — what we offered the backend to reuse. Computed by us, so it is
   * present on every backend; null only when there was no previous request.
   * Evidence about our own prompt, not proof the backend reused it. */
  reusable_tokens?: number | null;
  /**
   * Attachments this turn's prompt left out because their class's budget was
   * full. Absent when nothing was dropped — and absence must be read as "this
   * turn dropped nothing", never as "nothing is ever dropped", since a turn
   * that reported no usage at all carries no answer either way.
   *
   * A fact about this turn, deliberately, rather than a prediction about the
   * next one: it is exactly what was sent, so it cannot be wrong, and it
   * appears next to the answer it explains.
   */
  omitted_attachments?: AttachmentRef[];
  context?: ContextBreakdown;
}

export type StreamStatus = "active" | "complete" | "error" | "cancelled";

/**
 * What a `/compact` did. `saved_tokens = before - after` (floored at 0):
 * `after` is the backend's own `completion_tokens` for the summary — exact —
 * and `before` is the previous turn's `prompt + completion`, i.e. exactly what
 * the next prompt would have replayed. When no prior usage record existed to
 * measure `before` from, it's estimated and `before_estimated` says so — the
 * UI renders a `~` rather than passing an estimate off as a measurement.
 */
export interface CompactionStats {
  messages_compacted: number;
  before_tokens: number;
  after_tokens: number;
  saved_tokens: number;
  before_estimated: boolean;
  /** Set when the run refused without calling the model: a summary with
   * nothing after it, or a thread too short to bother. Costs zero tokens. */
  skipped?: "already_compacted" | "too_short";
  /** The user's steering text ("make sure to include …"), verbatim. */
  guidance?: string;
  /** True when the server started this compaction itself, because the prompt
   * crossed AUTO_COMPACT_THRESHOLD of the model's window. Surfaced so the card
   * can say so: a summary nobody asked for, appearing mid-conversation, is
   * confusing unless it explains itself. */
  auto?: boolean;
}

/**
 * Payload kinds appended to a stream's durable log. Chat and agent share one
 * envelope, and both surfaces are tool-capable — every kind can appear on
 * either stream. Every event that names a message carries `message_id`
 * (including tool calls/results — the client used to have to infer this via
 * a placeholder-promotion hack; it doesn't need to anymore).
 */
export type StreamEventKind =
  | {
      kind: "message.start";
      message_id: string;
      author_type: "user" | "assistant" | "tool" | "summary";
      parent_id: string | null;
      model?: string;
      /** User messages arrive already-complete and carry their full text here. */
      text?: string;
      /** User messages only — images ride here the same way `text` does. */
      attachments?: AttachmentRef[];
    }
  | { kind: "text.delta"; message_id: string; text: string }
  | { kind: "thinking.delta"; message_id: string; text: string }
  | {
      kind: "message.end";
      message_id: string;
      status: "complete" | "error" | "cancelled";
      usage?: TurnUsage;
      error?: string;
    }
  | { kind: "model.loading"; message_id: string }
  | { kind: "iteration"; n: number; max: number }
  | { kind: "tool.call"; message_id: string; call_id: string; tool: string; args: Record<string, unknown> }
  | { kind: "approval.request"; call_id: string; tool: string; args: Record<string, unknown> }
  | {
      kind: "tool.result";
      message_id: string;
      call_id: string;
      tool: string;
      output: string;
      ok: boolean;
      diff?: FileDiff[];
    }
  | { kind: "todos"; todos: Todo[] }
  /** Emitted once by a compact run, before its message.end — the stats the
   * card renders, attached to the summary message. */
  | ({ kind: "compaction"; message_id: string } & CompactionStats);

export interface StreamSnapshotMessage {
  message_id: string;
  author_type: "user" | "assistant" | "tool" | "summary";
  parent_id: string | null;
  model?: string;
  text: string;
  thinking: string;
  /** Present on user messages that carried images (folded from `message.start`). */
  attachments?: AttachmentRef[];
  /** Present on summary messages once their compaction event has landed. */
  compaction?: CompactionStats;
  tool_calls: {
    call_id: string;
    tool: string;
    args: Record<string, unknown>;
    output?: string;
    ok?: boolean;
    diff?: FileDiff[];
  }[];
  status: "streaming" | "complete" | "error" | "cancelled";
  usage?: TurnUsage;
  error?: string;
}

/** Everything-so-far, folded server-side from the durable log. The client
 * renders this instantly on subscribe, then applies live `stream.event`s
 * with `seq` greater than this snapshot's `seq`. */
export interface StreamSnapshot {
  messages: StreamSnapshotMessage[];
  // agent-only:
  iteration?: { n: number; max: number };
  todos?: Todo[];
  pending_approval?: { call_id: string; tool: string; args: Record<string, unknown> };
}

export type ServerMessage =
  | { type: "turn.started"; stream_id: string; conversation_id: string; user_message_id: string }
  | {
      type: "conv.streams";
      conversation_id: string;
      streams: { stream_id: string; status: StreamStatus; last_seq: number }[];
    }
  | {
      type: "stream.sync";
      stream_id: string;
      conversation_id: string;
      seq: number;
      status: StreamStatus;
      snapshot: StreamSnapshot;
    }
  | { type: "stream.event"; stream_id: string; conversation_id: string; seq: number; event: StreamEventKind }
  | {
      type: "stream.end";
      stream_id: string;
      conversation_id: string;
      seq: number;
      status: "complete" | "error" | "cancelled";
      usage?: TurnUsage;
      error?: string;
    }
  | { type: "agent.mode_changed"; mode: PermissionMode }
  | { type: "error"; error: string; conversation_id?: string; stream_id?: string };

export type ClientMessage =
  | {
      type: "chat.send";
      content: string;
      model?: string;
      conversation_id?: string;
      parent_id?: string;
      /** Refs from `POST /v1/files`. The server re-validates ownership. */
      attachments?: string[];
    }
  | {
      type: "agent.send";
      content: string;
      model?: string;
      mode?: PermissionMode;
      conversation_id?: string;
      parent_id?: string;
      /** Refs from `POST /v1/files`. The server re-validates ownership. */
      attachments?: string[];
    }
  /** Run a built-in slash command against an existing conversation. The
   * surface is implied by which socket this arrives on (chat vs agent), which
   * decides whose history loader the command sees. */
  | { type: "command.run"; command: string; conversation_id: string; model?: string; args?: string }
  /** cursors = last seq the client has already applied, per stream_id it knows about. */
  | { type: "stream.subscribe"; conversation_id: string; cursors?: Record<string, number> }
  | { type: "stream.stop"; stream_id: string }
  | { type: "agent.mode"; mode: PermissionMode }
  | { type: "agent.approve"; call_id: string }
  | { type: "agent.deny"; call_id: string };
