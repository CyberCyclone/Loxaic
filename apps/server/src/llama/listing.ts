import type { ModelInfo } from "@loxaic/types";
import { listServableModels, rowMeta, type LocalModelRow } from "./catalog.ts";
import { perRequestWindow, type LoadSettings } from "./load-settings.ts";
import { routerEndpoint, routerModelProps, routerModelStatuses, type RouterModelStatus } from "./router.ts";

/**
 * The built-in provider's models, as the picker and the run path see them.
 *
 * The list is **our** rows — downloaded and enabled — never whatever the
 * router happens to list, so a model an admin has not enabled cannot appear
 * (and `resolveModelRef` refuses it at send time as well). The router only
 * contributes live state: whether each model is loaded, and the window it was
 * actually allocated.
 */

interface ProviderStamp {
  id: string;
  name: string;
}

function toModelInfo(
  provider: ProviderStamp,
  row: LocalModelRow,
  live: { loaded: boolean; nCtx: number | null },
): ModelInfo {
  const settings = (row.loadSettings ?? {}) as LoadSettings;
  const meta = rowMeta(row);
  const trained = meta.nCtxTrain ?? null;
  const configured = typeof settings.ctxSize === "number" ? settings.ctxSize : null;
  // Before a load, predict the per-request window from the settings; once
  // loaded, the router's own per-slot figure wins (see perRequestWindow).
  const predicted = configured ?? trained;
  const predictedWindow = predicted !== null ? perRequestWindow(settings, predicted) : null;
  const window = live.nCtx ?? predictedWindow;
  return {
    id: row.id,
    display_name: row.displayName,
    quant: row.quant,
    format: "gguf",
    context_tokens: window ?? 8192,
    max_context_tokens: trained ?? window ?? 8192,
    loaded_context_tokens: live.nCtx,
    context_source: live.nCtx !== null ? "loaded" : configured !== null ? "max" : trained !== null ? "trained" : "default",
    location: "server",
    host_id: null,
    host_name: null,
    price: 0,
    loaded: live.loaded,
    provider_id: provider.id,
    provider_name: provider.name,
    upstream_id: row.id,
  };
}

export async function listLocalModelInfos(provider: ProviderStamp): Promise<ModelInfo[]> {
  const rows = await listServableModels();
  if (rows.length === 0) return [];
  const statuses = routerEndpoint() ? await routerModelStatuses() : new Map<string, RouterModelStatus>();
  return Promise.all(
    rows.map(async (row) => {
      const loaded = statuses.get(row.id)?.value === "loaded";
      const props = loaded ? await routerModelProps(row.id) : null;
      return toModelInfo(provider, row, { loaded, nCtx: props?.nCtx ?? null });
    }),
  );
}

/**
 * How many runs the built-in provider may hold at once, or null for "cannot
 * say" (the scheduler's floor of 1).
 *
 * One model: its slot count, as llama.cpp reports it once loaded, or its
 * `parallel` setting before. Several models: null, which the scheduler reads
 * as **1**. Runs on different models
 * served side by side would make the router load the second one while the
 * first is mid-generation — with `modelsMax` at 1 that evicts it — which is
 * the invisible over-estimate the scheduler's floor exists to prevent. An admin
 * who knows better pins the concurrency in Settings.
 */
export async function builtinSlots(): Promise<number | null> {
  const rows = await listServableModels();
  if (rows.length !== 1 || !routerEndpoint()) return null;
  const only = rows[0];
  const props = await routerModelProps(only.id);
  if (props?.totalSlots) return props.totalSlots;
  const parallel = (only.loadSettings as LoadSettings | null)?.parallel;
  return typeof parallel === "number" ? parallel : null;
}
