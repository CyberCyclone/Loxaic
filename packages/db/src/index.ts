import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.ts";

type Db = ReturnType<typeof drizzle<typeof schema>>;

// The client is created lazily on first use, not at module load, so a
// supervisor (or test) can set DATABASE_URL after this module is imported
// but before any query runs.
let client: ReturnType<typeof postgres> | undefined;
let instance: Db | undefined;

function getDb(): Db {
  if (!instance) {
    client = postgres(process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/shannon");
    instance = drizzle(client, { schema });
  }
  return instance;
}

export const db: Db = new Proxy({} as Db, {
  get(_target, prop) {
    const real = getDb() as unknown as Record<PropertyKey, unknown>;
    const value = Reflect.get(real, prop);
    return typeof value === "function"
      ? (value as (...args: unknown[]) => unknown).bind(real)
      : value;
  },
  has: (_target, prop) => Reflect.has(getDb(), prop),
  ownKeys: () => Reflect.ownKeys(getDb()),
  getOwnPropertyDescriptor(_target, prop) {
    const desc = Reflect.getOwnPropertyDescriptor(getDb(), prop);
    if (desc) desc.configurable = true;
    return desc;
  },
});

/** Close the underlying connection pool (graceful shutdown). Safe to call
 * when no connection was ever opened; a later query reconnects. */
export async function closeDb(): Promise<void> {
  const c = client;
  client = undefined;
  instance = undefined;
  await c?.end({ timeout: 5 });
}

export { eq, and, or, not, isNull, isNotNull, inArray, desc, asc, gte, lte, gt, lt, sql, count, sum, avg } from "drizzle-orm";
export { migrate } from "drizzle-orm/postgres-js/migrator";
export { user, session, account, verification } from "./schema.ts";
