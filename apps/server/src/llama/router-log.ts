import { closeSync, fstatSync, mkdirSync, openSync, renameSync, writeSync } from "node:fs";
import path from "node:path";

/**
 * The router's output, on disk.
 *
 * Everything llama-server prints — what each load was offloaded to, its
 * buffers, the graph splits, every request's timings — used to live only in a
 * 200-line buffer in this process, so a restart threw it away. A three-hour
 * run on the beta could then be explained only from the database: whether the
 * model had been partly on the CPU was not answerable after the fact.
 *
 * Appended as it arrives, each line stamped with the wall-clock time (llama's
 * own stamps are relative to its start), to `logs/router.log` under the llama
 * directory. One rotation: past `maxBytes` the file becomes `router.log.1` and
 * a new one starts, so it is bounded at twice that. Never throws: a log that
 * cannot be written must not take inference down with it.
 */
export interface RouterLog {
  write(chunk: string): void;
  close(): Promise<void>;
}

export const ROUTER_LOG_MAX_BYTES = 10 * 1024 * 1024;

export function openRouterLog(file: string, maxBytes = ROUTER_LOG_MAX_BYTES, now: () => Date = () => new Date()): RouterLog {
  // Synchronous appends to one descriptor: a line is a few hundred bytes, and
  // an asynchronous stream opens its file later than the first write, so a
  // rotation could rename a file that did not exist yet.
  let fd: number | null = null;
  let size = 0;
  let broken = false;

  const open = (): number | null => {
    if (broken) return null;
    try {
      mkdirSync(path.dirname(file), { recursive: true });
      const opened = openSync(file, "a", 0o600);
      size = fstatSync(opened).size;
      return opened;
    } catch {
      broken = true;
      return null;
    }
  };

  const shut = () => {
    if (fd === null) return;
    try {
      closeSync(fd);
    } catch {
      // Already gone.
    }
    fd = null;
  };

  return {
    write(chunk: string) {
      const stamp = now().toISOString();
      const lines = chunk
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => `${stamp} ${l}\n`)
        .join("");
      if (!lines) return;
      fd ??= open();
      if (fd === null) return;
      const bytes = Buffer.byteLength(lines);
      if (size > 0 && size + bytes > maxBytes) {
        shut();
        try {
          renameSync(file, `${file}.1`);
        } catch {
          // It cannot be moved: carry on appending to it.
        }
        fd = open();
        if (fd === null) return;
      }
      try {
        writeSync(fd, lines);
        size += bytes;
      } catch {
        // A full disk or a vanished directory: stop logging, keep serving.
        shut();
        broken = true;
      }
    },
    close() {
      shut();
      return Promise.resolve();
    },
  };
}
