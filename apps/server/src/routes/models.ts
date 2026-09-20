import type { FastifyInstance } from "fastify";
import { db } from "@loxaic/db";
import { modelRegistry } from "@loxaic/db/schema";
import { authenticate, requireAdmin } from "../auth/middleware";
import { listBackendModels } from "../inference/models";

export function modelRoutes(app: FastifyInstance) {
  /**
   * Authenticated, unlike before providers existed.
   *
   * The list now names every backend an admin configured and carries each
   * provider's label — which is deployment topology, not public information.
   * Every client already sends a bearer here (`getModels` goes through
   * `authedFetch`), so nothing in the wild loses access.
   */
  app.get("/v1/models", async (request, reply) => {
    await authenticate(request, reply);
    return listBackendModels();
  });

  app.get("/v1/model-registry", async (request, reply) => {
    await authenticate(request, reply);
    return db.select().from(modelRegistry);
  });

  // Was unauthenticated: anyone who could reach the server could write rows
  // here. Nothing in the app calls it, so admin-only costs no caller.
  app.post("/v1/model-registry", async (request, reply) => {
    await requireAdmin(request, reply);
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
