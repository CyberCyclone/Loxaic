/**
 * Custom image rows (#253): adding, pulling, checking, listing, and resolving
 * one for a sandbox.
 *
 * Every read here is scoped by owner: a person's id, or null for the shared
 * images an admin loads. A pull uses only its own scope's login (logins.ts),
 * and the digest it records is the only thing a container is ever made from.
 */
import type Docker from "dockerode";
import { and, asc, db, eq, isNull, sql } from "@loxaic/db";
import { sandboxImages } from "@loxaic/db/schema";
import { getSandboxSettings } from "../settings.ts";
import { engineKind } from "../sandbox/container-engine.ts";
import { authFor, type LoginOwner } from "./logins.ts";
import { formatReference, parseReference, repositoryName } from "./reference.ts";
import { chooseDigest, describePullFailure, pullImage, type PullProgress } from "./pull.ts";
import { labelRefusal, probeImage } from "./check.ts";
import { readCheck, scopeOf, type ImageCheck, type ImageScope } from "./access.ts";
import { redactSecrets } from "./login-secrets.ts";

export type ImageRow = typeof sandboxImages.$inferSelect;

export interface ImageLimits {
  memoryMb: number;
  cpus: number;
  pids: number;
  /**
   * Pass the host's `/dev/kvm` into this image's sandboxes (#320), so they can
   * run a hardware-accelerated VM — the Android emulator. Shared images only,
   * set by an admin, off by default; nothing else about the container changes
   * (no capability, no other device). Absent on rows that predate it: off.
   */
  kvm: boolean;
}

/** Today's defaults for every sandbox (container-engine.ts's DEFAULT_LIMITS). */
export const DEFAULT_IMAGE_LIMITS: ImageLimits = { memoryMb: 512, cpus: 1, pids: 100, kvm: false };

/** The bounds an admin may set a shared image's limits within. */
export const LIMIT_BOUNDS = {
  memoryMb: { min: 256, max: 65_536 },
  cpus: { min: 0.25, max: 64 },
  pids: { min: 64, max: 32_768 },
} as const;

export interface ImageView {
  id: string;
  scope: ImageScope;
  reference: string;
  label: string;
  status: "pulling" | "ready" | "failed";
  error: string | null;
  /** Whether a container can be made from it now: a good pull whose check
   * found nothing missing. Independent of `status`, so an update that fails
   * leaves a working image usable. */
  usable: boolean;
  digest: string | null;
  check: ImageCheck | null;
  limits: ImageLimits | null;
  pulledAt: string | null;
  progress: PullProgress | null;
}

export class ImageError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "ImageError";
    this.status = status;
  }
}

function ownerIs(owner: LoginOwner) {
  return owner === null ? isNull(sandboxImages.ownerId) : eq(sandboxImages.ownerId, owner);
}

/** Pulls in flight, by row id, with how far each has got and whose they are. */
const pulls = new Map<string, Promise<void>>();
const progress = new Map<string, PullProgress>();
const pullOwners = new Map<string, LoginOwner>();

/**
 * How much one person can ask this host to hold. Content stays on the engine
 * when a row is deleted (it may back another row), so these are what stops a
 * user under "everyone" from filling the disk Postgres and every sandbox
 * share. Shared images are an admin's, and not capped.
 */
export const MAX_PERSONAL_IMAGES = 25;
export const MAX_PULLS_PER_OWNER = 2;

function pullsFor(owner: LoginOwner): number {
  let n = 0;
  for (const o of pullOwners.values()) if (o === owner) n++;
  return n;
}

function assertCanPull(owner: LoginOwner): void {
  if (owner !== null && pullsFor(owner) >= MAX_PULLS_PER_OWNER) {
    throw new ImageError(
      `You already have ${String(MAX_PULLS_PER_OWNER)} images pulling; wait for one to finish.`,
      429,
    );
  }
}

export function readLimits(raw: unknown): ImageLimits | null {
  if (typeof raw !== "object" || raw === null) return null;
  const v = raw as Record<string, unknown>;
  const n = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : null);
  const memoryMb = n(v.memoryMb);
  const cpus = n(v.cpus);
  const pids = n(v.pids);
  if (memoryMb === null || cpus === null || pids === null) return null;
  return { memoryMb, cpus, pids, kvm: v.kvm === true };
}

export function toImageView(row: ImageRow): ImageView {
  const check = readCheck(row.check);
  return {
    id: row.id,
    scope: scopeOf(row),
    reference: row.reference,
    label: row.label,
    status: row.status === "ready" || row.status === "failed" ? row.status : "pulling",
    error: row.error,
    usable: Boolean(row.digest) && check !== null && check.missing.length === 0,
    digest: row.digest,
    check,
    limits: row.ownerId === null ? (readLimits(row.limits) ?? DEFAULT_IMAGE_LIMITS) : null,
    pulledAt: row.pulledAt?.toISOString() ?? null,
    progress: row.status === "pulling" ? (progress.get(row.id) ?? null) : null,
  };
}

export async function listImages(owner: LoginOwner): Promise<ImageView[]> {
  const rows = await db
    .select()
    .from(sandboxImages)
    .where(ownerIs(owner))
    .orderBy(asc(sandboxImages.label), asc(sandboxImages.id));
  return rows.map(toImageView);
}

export async function getImage(owner: LoginOwner, id: string): Promise<ImageRow | null> {
  if (!isUuid(id)) return null;
  const row = await db.query.sandboxImages.findFirst({ where: and(eq(sandboxImages.id, id), ownerIs(owner)) });
  return row ?? null;
}

/** Any image row by id, whatever its scope: for code that then decides with
 * access.ts whether the asker may use it. */
export async function findImage(id: string): Promise<ImageRow | null> {
  if (!isUuid(id)) return null;
  return (await db.query.sandboxImages.findFirst({ where: eq(sandboxImages.id, id) })) ?? null;
}

export function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

/**
 * Why custom images can't be used on this server right now, or null when
 * they can. Asks the engine itself, so it is async; `/v1/config` and every
 * route call it.
 */
export async function customImagesBlocked(): Promise<string | null> {
  const { mode } = getSandboxSettings();
  if (mode !== "container") return "Custom images need the container sandbox.";
  const { sandboxEngine } = await import("../sandbox/container-provider.ts");
  const found = await sandboxEngine().catch(() => null);
  if (!found) return "No container engine is reachable.";
  // Podman's Docker-compatible API may fall back to the host user's own
  // registry login when a pull sends none, which would hand that login to
  // everyone. Docker never does, so custom images are Docker-only.
  const kind = await engineKind(found.docker);
  if (kind !== "docker") return "Custom images need Docker as the container engine.";
  return null;
}

function cleanLabel(label: unknown, fallback: string): string {
  if (label === undefined || label === null || label === "") return fallback;
  if (typeof label !== "string") throw new ImageError("label must be text");
  // eslint-disable-next-line no-control-regex -- the point is to remove them.
  const trimmed = label.trim().replace(/[\u0000-\u001f\u007f]/g, "");
  if (trimmed.length === 0) return fallback;
  if (trimmed.length > 80) throw new ImageError("A label can be at most 80 characters.");
  return trimmed;
}

/** Validates admin limits over `base` (the row's current ones, on an
 * update); throws a sentence naming the bound that failed. A field left out
 * keeps its base value, so saving the sizes never turns KVM off. */
export function parseLimits(raw: unknown, base: ImageLimits = DEFAULT_IMAGE_LIMITS): ImageLimits {
  return { ...base, ...parseLimitsPatch(raw) };
}

/** The limits a request names, checked; the ones it leaves out are absent. */
export function parseLimitsPatch(raw: unknown): Partial<ImageLimits> {
  if (typeof raw !== "object" || raw === null) throw new ImageError("limits must be an object");
  const v = raw as Record<string, unknown>;
  const out: Partial<ImageLimits> = {};
  for (const key of ["memoryMb", "cpus", "pids"] as const) {
    if (v[key] === undefined) continue;
    const value = v[key];
    const { min, max } = LIMIT_BOUNDS[key];
    if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
      throw new ImageError(`${key} must be a number from ${String(min)} to ${String(max)}.`);
    }
    if (key !== "cpus" && !Number.isInteger(value)) throw new ImageError(`${key} must be a whole number.`);
    out[key] = value;
  }
  if (v.kvm !== undefined) {
    if (typeof v.kvm !== "boolean") throw new ImageError("kvm must be true or false.");
    out.kvm = v.kvm;
  }
  return out;
}

/** Adds an image for this owner and starts pulling it. */
export async function addImage(
  owner: LoginOwner,
  input: { reference: unknown; label?: unknown; limits?: unknown },
  createdBy: string,
): Promise<ImageView> {
  let parsed;
  try {
    parsed = parseReference(input.reference);
  } catch (err) {
    throw new ImageError((err as Error).message);
  }
  const reference = formatReference(parsed);
  const label = cleanLabel(input.label, reference);
  const limits = owner === null ? (input.limits === undefined ? DEFAULT_IMAGE_LIMITS : parseLimits(input.limits)) : null;
  if (owner !== null && input.limits !== undefined) throw new ImageError("Only shared images have limits.");
  if (owner !== null) {
    const [{ n }] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(sandboxImages)
      .where(eq(sandboxImages.ownerId, owner));
    if (n >= MAX_PERSONAL_IMAGES) {
      throw new ImageError(`You can have at most ${String(MAX_PERSONAL_IMAGES)} images; remove one first.`, 409);
    }
  }
  assertCanPull(owner);
  const inserted = await db
    .insert(sandboxImages)
    .values({ ownerId: owner, reference, label, status: "pulling", limits, createdBy })
    .onConflictDoNothing()
    .returning();
  const row = inserted.at(0);
  if (!row) throw new ImageError(`${reference} is already in the list.`, 409);
  void startPull(row.id, owner);
  return toImageView(row);
}

export async function updateImage(
  owner: LoginOwner,
  id: string,
  input: { label?: unknown; limits?: unknown },
): Promise<ImageView | null> {
  const row = await getImage(owner, id);
  if (!row) return null;
  const set: Partial<typeof sandboxImages.$inferInsert> = { updatedAt: new Date() };
  if (input.label !== undefined) set.label = cleanLabel(input.label, row.reference);
  if (input.limits !== undefined) {
    if (owner !== null) throw new ImageError("Only shared images have limits.");
    // Merged in the database: the KVM switch and the sizes are separate
    // requests, and one read here and written back whole would undo the
    // other's change when the two cross.
    // The defaults first, for a row stored before a field existed.
    const patch = parseLimitsPatch(input.limits);
    set.limits = sql`${JSON.stringify(DEFAULT_IMAGE_LIMITS)}::jsonb || coalesce(${sandboxImages.limits}, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb`;
  }
  const updated = await db
    .update(sandboxImages)
    .set(set)
    .where(and(eq(sandboxImages.id, id), ownerIs(owner)))
    .returning();
  const row2 = updated.at(0);
  return row2 ? toImageView(row2) : null;
}

/** Removes the row. The image's files stay on the engine: the same content may
 * back another row, someone else's included. */
export async function deleteImage(owner: LoginOwner, id: string): Promise<boolean> {
  if (!isUuid(id)) return false;
  const removed = await db
    .delete(sandboxImages)
    .where(and(eq(sandboxImages.id, id), ownerIs(owner)))
    .returning({ id: sandboxImages.id });
  return removed.length > 0;
}

/** Starts (again) the pull of an existing row. */
export async function repull(owner: LoginOwner, id: string): Promise<ImageView | null> {
  const row = await getImage(owner, id);
  if (!row) return null;
  if (!pulls.has(id)) {
    assertCanPull(owner);
    const updated = await db
      .update(sandboxImages)
      .set({ status: "pulling", error: null, updatedAt: new Date() })
      .where(eq(sandboxImages.id, id))
      .returning();
    void startPull(id, owner);
    const row2 = updated.at(0);
    return row2 ? toImageView(row2) : null;
  }
  return toImageView(row);
}

/**
 * Single flight per row: a second request while one runs joins it. Never
 * rejects: nothing awaits it (callers `void` it), and the server has no
 * unhandledRejection handler, so a throw here would end the process.
 * `pullAndCheck` records its own failures on the row.
 */
function startPull(id: string, owner: LoginOwner): Promise<void> {
  const existing = pulls.get(id);
  if (existing) return existing;
  const run: Promise<void> = pullAndCheck(id)
    .catch((err: unknown) => {
      console.error(`[images] pull of ${id} failed outside its own handling:`, err);
    })
    .finally(() => {
      if (pulls.get(id) === run) {
        pulls.delete(id);
        pullOwners.delete(id);
      }
      progress.delete(id);
    });
  pulls.set(id, run);
  pullOwners.set(id, owner);
  return run;
}

/** Test seam: waits for a row's pull to settle. */
export async function __waitForPull(id: string): Promise<void> {
  await pulls.get(id);
}

async function pullAndCheck(id: string): Promise<void> {
  let secret: string | null = null;
  try {
    // Inside the try, like everything else: a transient database error or a
    // stored reference that no longer parses fails this row, never the process.
    const row = await db.query.sandboxImages.findFirst({ where: eq(sandboxImages.id, id) });
    if (!row) return;
    const ref = parseReference(row.reference);
    const blocked = await customImagesBlocked();
    if (blocked) throw new Error(blocked);
    const { sandboxEngine } = await import("../sandbox/container-provider.ts");
    const { docker } = await sandboxEngine();
    const auth = await authFor(row.ownerId, ref.registry);
    secret = auth?.secret ?? null;
    let statuses: string[];
    try {
      statuses = await pullImage(docker, row.reference, auth, (p) => progress.set(id, p));
    } catch (err) {
      throw new Error(describePullFailure((err as Error).message, row.reference, ref.registry, secret));
    }
    const repository = repositoryName(ref);
    // The tag only for the fallback, which is reached only when the pull's
    // own status lines named no digest. Everything decided about the image is
    // then read from the pinned digest: the tag is shared with every row that
    // names it, and another pull can move it between our pull and this read.
    const tagged = statuses.some((line) => line.startsWith("Digest: "))
      ? []
      : (await docker.getImage(row.reference).inspect()).RepoDigests;
    const digest = chooseDigest(repository, statuses, tagged);
    if (!digest) throw new Error("The registry did not say which digest it sent, so the image can't be pinned.");
    const info = await docker.getImage(digest).inspect();
    const refused = labelRefusal(info.Config.Labels);
    if (refused) throw new Error(refused);
    const probe = await probeImage(docker, digest, row.ownerId ?? row.createdBy ?? "shared");
    if (probe.check.missing.length > 0) {
      throw new Error(`This image lacks what Loxaic's tools need: ${probe.check.missing.join(", ")}.`);
    }
    await db
      .update(sandboxImages)
      .set({
        status: "ready",
        error: null,
        digest,
        uid: probe.uid,
        gid: probe.gid,
        check: probe.check,
        pulledAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(sandboxImages.id, id));
  } catch (err) {
    const message = redactSecrets(err instanceof Error ? err.message : String(err), [secret]);
    await db
      .update(sandboxImages)
      .set({ status: "failed", error: message, updatedAt: new Date() })
      .where(eq(sandboxImages.id, id))
      .catch(() => undefined);
  }
}

/** At boot: a pull that was running when the process died will never finish. */
export async function failInterruptedPulls(): Promise<void> {
  await db
    .update(sandboxImages)
    .set({ status: "failed", error: "Interrupted by a server restart. Pull it again.", updatedAt: new Date() })
    .where(eq(sandboxImages.status, "pulling"))
    .catch(() => undefined);
}

/**
 * Makes sure a row's pinned image is on the engine before a container is made
 * from it — it may have been pruned — pulling it again, by digest, with the
 * row's own scope's login if not.
 */
export async function ensureImagePresent(docker: Docker, row: ImageRow): Promise<void> {
  if (!row.digest) throw new ImageError("That image has not been pulled successfully.");
  try {
    await docker.getImage(row.digest).inspect();
    return;
  } catch {
    // Not present: pull it below.
  }
  const ref = parseReference(row.reference);
  const auth = await authFor(row.ownerId, ref.registry);
  try {
    await pullImage(docker, row.digest, auth);
  } catch (err) {
    throw new ImageError(describePullFailure((err as Error).message, row.reference, ref.registry, auth?.secret ?? null));
  }
}

