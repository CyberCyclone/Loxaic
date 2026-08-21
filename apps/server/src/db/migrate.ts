import { db, migrate } from "@shannon/db";

export async function runMigrations() {
  await migrate(db, { migrationsFolder: "../../packages/db/drizzle" });
}