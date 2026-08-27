import { Writable } from "node:stream";

/** Per-stream cap on captured exec output. Anything past this is dropped. */
export const MAX_OUTPUT_BYTES = 256 * 1024;

/**
 * Collects a stream into a string, hard-capped at MAX_OUTPUT_BYTES.
 * Past the cap bytes are counted but discarded, so a runaway command can't
 * grow the server's heap. Shared by both sandbox providers so output-capping
 * behavior can't drift between them.
 */
export class CappedSink extends Writable {
  private chunks: Buffer[] = [];
  private bytes = 0;
  truncated = false;

  override _write(chunk: Buffer, _enc: BufferEncoding, cb: (e?: Error | null) => void) {
    const room = MAX_OUTPUT_BYTES - this.bytes;
    if (room <= 0) {
      this.truncated = true;
    } else if (chunk.length > room) {
      this.chunks.push(chunk.subarray(0, room));
      this.bytes = MAX_OUTPUT_BYTES;
      this.truncated = true;
    } else {
      this.chunks.push(chunk);
      this.bytes += chunk.length;
    }
    cb();
  }

  text(): string {
    const body = Buffer.concat(this.chunks).toString("utf8");
    return this.truncated ? `${body}\n… [output truncated at ${String(MAX_OUTPUT_BYTES)} bytes]` : body;
  }
}
