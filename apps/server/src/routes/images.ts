/**
 * Custom sandbox images (#253): registry logins and saved images, in two
 * scopes that share every handler and differ only in who they belong to.
 *
 * - `/v1/images/mine/…`: the caller's own. Owner only, with no admin bypass —
 *   an admin's own images are as private as anyone's, and nobody else's are
 *   reachable here at all.
 * - `/v1/admin/images/…`: the shared ones an admin loads for everyone, pulled
 *   with the deployment's logins, which are entered here and nowhere else.
 *
 * `GET /v1/images` is what the new-chat chooser offers: the shared images and
 * the caller's own that the policy allows and that can run.
 *
 * Listing and deleting stay open when the policy no longer allows a scope, so
 * someone can still see and clear what they added; adding, pulling and saving
 * a login do not.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { authenticate, requireAdmin } from "../auth/middleware";
import { getSandboxSettings } from "../settings.ts";
import { manageRefusal, hasGit, scopeAllowed, type ImageScope } from "../images/access.ts";
import { deleteLogin, listLogins, saveLogin, type LoginOwner } from "../images/logins.ts";
import { parseRegistry, ReferenceError } from "../images/reference.ts";
import { redactSecrets } from "../images/login-secrets.ts";
import {
  addImage,
  customImagesBlocked,
  deleteImage,
  ImageError,
  listImages,
  repull,
  updateImage,
} from "../images/store.ts";

interface ScopeDef {
  scope: ImageScope;
  prefix: string;
  /** Authenticates, and answers who owns this scope's rows. */
  resolve(request: FastifyRequest, reply: FastifyReply): Promise<{ userId: string; owner: LoginOwner }>;
}

const SCOPES: ScopeDef[] = [
  {
    scope: "personal",
    prefix: "/v1/images/mine",
    async resolve(request, reply) {
      const userId = await authenticate(request, reply);
      return { userId, owner: userId };
    },
  },
  {
    scope: "shared",
    prefix: "/v1/admin/images",
    async resolve(request, reply) {
      const userId = await requireAdmin(request, reply);
      return { userId, owner: null };
    },
  },
];

function fail(reply: FastifyReply, status: number, error: string) {
  reply.code(status);
  return { error };
}

/** Whether this scope may be added to or pulled right now; sends the refusal
 * and returns false when not. */
async function mayWrite(reply: FastifyReply, scope: ImageScope): Promise<boolean> {
  const refusal = manageRefusal(getSandboxSettings().customImages, scope, scope === "shared");
  if (refusal) {
    reply.code(403).send({ error: refusal });
    return false;
  }
  const blocked = await customImagesBlocked();
  if (blocked) {
    reply.code(409).send({ error: blocked });
    return false;
  }
  return true;
}

function imageError(reply: FastifyReply, err: unknown) {
  if (err instanceof ImageError) return fail(reply, err.status, err.message);
  if (err instanceof ReferenceError) return fail(reply, 400, err.message);
  throw err;
}

function text(value: unknown, field: string, max: number): string {
  if (typeof value !== "string") throw new ImageError(`${field} must be text`);
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new ImageError(`${field} is required`);
  if (trimmed.length > max) throw new ImageError(`${field} is too long`);
  // eslint-disable-next-line no-control-regex -- the point is to reject them.
  if (/[\x00-\x1f\x7f]/.test(trimmed)) throw new ImageError(`${field} cannot contain control characters`);
  return trimmed;
}

export function imageRoutes(app: FastifyInstance) {
  app.get("/v1/images", async (request, reply) => {
    const userId = await authenticate(request, reply);
    const policy = getSandboxSettings().customImages;
    if (policy === "off" || (await customImagesBlocked())) return { images: [] };
    const shared = scopeAllowed(policy, "shared") ? await listImages(null) : [];
    const own = scopeAllowed(policy, "personal") ? await listImages(userId) : [];
    return {
      images: [...shared, ...own]
        .filter((img) => img.usable)
        .map((img) => ({
          id: img.id,
          scope: img.scope,
          label: img.label,
          reference: img.reference,
          // GitHub workspaces need git; the chooser says why one is disabled.
          hasGit: hasGit({ ownerId: null, digest: img.digest, check: img.check }),
        })),
    };
  });

  for (const def of SCOPES) {
    app.get(`${def.prefix}/logins`, async (request, reply) => {
      const { owner } = await def.resolve(request, reply);
      return { logins: await listLogins(owner) };
    });

    app.put(`${def.prefix}/logins`, async (request, reply) => {
      const { userId, owner } = await def.resolve(request, reply);
      if (!(await mayWrite(reply, def.scope))) return;
      const body = (request.body ?? {}) as { registry?: unknown; username?: unknown; password?: unknown };
      const password = typeof body.password === "string" ? body.password : "";
      try {
        const registry = parseRegistry(body.registry ?? "");
        const username = text(body.username, "username", 256);
        if (password.length === 0) throw new ImageError("password is required");
        if (password.length > 8192) throw new ImageError("password is too long");
        return await saveLogin(owner, { registry, username, secret: password }, userId);
      } catch (err) {
        if (err instanceof ImageError || err instanceof ReferenceError) {
          return fail(reply, 400, redactSecrets(err.message, [password]));
        }
        throw err;
      }
    });

    app.delete<{ Params: { id: string } }>(`${def.prefix}/logins/:id`, async (request, reply) => {
      const { owner } = await def.resolve(request, reply);
      if (!/^[0-9a-f-]{36}$/i.test(request.params.id) || !(await deleteLogin(owner, request.params.id))) {
        return fail(reply, 404, "Not found");
      }
      return { ok: true };
    });

    app.get(def.prefix, async (request, reply) => {
      const { owner } = await def.resolve(request, reply);
      return { images: await listImages(owner) };
    });

    app.post(def.prefix, async (request, reply) => {
      const { userId, owner } = await def.resolve(request, reply);
      if (!(await mayWrite(reply, def.scope))) return;
      const body = (request.body ?? {}) as { reference?: unknown; label?: unknown; limits?: unknown };
      try {
        return await addImage(owner, { ...body, reference: body.reference }, userId);
      } catch (err) {
        return imageError(reply, err);
      }
    });

    app.patch<{ Params: { id: string } }>(`${def.prefix}/:id`, async (request, reply) => {
      const { owner } = await def.resolve(request, reply);
      const body = (request.body ?? {}) as { label?: unknown; limits?: unknown };
      try {
        const updated = await updateImage(owner, request.params.id, body);
        return updated ?? fail(reply, 404, "Not found");
      } catch (err) {
        return imageError(reply, err);
      }
    });

    app.post<{ Params: { id: string } }>(`${def.prefix}/:id/pull`, async (request, reply) => {
      const { owner } = await def.resolve(request, reply);
      if (!(await mayWrite(reply, def.scope))) return;
      const view = await repull(owner, request.params.id);
      return view ?? fail(reply, 404, "Not found");
    });

    app.delete<{ Params: { id: string } }>(`${def.prefix}/:id`, async (request, reply) => {
      const { owner } = await def.resolve(request, reply);
      if (!(await deleteImage(owner, request.params.id))) return fail(reply, 404, "Not found");
      return { ok: true };
    });
  }
}
