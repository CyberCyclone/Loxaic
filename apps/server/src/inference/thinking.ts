import { THINKING_LEVELS, effectiveThinkingLevel, type ModelThinking, type ThinkingLevel } from "@loxaic/types";

/**
 * Which thinking levels a model takes, and what a level becomes on the wire.
 *
 * Modelled on OpenCode: every model carries the list of levels it is known to
 * accept, worked out once when the model is listed, and a model with no list
 * is sent no field at all — a hosted API answers a field it does not know with
 * a 400, and a chat template rejects an effort it does not name (Qwen3.8's
 * raises "Unexpected reasoning effort"). Unlike OpenCode, a host model's list
 * comes from its own chat template rather than a table keyed on its name.
 */

/** Every effort word a backend or template is known to use, cheapest first. */
const KNOWN_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/**
 * The longest chat template read, from either producer (a GGUF header, a
 * provider's `/props`). Real templates are a few to a few tens of KB.
 */
export const MAX_CHAT_TEMPLATE_CHARS = 1024 * 1024;

/**
 * The bodies of a template's Jinja tags (`{% … %}`, `{{ … }}`), in order.
 *
 * A hand-rolled scan rather than a regex: a lazy `[\s\S]*?` has to run to the
 * end of the input before it can fail at an opener that never closes, so a
 * template of unterminated `{%` was quadratic — 2.3 s for 128 KB, minutes at
 * the cap, all of it on the event loop. Here each closer is searched for once
 * per opener kind: once a kind's closer is known to be absent from a point on,
 * no later opener of that kind is tried.
 */
function* tagBodies(template: string): Generator<string> {
  let pos = 0;
  let stmtClosed = true;
  let exprClosed = true;
  for (;;) {
    const stmt = stmtClosed ? template.indexOf("{%", pos) : -1;
    const expr = exprClosed ? template.indexOf("{{", pos) : -1;
    if (stmt === -1 && expr === -1) return;
    const isStmt = expr === -1 || (stmt !== -1 && stmt < expr);
    const open = isStmt ? stmt : expr;
    const close = template.indexOf(isStmt ? "%}" : "}}", open + 2);
    if (close === -1) {
      if (isStmt) stmtClosed = false;
      else exprClosed = false;
      pos = open + 2;
      continue;
    }
    yield template.slice(open + 2, close);
    pos = close + 2;
  }
}

const LITERAL_RE = /'([^'\\]*)'|"([^"\\]*)"/g;

/**
 * A model's control from its chat template, or null for a template with none.
 *
 * - `reasoning_effort` referenced → graded levels. The words offered are the
 *   effort literals in the tags that mention it. A template that **validates**
 *   the value (a `not in` test, or `raise_exception` beside it) accepts exactly
 *   those words and nothing else; one that only reads it (gpt-oss renders
 *   "Reasoning: {{ reasoning_effort }}") takes low/medium/high as well.
 * - `enable_thinking` referenced → the model can be told not to think, which
 *   is what `None` sends (llama.cpp turns `reasoning_effort: "none"` into
 *   `enable_thinking = false`). Alone, without efforts, it is an on/off toggle.
 *
 * Pure and linear in the template's length (see `tagBodies`): it is a
 * stranger's file, or a stranger's HTTP response.
 */
export function thinkingFromTemplate(template: string | null | undefined): ModelThinking | null {
  if (!template || template.length > MAX_CHAT_TEMPLATE_CHARS) return null;
  const takesEffort = template.includes("reasoning_effort");
  const takesToggle = template.includes("enable_thinking");
  if (!takesEffort && !takesToggle) return null;
  if (!takesEffort) return { levels: ["None", "Medium"], toggle: true, dialect: "llama", wire: {} };

  const words = new Set<string>();
  let validates = false;
  for (const body of tagBodies(template)) {
    if (!body.includes("reasoning_effort")) continue;
    if (/\bnot\s+in\b/.test(body) || body.includes("raise_exception")) validates = true;
    for (const lit of body.matchAll(LITERAL_RE)) {
      // One of the two groups matched: the single- or the double-quoted one.
      const word = (lit.slice(1).find((g) => typeof g === "string") ?? "").trim().toLowerCase();
      if ((KNOWN_EFFORTS as readonly string[]).includes(word)) words.add(word);
    }
  }
  if (!validates) for (const w of ["low", "medium", "high"]) words.add(w);
  const thinking = fromEffortWords("llama", [...words], takesToggle);
  return thinking.levels.length > 0 ? thinking : null;
}

/**
 * The levels a set of effort words supports, and the word each level sends.
 * `None` comes from the word "none" or, on llama.cpp, from `canTurnOff`.
 */
function fromEffortWords(dialect: ModelThinking["dialect"], words: string[], canTurnOff: boolean): ModelThinking {
  const has = (w: string) => words.includes(w);
  const pick = (...candidates: string[]) => candidates.find(has);
  const wire: Partial<Record<ThinkingLevel, string>> = {};
  const low = pick("low", "minimal");
  const medium = pick("medium");
  const high = pick("high", "xhigh", "max");
  if (low) wire.Low = low;
  if (medium) wire.Medium = medium;
  if (high) wire.High = high;
  const offNone = has("none") || canTurnOff;
  if (offNone) wire.None = "none";
  const levels = THINKING_LEVELS.filter((l) => wire[l] !== undefined);
  return { levels, toggle: false, dialect, wire };
}

/**
 * OpenAI's reasoning models, by id. A table, so it goes stale as models
 * arrive — the same trade OpenCode makes (`openaiReasoningEfforts`), and the
 * only signal there is: OpenAI's `/models` says nothing about reasoning.
 *
 * - o1 / o3 / o4-mini and gpt-5 take low/medium/high.
 * - gpt-5.1 and later also take "none"; older ones answer it with a 400.
 * - gpt-5-pro takes "high" only.
 * - Chat variants (`gpt-5-chat-latest`), o1-mini and o1-preview take nothing.
 */
export function openAiThinking(id: string): ModelThinking | null {
  const name = id.toLowerCase().replace(/^openai\//, "");
  if (/(^|-)chat(-|$)/.test(name) || /^o1-(mini|preview)/.test(name)) return null;
  if (/^o[134](-|$)/.test(name)) return fromEffortWords("openai", ["low", "medium", "high"], false);
  const gpt = /^gpt-(\d+)(?:\.(\d+))?/.exec(name);
  if (!gpt) return null;
  const major = Number(gpt[1]);
  const minor = gpt[2] ? Number(gpt[2]) : 0;
  if (major < 5) return null;
  if (/-pro(-|$)/.test(name)) return fromEffortWords("openai", ["high"], false);
  const newer = major > 5 || minor >= 1;
  return fromEffortWords("openai", newer ? ["none", "low", "medium", "high"] : ["low", "medium", "high"], false);
}

/**
 * OpenRouter says per model whether it takes `reasoning`
 * (`supported_parameters`). `None` is not offered: some reasoning models
 * cannot be switched off, and the listing does not say which.
 */
export function openRouterThinking(supportedParameters: unknown): ModelThinking | null {
  if (!Array.isArray(supportedParameters) || !supportedParameters.includes("reasoning")) return null;
  return fromEffortWords("openrouter", ["low", "medium", "high"], false);
}

/**
 * The request-body fields for a level, or `{}` for a model that takes none.
 * The level is clamped to one the model offers first, so a word the backend
 * would refuse is never sent.
 *
 * - llama.cpp: `reasoning_effort`, which it forwards to the chat template, and
 *   which it reads as `enable_thinking = false` when it is "none". A toggle
 *   model's "on" is `chat_template_kwargs.enable_thinking = true`.
 * - OpenAI: `reasoning_effort`.
 * - OpenRouter: `reasoning.effort`.
 *
 * With llama.cpp the level is rendered into the *system prompt*, so these
 * fields are part of the prompt prefix: everything that must extend a
 * conversation's cached prefix (a compaction, a context-stage warm-up) sends
 * exactly the fields its last run did (request-shape.ts).
 */
export function thinkingFields(
  thinking: ModelThinking | null | undefined,
  wanted: ThinkingLevel,
): Record<string, unknown> {
  if (!thinking || thinking.levels.length === 0) return {};
  const level = effectiveThinkingLevel(thinking, wanted);
  switch (thinking.dialect) {
    case "llama":
      // Both words for off: b11149 and later read `reasoning_effort: "none"` as
      // `enable_thinking = false`, and the template kwarg also reaches an added
      // provider running a build that predates that.
      if (level === "None") return { reasoning_effort: "none", chat_template_kwargs: { enable_thinking: false } };
      if (thinking.toggle) return { chat_template_kwargs: { enable_thinking: true } };
      return thinking.wire[level] ? { reasoning_effort: thinking.wire[level] } : {};
    case "openai":
      return thinking.wire[level] ? { reasoning_effort: thinking.wire[level] } : {};
    case "openrouter":
      return thinking.wire[level] ? { reasoning: { effort: thinking.wire[level] } } : {};
  }
}
