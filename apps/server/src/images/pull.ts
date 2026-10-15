/**
 * Pulling an image with one scope's login, and naming exactly what was pulled.
 *
 * A pull always asks the registry, even for an image already on disk, and the
 * registry refuses a private image to anyone without a login it accepts —
 * which is why a pull is the access check, and why the digest it reports is
 * the only thing a container may be made from (see access.ts).
 */
import type Docker from "dockerode";
import type { PullAuth } from "./logins.ts";
import { redactSecrets } from "./login-secrets.ts";

export interface PullProgress {
  /** Bytes downloaded so far, summed over layers, and the total announced so
   * far. Both grow as layers are announced, so this is a rough fraction. */
  current: number;
  total: number;
}

interface PullEvent {
  status?: string;
  id?: string;
  error?: string;
  errorDetail?: { message?: string };
  progressDetail?: { current?: number; total?: number };
}

/** How long a pull may go without any progress before it is abandoned. Read
 * at call time, so a test can shorten it. */
function stallMs(): number {
  const raw = Number(process.env.IMAGE_PULL_STALL_MS);
  return Number.isInteger(raw) && raw > 0 ? raw : 120_000;
}

export class PullError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PullError";
  }
}

/**
 * Which digest this pull got, as `repo@sha256:…`, or null when it can't be
 * told. The pull's own `Digest:` status line is the answer; the image's
 * `RepoDigests` only when exactly one entry is for this repository, since an
 * image id can carry several (a tag that moved, a manifest list and its
 * platform manifest) and guessing could name a digest this pull never proved.
 */
export function chooseDigest(repository: string, statusLines: string[], repoDigests: string[]): string | null {
  for (const line of statusLines) {
    const match = /^Digest: (sha256:[a-f0-9]{64})$/.exec(line.trim());
    if (match) return `${repository}@${match[1]}`;
  }
  // Docker records a Hub image's digest unqualified (`ubuntu@sha256:…`, not
  // `docker.io/library/ubuntu@sha256:…`), so the Hub's short forms count too.
  // What is returned is always the qualified name, as stored everywhere else.
  const names = new Set([repository]);
  if (repository.startsWith("docker.io/")) {
    const short = repository.slice("docker.io/".length);
    names.add(short);
    if (short.startsWith("library/")) names.add(short.slice("library/".length));
  }
  const ours = repoDigests.flatMap((d) => {
    const at = d.indexOf("@sha256:");
    return at !== -1 && names.has(d.slice(0, at)) ? [`${repository}${d.slice(at)}`] : [];
  });
  return ours.length === 1 ? ours[0] : null;
}

/**
 * A pull failure, as a sentence someone can act on. The engine's words are
 * kept where they say more than ours would, with the login's secret scrubbed:
 * a registry error can quote what it was sent.
 */
export function describePullFailure(raw: string, reference: string, registry: string, secret: string | null): string {
  const text = redactSecrets(raw, [secret]);
  const lower = text.toLowerCase();
  // Status codes as whole tokens: a digest or port quoted in the message can
  // contain "401" or "403" and must not turn "not found" into "refused".
  if (/unauthorized|authentication required|no basic auth credentials|denied|\b(401|403)\b|incorrect username or password/.test(lower)) {
    return `${registry} refused to let this login pull ${reference}. Check the registry login, or add one if the image is private.`;
  }
  if (lower.includes("no matching manifest")) {
    return `${reference} has no build for this server's platform (${process.arch}).`;
  }
  if (/manifest unknown|not found|does not exist/.test(lower)) {
    return `${reference} was not found on ${registry}. Check the name and tag.`;
  }
  return `Pulling ${reference} failed: ${text}`;
}

/**
 * Pulls `reference` with `auth` (none: unauthenticated). Resolves to the
 * pull's status lines, from which `chooseDigest` reads what was pulled.
 */
export async function pullImage(
  docker: Docker,
  reference: string,
  auth: PullAuth | null,
  onProgress?: (p: PullProgress) => void,
): Promise<string[]> {
  const stream = await docker.pull(reference, auth ? { authconfig: auth.authconfig } : {});
  const layers = new Map<string, { current: number; total: number }>();
  const statuses: string[] = [];
  return new Promise<string[]>((resolve, reject) => {
    let settled = false;
    let timer: NodeJS.Timeout | null = null;
    const finish = (err: Error | null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (err) reject(err);
      else resolve(statuses);
    };
    const arm = () => {
      // Events already queued can arrive after the stall timer settled the
      // pull; re-arming then would leave a timer nothing ever clears.
      if (settled) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        (stream as unknown as { destroy?: () => void }).destroy?.();
        finish(new PullError(`no progress for ${String(Math.round(stallMs() / 1000))} seconds`));
      }, stallMs());
    };
    arm();
    docker.modem.followProgress(
      stream,
      (err: Error | null, output: PullEvent[]) => {
        if (err) {
          finish(err);
          return;
        }
        // A refused pull is not an `err`: the daemon reports it as an event.
        const failure = output.find((e) => e.error ?? e.errorDetail?.message);
        if (failure) finish(new PullError(failure.errorDetail?.message ?? failure.error ?? "unknown error"));
        else finish(null);
      },
      (event: PullEvent) => {
        arm();
        if (event.status) statuses.push(event.status);
        const detail = event.progressDetail;
        if (event.id && detail && typeof detail.total === "number" && detail.total > 0) {
          layers.set(event.id, { current: detail.current ?? 0, total: detail.total });
          let current = 0;
          let total = 0;
          for (const layer of layers.values()) {
            current += layer.current;
            total += layer.total;
          }
          onProgress?.({ current, total });
        }
      },
    );
  });
}
