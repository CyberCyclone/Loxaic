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
import { db, eq, sql } from "@loxaic/db";
import { hosts, serverSettings } from "@loxaic/db/schema";
import { serverVersion } from "./version.ts";

const CLUSTER_KEY = "cluster";

/**
 * The cluster's display name. Not user-settable — nothing writes this row but
 * `ensureCluster` — so it is purely the product brand, and a stored value that
 * disagrees is a stale brand rather than someone's choice to preserve.
 *
 * That is why `ensureCluster` refreshes it. The name is minted once, so a
 * database that booted before a brand change would otherwise keep announcing
 * the old one — over `GET /v1/cluster`, the desktop `loxaic:probeHost` reply,
 * and the join screen a client sees before signing in. The cluster *id* is
 * the identity here and is never rewritten; the name is a label.
 */
const CLUSTER_NAME = "Loxaic";

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
    cached = { id: stored.id, name: CLUSTER_NAME };
    if (stored.name !== CLUSTER_NAME) {
      await db
        .update(serverSettings)
        .set({ value: cached })
        .where(eq(serverSettings.key, CLUSTER_KEY));
    }
    return cached;
  }

  const minted: ClusterIdentity = { id: randomUUID(), name: CLUSTER_NAME };
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
  // Reports the current brand even for a row `ensureCluster` has not repaired
  // yet, but never writes: this is reached by an unauthenticated route, and
  // boot is where the row is fixed.
  cached = { id: stored.id, name: CLUSTER_NAME };
  return cached;
}

/**
 * Registers this instance in `hosts` and starts its heartbeat.
 *
 * Keyed on `LOXAIC_INSTANCE_ID` — the desktop install's stable id, carried
 * across mode changes — so a Solo→Host switch updates this machine's row
 * instead of registering the same machine a second time. Without that env var
 * (a bare `pnpm dev`, a Compose deployment) nothing registers: an instance
 * with no durable identity would otherwise mint a new host row on every
 * restart and litter the cluster with ghosts.
 */
export async function registerHost(): Promise<string | null> {
  const id = process.env.LOXAIC_INSTANCE_ID;
  if (!id) return null;

  await ensureCluster();
  const name = process.env.LOXAIC_HOST_NAME ?? "Loxaic Host";
  const advertiseUrl = process.env.LOXAIC_ADVERTISE_URL ?? `http://localhost:${process.env.PORT ?? "4000"}`;
  // The built-in backend is this host's own llama.cpp router, on a loopback
  // port that changes every start — nothing another host could use. The column
  // stays for rows written before, and is cleared on the next registration.
  const inferenceBaseUrl = null;
  const version = serverVersion();

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
