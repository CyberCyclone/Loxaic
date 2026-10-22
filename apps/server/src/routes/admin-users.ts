import type { FastifyInstance } from "fastify";
import { count, db, desc, eq, ilike, inArray, or, user } from "@loxaic/db";
import { userSandboxAllocations } from "@loxaic/db/schema";
import {
  AllocationInputError,
  allocationFor,
  clearAllocationOverride,
  resolveAllocation,
  setAllocationOverride,
  usageOf,
  type AllocationUsage,
} from "../agent/allocation.ts";
import { runningRowsForUsers, runningUsage } from "../agent/sandbox-manager.ts";
import { getSandboxSettings, type SandboxAllocation } from "../settings.ts";
import { requireAdmin } from "../auth/middleware";
import { isBanned } from "../auth/ban.ts";
import { resetUserPassword, UserNotFoundError } from "../auth/password-reset.ts";

/**
 * A bound, not a page. A deployment with more accounts than this is searched
 * rather than scrolled, and `total` is returned so the screen can say the list
 * is not all of them — a cap that silently hid the newest accounts would hide
 * exactly the person who just registered and cannot sign in.
 */
const MAX_USERS = 200;

/**
 * Accounts on this deployment, and the one thing an admin can do to them from
 * here: reset a forgotten password.
 *
 * The list is a directory, which `GET /v1/users/search` deliberately is not
 * (a prefix search capped at ten, for picking someone to share with). That is
 * acceptable only behind `requireAdmin`, on every route. No field that is or
 * derives from a password is ever selected.
 */
export function adminUserRoutes(app: FastifyInstance) {
  app.get("/v1/admin/users", async (request, reply) => {
    await requireAdmin(request, reply);
    // Type-checked rather than coerced: `?q[]=a` arrives as an array.
    const raw = (request.query as { q?: unknown }).q;
    const q = typeof raw === "string" ? raw.trim() : "";
    // Substring, not prefix: an admin looking for someone is not the
    // "is this person here" question /v1/users/search answers. Wildcards are
    // still escaped, so `%` searches for a percent sign.
    const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const where = q ? or(ilike(user.email, like), ilike(user.name, like)) : undefined;
    const [rows, [{ n }]] = await Promise.all([
      db
        .select({
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
          banned: user.banned,
          banExpires: user.banExpires,
          mustChangePassword: user.mustChangePassword,
          createdAt: user.createdAt,
        })
        .from(user)
        .where(where)
        // Newest first: the account most likely to need a hand is the one
        // that was just made.
        .orderBy(desc(user.createdAt), desc(user.id))
        .limit(MAX_USERS),
      db.select({ n: count() }).from(user).where(where),
    ]);
    const sandbox = await sandboxSummaries(rows.map((r) => r.id));
    // `banned` means what the middleware enforces: an expired ban is lifted.
    return {
      users: rows.map(({ banExpires, ...r }) => ({
        ...r,
        banned: isBanned({ banned: r.banned, banExpires }),
        sandbox: sandbox.get(r.id),
      })),
      total: n,
    };
  });

  /**
   * Overrides one user's sandbox allocation (#254). Each field is a value,
   * null to follow the server-wide default again, or absent to leave alone.
   * Lowering it pauses nothing: it only refuses their next start.
   */
  app.put<{ Params: { id: string } }>("/v1/admin/users/:id/sandbox-allocation", async (request, reply) => {
    await requireAdmin(request, reply);
    if (!(await userExists(request.params.id))) return reply.code(404).send({ error: "User not found" });
    try {
      await setAllocationOverride(request.params.id, request.body);
    } catch (err) {
      if (err instanceof AllocationInputError) return reply.code(err.status).send({ error: err.message });
      throw err;
    }
    return sandboxSummary(request.params.id);
  });

  /** Puts one user back on the server-wide default allocation. */
  app.delete<{ Params: { id: string } }>("/v1/admin/users/:id/sandbox-allocation", async (request, reply) => {
    await requireAdmin(request, reply);
    if (!(await userExists(request.params.id))) return reply.code(404).send({ error: "User not found" });
    await clearAllocationOverride(request.params.id);
    return sandboxSummary(request.params.id);
  });

  /**
   * Replaces the password with a temporary one, which this response is the
   * only place it ever exists — never log it. The user is signed out of every
   * device and must choose a new password at next sign-in.
   *
   * An admin may reset their own: it signs them out here too, and the client
   * hides the button on their own row because Account is the right tool for
   * that. The reset-password CLI is the route for an admin locked out entirely.
   */
  app.post<{ Params: { id: string } }>("/v1/admin/users/:id/reset-password", async (request, reply) => {
    await requireAdmin(request, reply);
    try {
      return await resetUserPassword(request.params.id);
    } catch (err) {
      if (err instanceof UserNotFoundError) {
        reply.code(404);
        return { error: "User not found" };
      }
      throw err;
    }
  });
}

interface SandboxSummary {
  allocation: SandboxAllocation;
  overridden: Record<keyof SandboxAllocation, boolean>;
  used: AllocationUsage;
}

async function userExists(id: string): Promise<boolean> {
  const rows = await db.select({ id: user.id }).from(user).where(eq(user.id, id)).limit(1);
  return rows.length > 0;
}

async function sandboxSummary(userId: string): Promise<SandboxSummary> {
  const [resolved, used] = await Promise.all([allocationFor(userId), runningUsage(userId)]);
  return { ...resolved, used };
}

/**
 * Every listed user's allocation and what their running sandboxes hold, in
 * two queries rather than two per user: the list is up to MAX_USERS long.
 * Resolved the same way `allocationFor` resolves one user's, and summed the
 * same way the allocation check sums (`rowNeed`), so the list and the
 * refusal can never disagree.
 */
async function sandboxSummaries(userIds: string[]): Promise<Map<string, SandboxSummary>> {
  const out = new Map<string, SandboxSummary>();
  if (userIds.length === 0) return out;
  const settings = getSandboxSettings();
  const [overrides, running] = await Promise.all([
    db.select().from(userSandboxAllocations).where(inArray(userSandboxAllocations.userId, userIds)),
    runningRowsForUsers(userIds),
  ]);
  const byUser = new Map(overrides.map((row) => [row.userId, row]));
  for (const id of userIds) {
    const resolved = resolveAllocation(byUser.get(id), settings.allocation, settings.envOverrides.maxRunning);
    out.set(id, { ...resolved, used: usageOf(running.filter((row) => row.ownerId === id)) });
  }
  return out;
}
