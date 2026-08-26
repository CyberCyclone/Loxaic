import type { FastifyInstance } from "fastify";
import { db } from "@shannon/db";
import { modelRegistry } from "@shannon/db/schema";
import { listBackendModels } from "../inference/models";

export function modelRoutes(app: FastifyInstance) {
  app.get("/v1/models", async () => listBackendModels());

  app.get("/v1/model-registry", async () => {
    return db.select().from(modelRegistry);
  });

  app.post("/v1/model-registry", async (request) => {
    const { id, display_name, gguf_url, location } = request.body as {
      id: string; display_name: string; gguf_url?: string; location?: "server" | "device" | "both";
    };
    const [r] = await db.insert(modelRegistry).values({
      id, displayName: display_name, ggufUrl: gguf_url ?? null,
      location: location ?? "server",
    }).onConflictDoUpdate({ target: modelRegistry.id, set: { displayName: display_name } }).returning();
    return r;
  });
}