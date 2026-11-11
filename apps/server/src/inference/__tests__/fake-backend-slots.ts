import { createServer } from "node:http";
import { db, eq } from "@loxaic/db";
import { localModels } from "@loxaic/db/schema";
import { invalidateLocalModelCache } from "../../llama/catalog.ts";
import { resetSlotProbe } from "../scheduler.ts";

/**
 * Makes the built-in backend report `slots` (llama.cpp's `--parallel`), the
 * way a real one does: a router attached over HTTP that answers `/props` with
 * `total_slots`, serving this suite's one model under its own host id. Driven
 * through the real probe rather than a module mock, for the reason
 * scheduler.test.ts gives. Returns the undo.
 */
export async function reportBackendSlots(slots: number): Promise<() => Promise<void>> {
  const server = createServer((_req, res) => {
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
  await db.insert(localModels).values({
    id: `slots/one-${String(port)}:Q4`,
    hostId: host,
    repo: "slots/one",
    revision: "0".repeat(40),
    quant: "Q4",
    files: [],
    sizeBytes: 0,
    status: "ready",
    enabled: true,
    displayName: "one",
    publisher: "slots",
  });
  invalidateLocalModelCache();
  resetSlotProbe();
  const put = (key: "LLAMA_MODE" | "LLAMA_ROUTER_URL" | "LOXAIC_INSTANCE_ID", value: string | undefined): void => {
    if (value === undefined) Reflect.deleteProperty(process.env, key);
    else process.env[key] = value;
  };
  return async () => {
    put("LLAMA_MODE", previous.mode);
    put("LLAMA_ROUTER_URL", previous.url);
    put("LOXAIC_INSTANCE_ID", previous.host);
    await db.delete(localModels).where(eq(localModels.hostId, host));
    invalidateLocalModelCache();
    resetSlotProbe();
    await new Promise<void>((resolve) => server.close(() => { resolve(); }));
  };
}
