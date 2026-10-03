import path from "node:path";
import { getLocalModelRow, mtpSource, rowMtpHead, type LocalModelRow } from "./catalog.ts";
import { effectiveSettings } from "./context-stages.ts";
import { modelLoadFailureReason } from "./router.ts";

/**
 * What a person is told when llama.cpp could not load a host model.
 *
 * The router itself answers only `model name=… failed to load`, which names
 * nothing anyone can act on. The cause is in the model's own output
 * (`modelLoadFailureReason`), and the most likely culprit among the settings
 * an admin chose is multi-token prediction: llama.cpp's support differs by
 * model and by build. Qwen3.8-Flash-Next with unsloth's MTP head dies at load
 * with `GGML_ASSERT(buffer) failed` in b11342 (ggml-org/llama.cpp#29811),
 * while a patched llama.cpp runs it. So nothing refuses a combination ahead of
 * time; a load that fails says why, and what to change.
 */

/** The router's own words for a model it could not load
 * (`server-models.cpp`: `"model name=" + name + " failed to load"`), and only
 * those: b11342 also says "Failed to load image or audio file" about a
 * request's attachment, from a model that loaded fine. */
export function isLoadFailure(message: string): boolean {
  return /\bmodel name=\S+ failed to load\b/.test(message);
}

/** Pure, for the sentence's tests: `reason` is the line from the model's own
 * log, or null when there is none to quote. */
export function loadFailureMessage(row: Pick<LocalModelRow, "displayName" | "meta" | "mtpHead" | "loadSettings" | "contextStages" | "activeStage">, reason: string | null): string {
  const name = row.displayName;
  const head = rowMtpHead(row);
  const source = mtpSource(row);
  const drafting = effectiveSettings(row).mtp === true && (source === "embedded" || source === "head");
  const why = reason ? ` (${reason})` : "";
  const first = `${name} could not be loaded: llama.cpp stopped while loading it${why}.`;
  if (drafting) {
    const withHead = source === "head" && head ? `, drafting with ${path.basename(head.path)}` : "";
    return `${first} It loads with multi-token prediction on${withHead}, which this llama.cpp may not support for this model. An admin can turn multi-token prediction off in Settings › Host models › ${name}.`;
  }
  return `${first} An admin can check its load settings in Settings › Host models › ${name}.`;
}

/** The sentence for a failed load of host model `id`, or null when `raw` is
 * not a load failure (or the model is gone). */
export async function describeLoadFailure(id: string, raw: string): Promise<string | null> {
  if (!isLoadFailure(raw)) return null;
  const row = await getLocalModelRow(id).catch(() => null);
  if (!row) return null;
  return loadFailureMessage(row, modelLoadFailureReason(id));
}
