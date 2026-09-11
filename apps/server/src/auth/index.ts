import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { admin, bearer } from "better-auth/plugins";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { count, db, user, session, account, verification } from "@loxaic/db";

const ADMIN_EMAILS = new Set(
  (process.env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
);

/**
 * Why creating an account is refused right now, or null when it is allowed.
 *
 * With Funnel on, this server's whole API is on the public internet, and the
 * sign-up route is unauthenticated by nature — so an open one hands an
 * account (and a container sandbox with `bash`) to any stranger who finds
 * the address, which is in Certificate Transparency logs the moment the
 * certificate is issued. Worse, the first account ever created is made
 * admin below: a host that flipped Funnel on before registering would hand
 * that to whoever got there first, and admin is host-mode code execution.
 *
 * So registration is closed while Funnel is on. Create your account over
 * the LAN or the private tailnet first; the desktop sets LOXAIC_FUNNEL only
 * while the Funnel switch is on. Pure and exported so the policy is tested
 * without a sign-up round trip or a mutation of the shared process.env.
 */
export function signUpClosedReason(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.LOXAIC_FUNNEL === "1") {
    return "Creating accounts is switched off while this server is published to the internet. Turn Funnel off to create one, then turn it back on.";
  }
  return null;
}

export const auth = betterAuth({
  secret: process.env.BETTER_AUTH_SECRET,
  baseURL: process.env.BETTER_AUTH_URL ?? "http://localhost:4000",
  database: drizzleAdapter(db, {
    provider: "pg",
    schema: { user, session, account, verification },
  }),
  emailAndPassword: {
    enabled: true,
  },
  // Lets sign-in/sign-up's raw session token be reused directly as an
  // `Authorization: Bearer <token>` header — used by REST auth middleware,
  // WebSocket `?token=` auth, and native clients that have no cookie jar.
  plugins: [bearer(), admin()],
  databaseHooks: {
    user: {
      create: {
        // First-ever user (or one listed in ADMIN_EMAILS) becomes admin.
        // The count check races under concurrent first sign-ups — acceptable
        // for a self-hosted app; ADMIN_EMAILS or a manual `UPDATE "user" SET
        // role='admin'` covers recovery/upgrade of an existing deployment.
        before: async (data: { email: string }) => {
          const closed = signUpClosedReason();
          if (closed) throw new APIError("FORBIDDEN", { message: closed });
          // ADMIN_EMAILS first: an in-memory Set lookup, and the branch this
          // feature exists to serve — no reason to make the recovery path pay
          // for a full-table COUNT whose answer can't change the outcome.
          if (ADMIN_EMAILS.has(data.email.toLowerCase())) return { data: { role: "admin" } };
          const [{ n }] = await db.select({ n: count() }).from(user);
          if (n === 0) return { data: { role: "admin" } };
        },
      },
    },
  },
  trustedOrigins: [
    "http://localhost:5173",
    "http://localhost:4000",
    "http://localhost:4001",
    // The packaged Electron renderer's origin (electron-serve app:// scheme).
    "app://-",
    ...(process.env.TRUSTED_ORIGINS?.split(",")
      .map((s) => s.trim())
      .filter(Boolean) ?? []),
  ],
});