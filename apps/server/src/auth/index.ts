import { betterAuth } from "better-auth";
import { admin, bearer } from "better-auth/plugins";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { count, db, user, session, account, verification } from "@shannon/db";

const ADMIN_EMAILS = new Set(
  (process.env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
);

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