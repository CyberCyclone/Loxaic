import { createServer } from "node:http";
import { db, eq } from "@loxaic/db";
import { localModels } from "@loxaic/db/schema";
import { invalidateLocalModelCache } from "../../llama/catalog.ts";
import { routerModelName } from "../../llama/preset.ts";
import { resetSlotProbe } from "../scheduler.ts";

/** One model the fake router knows. */
export interface FakeRouterModel {
  /** llama.cpp's `--parallel` for it while loaded; null for one that is not
   * loaded, which the router's `/props` refuses. */
  slots: number | null;
  /** A model id to answer for without making it a servable local model: the
   * mock backend's own, which must keep being answered by the mock. Left out,
   * a `local_models` row is made under this suite's own host id. */
  id?: string;
}

/**
 * Makes the built-in backend a router that reports each model's slots the way
 * a real one does: attached over HTTP, answering `/props?model=` with
 * `total_slots` for a loaded model and a 400 for any other. Driven through the
 * real probes rather than a module mock, for the reason scheduler.test.ts
 * gives. Returns the models' ids in the order given, how often each was asked
 * about, and the undo.
 */
export async function reportBackendSlots(
  models: FakeRouterModel[],
): Promise<{ ids: string[]; asked: (id: string) => number; undo: () => Promise<void> }> {
  const byName = new Map<string, { id: string; slots: number | null }>();
  const asked = new Map<string, number>();
  const server = createServer((req, res) => {
    const name = new URL(req.url ?? "/", "http://127.0.0.1").searchParams.get("model");
    const model = name === null ? undefined : byName.get(name);
    if (model) asked.set(model.id, (asked.get(model.id) ?? 0) + 1);
    const slots = model?.slots ?? null;
    if (slots === null) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "model is not loaded" } }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ total_slots: slots }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const host = `test-backend-slots-${String(port)}`;
  const previous = { mode: process.env.LLAMA_MODE, url: process.env.LLAMA_ROUTER_URL, host: process.env.LOXAIC_INSTANCE_ID };
  process.env.LLAMA_MODE = "attach";
  process.env.LLAMA_ROUTER_URL = `http://127.0.0.1:${String(port)}`;
  process.env.LOXAIC_INSTANCE_ID = host;
  const ids: string[] = [];
  for (const [i, model] of models.entries()) {
    const id = model.id ?? `slots/m${String(i)}-${String(port)}:Q4`;
    ids.push(id);
    byName.set(routerModelName(id), { id, slots: model.slots });
    if (model.id !== undefined) continue;
    await db.insert(localModels).values({
      id,
      hostId: host,
      repo: `slots/m${String(i)}`,
      revision: "0".repeat(40),
      quant: "Q4",
      files: [],
      sizeBytes: 0,
      status: "ready",
      enabled: true,
      displayName: `m${String(i)}`,
      publisher: "slots",
    });
  }
  invalidateLocalModelCache();
  resetSlotProbe();
  const put = (key: "LLAMA_MODE" | "LLAMA_ROUTER_URL" | "LOXAIC_INSTANCE_ID", value: string | undefined): void => {
    if (value === undefined) Reflect.deleteProperty(process.env, key);
    else process.env[key] = value;
  };
  return {
    ids,
    asked: (id) => asked.get(id) ?? 0,
    undo: async () => {
      put("LLAMA_MODE", previous.mode);
      put("LLAMA_ROUTER_URL", previous.url);
      put("LOXAIC_INSTANCE_ID", previous.host);
      await db.delete(localModels).where(eq(localModels.hostId, host));
      invalidateLocalModelCache();
      resetSlotProbe();
      await new Promise<void>((resolve) => server.close(() => { resolve(); }));
    },
  };
}
