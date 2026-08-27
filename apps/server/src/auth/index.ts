import { betterAuth } from "better-auth";
import { bearer } from "better-auth/plugins";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { db, user, session, account, verification } from "@shannon/db";

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
  plugins: [bearer()],
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