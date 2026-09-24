import type { FileDiff } from "./index";
import type { TimeoutBasis } from "./waits";

/** Duplicated (structurally, not nominally) from @loxaic/agent so this
 * package stays dependency-free — packages/agent is the authority for
 * agent-loop *logic* (toolRequiresApproval etc.), this is only the wire shape. */
export type PermissionMode = "planning" | "manual" | "auto";

export interface Todo { id?: string; text: string; status: "pending" | "in_progress" | "completed" }

/** Why a run stopped to ask whether to keep going: it reached the end of its
 * step window, or it noticed itself repeating the same calls. */
export type CheckinReason = "budget" | "loop";

/** The answer to a `steps.checkin`. Stopping is not one of these — that is the
 * existing `stream.stop`, which any run can be sent at any time. */
export type StepsDecision = "continue" | "answer";

/**
 * When a wait for a person runs out, carried on the event that starts the wait
 * and on the snapshot's pending entry — so a client can show a countdown, and
 * one that reconnects mid-wait still can.
 *
 * All optional: an older server sends none of them, and a client must then
 * show no countdown at all rather than guess one.
 */
export interface WaitDeadlineFields {
  /** How long the wait lasts, in ms — the value the server's timer uses. */
  timeout_ms?: number;
  /** When it runs out, in the *server's* epoch ms. A reconnecting client
   * corrects for its own clock with `stream.sync.server_now`. */
  expires_at?: number;
  /** Why it is that long: the user's setting, or stretched to fit this run's
   * slowest model request. */
  timeout_basis?: TimeoutBasis;
}

/**
 * What an unattended check-in did, recorded where a client can find it.
 *
 * An unanswered check-in that carries on leaves nothing in the transcript —
 * no message is written, deliberately, because anything persisted as a message
 * would enter the prompt. This is how a client can still say "nobody answered,
 * so it kept going": folded onto the assistant message whose tools the
 * check-in followed, from the stream's own log.
 */
export interface CheckinDecisionNote {
  decision: StepsDecision;
  by: "user" | "timeout";
  /** The step the check-in happened at. */
  n?: number;
  /** Timeout only: 1-based position in the unanswered streak. */
  unattended?: number;
  /** Timeout only: how many unanswered check-ins carry on before it wraps up. */
  auto_continues?: number;
}

/**
 * Persisted as a user message when a check-in is answered with "answer now",
 * and pushed into the live prompt at the same position.
 *
 * Fixed text, never interpolated, and exported so both paths use the identical
 * string: it becomes part of the conversation's replay, and the prompt prefix
 * only stays cacheable if the live push and the next turn's history load
 * produce the same bytes (see prompt-prefix.test.ts).
 */
export const CHECKIN_ANSWER_NUDGE =
  "Please stop using tools and give your best final answer now from what you have so far.";

/**
 * What a planning run's plan panel sends (#199). Each decision is an ordinary
 * message from the person who pressed the button — accepting starts a run in a
 * working mode, a suggestion or a rejection stays in planning — so the
 * decision is in the transcript for every device and every reload, and a
 * plan's status is read back from the reply that follows it.
 *
 * Fixed text, never interpolated, for that reading back: the client matches on
 * these exact strings. Rejecting costs one short model reply, deliberately —
 * without one, the next message would put two user rows in a row, which some
 * chat templates refuse.
 */
export const PLAN_ACCEPTED_MESSAGE = "I accept this plan. Go ahead and implement it.";
export const PLAN_REJECTED_MESSAGE =
  "I'm rejecting this plan — don't implement it. Wait for my next message before doing anything else.";

/**
 * Persisted as a user row when a planning turn answers in prose (#199): the
 * server asks, once, for a plan or questions, and sends that one request with
 * `tool_choice: "required"`. Fixed text, never interpolated, for the reason
 * CHECKIN_ANSWER_NUDGE is — the next turn has to replay it byte for byte —
 * and so the client can render it as a notice rather than as something the
 * user typed. Its row's author is null: nobody typed it.
 */
export const PLAN_REQUIRED_NUDGE =
  "Finish by calling propose_plan with your plan, or ask_questions if you need answers from me first.";

/**
 * The first line of the message the questions panel sends (#199). The rest is
 * one numbered line per question with its answer; the client builds it
 * (formatAnswers in apps/mobile/lib/plan.ts) and reads it back to render a
 * question set as answered.
 */
export const QUESTIONS_ANSWERED_PREFIX = "Answers to your questions:";

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
      /**
       * The row's position in the engine's replay order — the same `lamport`
       * the history route sorts by. A thread now loads a page at a time
       * (#213), so a snapshot can describe a run older than everything a
       * client has loaded; this is what lets the client place it, or leave it
       * for scroll-back, instead of appending it after the newest message.
       * Absent from an older server.
       */
      lamport?: number;
      model?: string;
      /** User messages arrive already-complete and carry their full text here. */
      text?: string;
      /** User messages only — images ride here the same way `text` does. */
      attachments?: AttachmentRef[];
      /**
       * Who wrote a message the *server* inserted on someone's behalf — today
       * only the check-in "answer now" instruction. A user id when a person
       * pressed the button; **null when nobody did** (the check-in timed out).
       * Absent on every other message and from an older server, which a
       * client must read as "not told", never as either answer.
       */
      author_user_id?: string | null;
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
  /**
   * The model request behind `message_id` has finished and this is what it
   * cost. Emitted once per request, the moment it completes — so it can arrive
   * long before that message's `message.end`, which a tool-calling message
   * defers until its tool results (and any approval) have landed. Without it
   * the context meter had nothing to show until the whole turn ended (#193).
   */
  | { kind: "message.usage"; message_id: string; usage: TurnUsage }
  | { kind: "model.loading"; message_id: string }
  /**
   * This run is waiting for an inference slot, and is `position` places from
   * the front (1 = next to run).
   *
   * Re-emitted as the queue moves, so a waiting client counts down rather than
   * showing one number that goes stale. One number, not a place plus a
   * separate "runs ahead" count: with more than one slot those two differ, and
   * a client only ever renders the place.
   */
  | { kind: "run.queued"; position: number }
  | { kind: "iteration"; n: number; max: number }
  /**
   * The run has paused to ask whether to keep going. It has given its
   * inference slot back and is waiting for a `agent.steps` answer, exactly as
   * it does at a tool approval — so this is not a failure, and the tool
   * results already in the transcript are real and stay.
   *
   * `n` is the iteration just finished; `max` is the current window's end
   * (absolute, so it grows on each "keep going": 100, then 200).
   */
  | {
      kind: "steps.checkin";
      n: number;
      max: number;
      reason: CheckinReason;
      /** `loop` only: the repeating unit, oldest first — tool names alone.
       * Not the arguments: an `fs_write` loop is exactly what this exists to
       * catch, and its args carry the file content, which would then sit in
       * the 24h record log and be re-sent in every resync's snapshot for a
       * banner that reads nothing but `tool`. */
      pattern?: { tool: string }[];
    } & WaitDeadlineFields & {
      /** What happens if nobody answers before `expires_at`. */
      on_timeout?: StepsDecision;
      /** How many check-ins in a row had already gone unanswered before this one. */
      unattended?: number;
      /** How many unanswered check-ins carry on by themselves before it wraps up. */
      auto_continues?: number;
    }
  /** How a `steps.checkin` was answered. Emitted *before* the run re-enters
   * the inference queue, so a catching-up client never sees a stale check-in
   * beside a queue position. The fields beyond `decision` and `by` are those
   * of `CheckinDecisionNote`. */
  | ({ kind: "steps.decision" } & CheckinDecisionNote)
  | { kind: "tool.call"; message_id: string; call_id: string; tool: string; args: Record<string, unknown> }
  | ({ kind: "approval.request"; call_id: string; tool: string; args: Record<string, unknown> } & WaitDeadlineFields)
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
  | ({ kind: "compaction"; message_id: string } & CompactionStats)
  | ({ kind: "prompt.stats" } & PromptStats);

export interface StreamSnapshotMessage {
  message_id: string;
  author_type: "user" | "assistant" | "tool" | "summary";
  parent_id: string | null;
  /** Folded from `message.start` — see its doc. Absent from an older server. */
  lamport?: number;
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
  /** Folded from `message.start` when present — see its doc. */
  author_user_id?: string | null;
  /** Set on the assistant message a check-in followed, when nobody answered
   * it — the only trace an unattended "keep going" leaves. */
  checkin_decision?: CheckinDecisionNote;
}

/**
 * What a model request is about to cost, sent before the request goes out —
 * the only evidence a person has, for the minutes a big prompt can take to
 * evaluate, that "Processing prompt…" is work and not a hang.
 *
 * Emit-only: computed from what the engine already measures before every
 * request, so nothing about the prompt itself changes. Every figure is an
 * estimate and is labelled as one; `null` always means "not known", never 0.
 */
export interface PromptStats {
  message_id: string;
  /** Estimated prompt size in tokens. */
  prompt_tokens_est: number;
  /** `measured_prefix`: the previous request's measured size plus an estimate
   * of what was appended — the usual case, and close. `estimate`: characters
   * over a per-kind ratio, for a first request or a broken prefix. */
  est_basis: "measured_prefix" | "estimate";
  /** Tokens repeated exactly from the previous request — what the backend was
   * offered to reuse. 0 is a real measurement (the prefix broke); null is
   * "no previous request to compare with". */
  reusable_tokens: number | null;
  window_tokens: number | null;
  /** Estimated time to evaluate the part not reusable, from this deployment's
   * recent prompt-processing rate for the model. Null when there is no rate
   * yet (a fresh server, a new model) or the model is loading first. */
  eta_ms: number | null;
  /** Server epoch ms the request was sent. */
  started_at: number;
  /** The one measured part: what the backend itself reports about this
   * request while evaluating it (llama.cpp's `return_progress`). `prompt.stats`
   * is re-emitted, throttled, as it moves. **Absent** when the backend reports
   * nothing — LM Studio and every hosted API today — and absence means "we
   * were not told": the estimates above stand. Never null- or zero-filled. */
  progress?: PromptProgress;
}

/** A backend's own account of how far prompt evaluation has got. */
export interface PromptProgress {
  /** The prompt as the backend tokenised it — not an estimate. */
  total_tokens: number;
  /** What the backend actually reused from its cache — ground truth, unlike
   * `reusable_tokens`, which is what we offered. */
  cached_tokens: number;
  /** Evaluated so far, cached tokens included. */
  processed_tokens: number;
  /** The backend's own clock since it started on this request. */
  elapsed_ms: number;
  /** Time left at the rate measured so far on this request. Null until enough
   * has been evaluated to call it a rate. */
  remaining_ms: number | null;
}

/** Everything-so-far, folded server-side from the durable log. The client
 * renders this instantly on subscribe, then applies live `stream.event`s
 * with `seq` greater than this snapshot's `seq`. */
export interface StreamSnapshot {
  messages: StreamSnapshotMessage[];
  /** Present while the run is still waiting for an inference slot. Cleared as
   * soon as it starts, so a client that reconnects mid-queue sees the wait and
   * one that reconnects mid-answer does not. */
  queued?: { position: number };
  // agent-only:
  iteration?: { n: number; max: number };
  todos?: Todo[];
  pending_approval?: { call_id: string; tool: string; args: Record<string, unknown> } & WaitDeadlineFields;
  /** Present from just before a model request until its first output — so a
   * client reconnecting fifteen minutes into prompt evaluation is told what
   * is being evaluated, not just that something is. */
  prompt_stats?: PromptStats;
  /** Present while the run is parked at a step check-in waiting for an answer.
   * Both surfaces carry it — chat and agent share one tool loop. */
  pending_checkin?: {
    n: number;
    max: number;
    reason: CheckinReason;
    pattern?: { tool: string }[];
    on_timeout?: StepsDecision;
    unattended?: number;
    auto_continues?: number;
  } & WaitDeadlineFields;
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
      /** The server's clock when this was sent, so a client can turn a
       * snapshot's `expires_at` into a countdown on its own clock. */
      server_now?: number;
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
  | { type: "agent.deny"; call_id: string }
  /** Answer a `steps.checkin`. Keyed by `stream_id`, not by a model-supplied
   * id like approve/deny — a run has at most one check-in outstanding, and
   * stream ids are ours and unique, so no plural lookup is needed. */
  | { type: "agent.steps"; stream_id: string; decision: StepsDecision };
