/**
 * Cluster identity and host registration.
 *
 * A "cluster" is simply the set of server instances sharing one database.
 * That is the whole definition, and it is deliberate: the cluster's id lives
 * in `server_settings`, so pointing an instance at a different database makes
 * it part of a different cluster by construction — there is no membership
 * protocol to get wrong, and "changing the database creates a new cluster"
 * needs no enforcement code.
 *
 * Today exactly one host registers. Phase 4 (#78) makes the list plural; this
 * module is shaped so that only `listHosts` consumers change when it does.
 */
import { randomUUID } from "node:crypto";
import { db, eq, sql } from "@shannon/db";
import { hosts, serverSettings } from "@shannon/db/schema";

const CLUSTER_KEY = "cluster";

/** Refresh interval for this instance's heartbeat. Comfortably under the
 * staleness window a reader would apply, so a live host is never mistaken for
 * a departed one because of one slow tick. */
const HEARTBEAT_MS = 30_000;

/** A host whose heartbeat is older than this is treated as gone: its models
 * stop being offered. Its rows stay — conversations outlive their host. */
export const HOST_STALE_MS = 2 * 60_000;

export interface ClusterIdentity {
  id: string;
  name: string;
}

export interface HostView {
  id: string;
  name: string;
  advertiseUrl: string;
  inferenceBaseUrl: string | null;
  version: string | null;
  lastHeartbeatAt: string;
  /** False once the heartbeat is older than HOST_STALE_MS. */
  online: boolean;
  /** True for the instance serving this request. */
  self: boolean;
}

let cached: ClusterIdentity | null = null;
let selfHostId: string | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Reads the cluster identity, minting it on first boot against an empty
 * database. The insert is `onConflictDoNothing` + re-read rather than a plain
 * insert: two instances booting simultaneously against a fresh database must
 * converge on one id, not race to overwrite each other.
 */
export async function ensureCluster(): Promise<ClusterIdentity> {
  if (cached) return cached;
  const existing = await db.query.serverSettings.findFirst({
    where: eq(serverSettings.key, CLUSTER_KEY),
  });
  const stored = existing?.value as Partial<ClusterIdentity> | undefined;
  if (stored?.id) {
    cached = { id: stored.id, name: stored.name ?? "Shannon" };
    return cached;
  }

  const minted: ClusterIdentity = { id: randomUUID(), name: "Shannon" };
  await db
    .insert(serverSettings)
    .values({ key: CLUSTER_KEY, value: minted })
    .onConflictDoNothing();
  const row = await db.query.serverSettings.findFirst({
    where: eq(serverSettings.key, CLUSTER_KEY),
  });
  const winner = (row?.value as Partial<ClusterIdentity> | undefined) ?? minted;
  cached = { id: winner.id ?? minted.id, name: winner.name ?? minted.name };
  return cached;
}

/**
 * The cluster identity if one exists, without minting. For request paths that
 * must not write — `ensureCluster` is called at boot, so by the time any
 * request arrives this is a cache hit or a single read; an unauthenticated
 * route should never be the thing that drives an insert.
 */
export async function getCluster(): Promise<ClusterIdentity | null> {
  if (cached) return cached;
  const existing = await db.query.serverSettings.findFirst({
    where: eq(serverSettings.key, CLUSTER_KEY),
  });
  const stored = existing?.value as Partial<ClusterIdentity> | undefined;
  if (!stored?.id) return null;
  cached = { id: stored.id, name: stored.name ?? "Shannon" };
  return cached;
}

/**
 * Registers this instance in `hosts` and starts its heartbeat.
 *
 * Keyed on `SHANNON_INSTANCE_ID` — the desktop install's stable id, carried
 * across mode changes — so a Solo→Host switch updates this machine's row
 * instead of registering the same machine a second time. Without that env var
 * (a bare `pnpm dev`, a Compose deployment) nothing registers: an instance
 * with no durable identity would otherwise mint a new host row on every
 * restart and litter the cluster with ghosts.
 */
export async function registerHost(): Promise<string | null> {
  const id = process.env.SHANNON_INSTANCE_ID;
  if (!id) return null;

  await ensureCluster();
  const name = process.env.SHANNON_HOST_NAME ?? "Shannon Host";
  const advertiseUrl = process.env.SHANNON_ADVERTISE_URL ?? `http://localhost:${process.env.PORT ?? "4000"}`;
  const inferenceBaseUrl = process.env.INFERENCE_BASE_URL ?? null;
  // SHANNON_VERSION is what the desktop supervisor passes; npm_package_version
  // is what `pnpm dev` sets. Neither reaching here used to mean the column was
  // always null — and the upsert never refreshed it, so even a value that did
  // arrive was frozen at first registration.
  const version = process.env.SHANNON_VERSION ?? process.env.npm_package_version ?? null;

  await db
    .insert(hosts)
    .values({ id, name, advertiseUrl, inferenceBaseUrl, version })
    .onConflictDoUpdate({
      target: hosts.id,
      set: { name, advertiseUrl, inferenceBaseUrl, version, lastHeartbeatAt: new Date() },
    });

  selfHostId = id;
  heartbeatTimer ??= setInterval(() => {
    void db
      .update(hosts)
      .set({ lastHeartbeatAt: new Date() })
      .where(eq(hosts.id, id))
      .catch(() => undefined);
  }, HEARTBEAT_MS);
  heartbeatTimer.unref();
  return id;
}

export function stopHeartbeat(): void {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = null;
}

/** This instance's host id, or null when it registered none. */
export function currentHostId(): string | null {
  return selfHostId;
}

export async function listHosts(): Promise<HostView[]> {
  const rows = await db.select().from(hosts).orderBy(sql`${hosts.createdAt} asc`);
  const now = Date.now();
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    advertiseUrl: row.advertiseUrl,
    inferenceBaseUrl: row.inferenceBaseUrl,
    version: row.version,
    lastHeartbeatAt: row.lastHeartbeatAt.toISOString(),
    online: now - row.lastHeartbeatAt.getTime() < HOST_STALE_MS,
    self: row.id === selfHostId,
  }));
}

/** The host serving this process, for labelling models it offers. */
export async function selfHost(): Promise<HostView | null> {
  if (!selfHostId) return null;
  const all = await listHosts();
  return all.find((h) => h.self) ?? null;
}

/** Test seam — the module-level caches outlive a single test otherwise. */
export function __resetClusterForTest(): void {
  cached = null;
  selfHostId = null;
  stopHeartbeat();
}
