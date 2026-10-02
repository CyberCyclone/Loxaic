/**
 * How hard a model is asked to think, as the composer's `+` menu offers it.
 *
 * One word per level here and in the UI; each backend has its own word for it
 * on the wire (`ModelThinking.wire`), and a model is only ever offered the
 * levels it is known to accept — the same rule OpenCode follows, so nothing a
 * backend would refuse is ever sent.
 */
export type ThinkingLevel = "None" | "Low" | "Medium" | "High";

export const THINKING_LEVELS: readonly ThinkingLevel[] = ["None", "Low", "Medium", "High"];

/**
 * What a send that names no level gets, for a model that takes one. Not the
 * model's own default: Qwen3.8's chat template falls back to its highest
 * effort ("xhigh") when nothing is sent, and a single PR review on the beta
 * spent two and a half hours generating at it.
 */
export const DEFAULT_THINKING_LEVEL: ThinkingLevel = "Medium";

/**
 * A model's thinking control. Absent from `ModelInfo` on a model that takes
 * none (and from an older server); the client then offers no levels.
 *
 * - `levels`: what the picker offers, in `THINKING_LEVELS` order. `None` only
 *   when the model can be told not to think.
 * - `toggle`: the model can only be switched on or off. `levels` is then
 *   `["None", "Medium"]`, shown as Off / On.
 * - `dialect` and `wire`: how a level reaches the backend. Server-side detail,
 *   carried here so one object describes the model everywhere.
 */
export interface ModelThinking {
  levels: ThinkingLevel[];
  toggle: boolean;
  dialect: "llama" | "openai" | "openrouter";
  /** The backend's word for each offered level other than `None`. */
  wire: Partial<Record<ThinkingLevel, string>>;
}

export function isThinkingLevel(v: unknown): v is ThinkingLevel {
  return typeof v === "string" && (THINKING_LEVELS as readonly string[]).includes(v);
}

/**
 * The level a model will really be asked for: `wanted` when it offers that,
 * otherwise the nearest level it does offer — the cheaper of two equally near,
 * since thinking more than asked costs time and thinking less only costs
 * depth. A toggle model hears only "off" (`None`) or "on" (`Medium`).
 */
export function effectiveThinkingLevel(thinking: ModelThinking, wanted: ThinkingLevel): ThinkingLevel {
  if (thinking.toggle) return wanted === "None" && thinking.levels.includes("None") ? "None" : "Medium";
  if (thinking.levels.includes(wanted)) return wanted;
  const target = THINKING_LEVELS.indexOf(wanted);
  let best: ThinkingLevel | null = null;
  let bestDistance = Infinity;
  for (const level of thinking.levels) {
    const distance = Math.abs(THINKING_LEVELS.indexOf(level) - target);
    // `<` keeps the first, i.e. the lower, of two at the same distance.
    if (distance < bestDistance) {
      best = level;
      bestDistance = distance;
    }
  }
  return best ?? wanted;
}
