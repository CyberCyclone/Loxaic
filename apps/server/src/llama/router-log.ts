import { closeSync, constants, fchmodSync, fstatSync, mkdirSync, openSync, renameSync, writeSync } from "node:fs";
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
 * a new one starts, so it is bounded at twice that (unless the old file cannot
 * be moved, when it keeps growing rather than retrying on every write). The
 * file is 0600 and its directory 0700 whatever the umask, and a link at the
 * path is refused. Never throws: a log that cannot be written must not take
 * inference down with it.
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
  let cap = maxBytes;
  // The unfinished end of the last chunk. A `data` event is not a line: a
  // model's load output arrives in 64 KiB reads, and a line split across two
  // of them would be stamped as two halves — which a search for exactly the
  // lines this file exists to answer ("offloaded 49/49", "graph splits")
  // would then miss.
  let partial = "";

  const open = (): number | null => {
    if (broken) return null;
    try {
      // 0700 whatever the umask: everything a request does lands here.
      mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      // O_NOFOLLOW: never append through a link someone left at this path.
      const opened = openSync(file, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | NOFOLLOW, 0o600);
      // The mode argument applies only to a file this call creates; one left
      // by another run, or restored from a backup, is tightened here.
      fchmodSync(opened, 0o600);
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

  const append = (text: string) => {
    const stamp = now().toISOString();
    const lines = text
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => `${stamp} ${l}\n`)
      .join("");
    if (!lines) return;
    fd ??= open();
    if (fd === null) return;
    const bytes = Buffer.byteLength(lines);
    if (size > 0 && size + bytes > cap) {
      shut();
      try {
        renameSync(file, `${file}.1`);
      } catch {
        // It cannot be moved (held open on Windows, a directory in the way):
        // carry on appending to it, and stop trying to rotate — retrying would
        // re-enter here on every write and bound nothing.
        cap = Infinity;
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
  };

  return {
    write(chunk: string) {
      const text = partial + chunk;
      const end = text.lastIndexOf("\n");
      if (end === -1) {
        partial = text;
        // A line with no end in sight is written rather than held forever.
        if (partial.length > MAX_PARTIAL) {
          append(partial);
          partial = "";
        }
        return;
      }
      partial = text.slice(end + 1);
      append(text.slice(0, end));
    },
    close() {
      if (partial) append(partial);
      partial = "";
      shut();
      return Promise.resolve();
    },
  };
}

/** Not on Windows, which has no symlink-following flag to refuse. */
const NOFOLLOW = (constants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;

/** The longest unfinished line held back for the next chunk. */
const MAX_PARTIAL = 64 * 1024;
