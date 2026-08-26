import { betterAuth } from "better-auth";
import { bearer } from "better-auth/plugins";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { db, user, session, account, verification } from "@shannon/db";

// Extra origins to trust beyond the built-in dev defaults below — e.g. the
// stable stack's LAN/tailnet URL, set via TRUSTED_ORIGINS in .env.prod.
const extraTrustedOrigins = (process.env.TRUSTED_ORIGINS ?? "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

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
    ...extraTrustedOrigins,
  ],
});