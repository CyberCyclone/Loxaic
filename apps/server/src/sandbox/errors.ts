/**
 * A sandbox that is definitely gone — not paused, not temporarily
 * unreachable: gone.
 *
 * `SandboxHandle.start()` is the manager's "paused or gone?" discriminator,
 * and this is the only failure it may answer "gone" with. Every other error
 * out of `start()` — an engine that cannot be reached, a machine that is
 * offline, a call that timed out — propagates as itself, because "could not
 * ask" must never be recorded as "destroyed": a row marked destroyed on the
 * strength of an engine hiccup is a workspace the boot sweep then deletes
 * for real.
 *
 * Its own module, with no imports, so the executor (which must not reach the
 * server's database or settings — executor/__tests__/isolation.test.ts) can
 * throw it and the server can catch it by type on the far side of the wire.
 */
export class SandboxGoneError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxGoneError";
  }
}

/**
 * A sandbox with no room to start a process, so a command could not run. Its
 * message says so and what to do; `limit` is the sandbox's process limit, for
 * the notice a client turns into a way out.
 */
export class SandboxProcessLimitError extends Error {
  readonly limit: number;

  constructor(message: string, limit: number) {
    super(message);
    this.name = "SandboxProcessLimitError";
    this.limit = limit;
  }
}

/** What a failed exec read as a file operation throws: its stderr, typed when
 * the cause was the process limit. */
export function execFailure(res: { stderr: string; processLimit?: number }, fallback: string): Error {
  const message = res.stderr.trim() || fallback;
  return res.processLimit !== undefined ? new SandboxProcessLimitError(message, res.processLimit) : new Error(message);
}

/** The sentence a sandbox at its process limit answers with, to the model and
 * the person alike. */
export function processLimitMessage(limit: number): string {
  return (
    `This sandbox has reached its limit of ${String(limit)} processes, so no command can start in it. ` +
    "Pausing it (Settings → Sandboxes) ends every process and keeps your files; " +
    "an admin can raise Processes for this image."
  );
}
