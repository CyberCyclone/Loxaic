import path from "node:path";
import { db, migrate } from "@shannon/db";

export async function runMigrations() {
  // MIGRATIONS_DIR lets a supervisor (Electron packaged build) point at the
  // shipped copy of packages/db/drizzle; the default stays cwd-relative and
  // only resolves when cwd is apps/server (the Dockerfile sets WORKDIR for it).
  const folder =
    process.env.MIGRATIONS_DIR ??
    path.resolve(process.cwd(), "../../packages/db/drizzle");
  await migrate(db, { migrationsFolder: folder });
}
