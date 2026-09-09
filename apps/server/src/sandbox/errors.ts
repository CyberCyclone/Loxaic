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
