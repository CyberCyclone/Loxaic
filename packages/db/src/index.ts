import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.ts";

const client = postgres(process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/shannon");
export const db = drizzle(client, { schema });

export { eq, and, or, not, isNull, isNotNull, inArray, desc, asc, gte, lte, gt, lt, sql, count, sum, avg } from "drizzle-orm";
export { migrate } from "drizzle-orm/postgres-js/migrator";
export { user, session, account, verification } from "./schema.ts";