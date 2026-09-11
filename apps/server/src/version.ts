/**
 * This server's own version, for the hosts table and `GET /v1/config`.
 *
 * `LOXAIC_VERSION` is what the desktop supervisor sets (stamped into its own
 * package.json at release time, since the packaged app runs under Electron's
 * Node rather than pnpm and never sees `npm_package_version`); the latter is
 * what `pnpm dev`/`pnpm start` set from `apps/server/package.json` itself.
 * Neither is guaranteed — a bare `node dist/index.js`, a hand-rolled Docker
 * image — so this is nullable, and null means exactly that: no version was
 * reported. The desktop supervisor sets nothing for an unstamped 0.0.0 build,
 * so that reads as null here too rather than as a number worth printing.
 *
 * `||`, not `??`: an unset `--build-arg` in the Docker image still leaves
 * `ENV LOXAIC_VERSION=$LOXAIC_VERSION` set to an *empty string*, not unset —
 * Docker has no "leave it unset unless passed" form of ENV — and `??` treats
 * "" as present. Falling through on empty is what keeps that image honestly
 * reporting null instead of a version that is silently the empty string.
 */
export function serverVersion(): string | null {
  // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- ?? would keep an empty string instead of falling through to the next source.
  return process.env.LOXAIC_VERSION || process.env.npm_package_version || null;
}
