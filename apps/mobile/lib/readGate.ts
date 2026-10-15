/**
 * Which list responses may land (#253's image screens): a write invalidates
 * every read that started before it, so a poll already on its way cannot put
 * the pre-write list back. Reads never invalidate each other: two overlapping
 * polls carry the same generation and the later answer simply wins. And while
 * one is out, a poll skips its tick rather than stacking another behind it.
 *
 * Reads invalidating one another was the bug this replaced: on a link slower
 * than the poll interval every tick discarded the one before it, so nothing
 * ever landed and a finished pull showed "Pulling…" for good.
 */
export interface ReadGate {
  /** Starts a read; pass the token to `landed` when it answers. */
  beginRead(): number;
  endRead(): void;
  /** Whether a read that started with `token` may still be applied. */
  landed(token: number): boolean;
  /** A write happened: reads that started before it may not land. */
  write(): void;
  /** A read is out. */
  busy(): boolean;
}

export function createReadGate(): ReadGate {
  let generation = 0;
  let reading = 0;
  return {
    beginRead: () => {
      reading++;
      return generation;
    },
    endRead: () => {
      reading = Math.max(0, reading - 1);
    },
    landed: (token) => token === generation,
    write: () => {
      generation++;
    },
    busy: () => reading > 0,
  };
}
