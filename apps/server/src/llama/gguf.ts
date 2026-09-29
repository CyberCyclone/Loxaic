import { open, type FileHandle } from "node:fs/promises";
import { shapeFromKeys, type ModelShape } from "./shape.ts";

/**
 * Just enough of a GGUF reader to learn the facts the settings sheet and the
 * fit estimate need: the layer count (the GPU-offload slider's range), the
 * trained context length (the context slider's ceiling), and whether the
 * model is a mixture of experts. HuggingFace's API reports the parameter count
 * but not the layers, so the downloaded file's own header is the only source.
 *
 * It also reads the attention layout (`shape`, see shape.ts), which is what
 * lets the fit estimate price a long context correctly.
 *
 * Reads the metadata key/value section sequentially through a small buffer and
 * stops at the tokenizer — its arrays can hold hundreds of thousands of
 * strings, and every architecture key a model has comes before them.
 */

export interface GgufFacts {
  architecture: string | null;
  nLayers: number | null;
  nCtxTrain: number | null;
  expertCount: number | null;
  /** Null when the file does not describe its attention (the fit estimate
   * then falls back to a rough figure). */
  shape: ModelShape | null;
}

/** The longest per-layer array kept (`head_count_kv`, the SWA pattern). */
const MAX_KEPT_ARRAY = 4096;

const MAGIC = 0x46554747; // "GGUF", little-endian
const MAX_STRING = 16 * 1024 * 1024;
const MAX_KV = 100_000;
/** The longest array skipped element by element. A vocabulary is the largest
 * real one (a few hundred thousand tokens); a count past this is a malformed
 * file, refused rather than iterated — each element is an awaited turn on the
 * server's event loop. */
const MAX_ARRAY = 2_000_000;

class Reader {
  private buf = Buffer.alloc(0);
  private pos = 0;
  private filePos = 0;
  private eof = false;

  constructor(
    private readonly fh: FileHandle,
    private readonly size: number,
  ) {}

  /** Where the next read lands in the file. A skip that runs past the end is
   * a count that outlived the data backing it. */
  private offset(): number {
    return this.filePos - (this.buf.length - this.pos);
  }

  private async fill(n: number): Promise<void> {
    while (this.buf.length - this.pos < n && !this.eof) {
      const chunk = Buffer.alloc(Math.max(64 * 1024, n));
      const { bytesRead } = await this.fh.read(chunk, 0, chunk.length, this.filePos);
      if (bytesRead === 0) {
        this.eof = true;
        break;
      }
      this.filePos += bytesRead;
      this.buf = Buffer.concat([this.buf.subarray(this.pos), chunk.subarray(0, bytesRead)]);
      this.pos = 0;
    }
    if (this.buf.length - this.pos < n) throw new Error("Unexpected end of GGUF header");
  }

  async take(n: number): Promise<Buffer> {
    await this.fill(n);
    const out = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }

  skip(n: number): void {
    // Skipping within the buffer, then seeking the file for the rest — a
    // 150k-entry vocabulary is skipped a string at a time, but never held.
    if (this.offset() + n > this.size) throw new Error("GGUF header runs past the end of the file");
    const inBuf = Math.min(n, this.buf.length - this.pos);
    this.pos += inBuf;
    const rest = n - inBuf;
    if (rest > 0) {
      this.filePos += rest;
      this.buf = Buffer.alloc(0);
      this.pos = 0;
    }
  }

  async u32(): Promise<number> {
    return (await this.take(4)).readUInt32LE(0);
  }

  async u64(): Promise<bigint> {
    return (await this.take(8)).readBigUInt64LE(0);
  }

  async str(): Promise<string> {
    const len = Number(await this.u64());
    if (len > MAX_STRING) throw new Error("GGUF string too long");
    return (await this.take(len)).toString("utf8");
  }
}

const FIXED: Partial<Record<number, number>> = { 0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8 };

async function readScalar(r: Reader, type: number): Promise<number | string | boolean | null> {
  if (type === 8) return r.str();
  const b = await r.take(FIXED[type] ?? 0);
  switch (type) {
    case 0: return b.readUInt8(0);
    case 1: return b.readInt8(0);
    case 2: return b.readUInt16LE(0);
    case 3: return b.readInt16LE(0);
    case 4: return b.readUInt32LE(0);
    case 5: return b.readInt32LE(0);
    case 6: return b.readFloatLE(0);
    case 7: return b.readUInt8(0) !== 0;
    case 10: return Number(b.readBigUInt64LE(0));
    case 11: return Number(b.readBigInt64LE(0));
    case 12: return b.readDoubleLE(0);
    default: throw new Error(`Unknown GGUF value type ${String(type)}`);
  }
}

/** A small array of numbers or booleans; null (after skipping it) otherwise. */
async function readSmallArray(r: Reader): Promise<number[] | boolean[] | null> {
  const inner = await r.u32();
  const n = Number(await r.u64());
  if (n > MAX_ARRAY) throw new Error("GGUF array too long");
  const width = FIXED[inner];
  if (inner === 8 || width === undefined || n > MAX_KEPT_ARRAY) {
    if (inner === 8) for (let i = 0; i < n; i++) await skipValue(r, 8);
    else if (width !== undefined) r.skip(width * n);
    else throw new Error("Nested GGUF arrays are not supported");
    return null;
  }
  const out: (number | boolean)[] = [];
  for (let i = 0; i < n; i++) {
    const v = await readScalar(r, inner);
    if (typeof v === "number" || typeof v === "boolean") out.push(v);
  }
  return out as number[] | boolean[];
}

async function skipValue(r: Reader, type: number): Promise<void> {
  if (type === 8) {
    const len = Number(await r.u64());
    r.skip(len);
    return;
  }
  if (type === 9) {
    const inner = await r.u32();
    const n = Number(await r.u64());
    if (n > MAX_ARRAY) throw new Error("GGUF array too long");
    const width = FIXED[inner];
    if (inner === 8) for (let i = 0; i < n; i++) await skipValue(r, 8);
    else if (width !== undefined) r.skip(width * n);
    else throw new Error("Nested GGUF arrays are not supported");
    return;
  }
  const size = FIXED[type];
  if (size === undefined) throw new Error(`Unknown GGUF value type ${String(type)}`);
  r.skip(size);
}

export async function readGgufFacts(file: string): Promise<GgufFacts> {
  const facts: GgufFacts = { architecture: null, nLayers: null, nCtxTrain: null, expertCount: null, shape: null };
  const fh = await open(file, "r");
  try {
    const r = new Reader(fh, (await fh.stat()).size);
    if ((await r.u32()) !== MAGIC) throw new Error("Not a GGUF file");
    const version = await r.u32();
    if (version < 2) throw new Error("GGUF v1 is not supported");
    await r.u64(); // tensor count
    const kvCount = Math.min(Number(await r.u64()), MAX_KV);
    const keys: Record<string, number | boolean | string | number[] | boolean[]> = {};
    for (let i = 0; i < kvCount; i++) {
      const key = await r.str();
      const type = await r.u32();
      if (key.startsWith("tokenizer.") && facts.architecture) break;
      if (key === "general.architecture" && type === 8) {
        facts.architecture = await r.str();
        continue;
      }
      const arch = facts.architecture;
      if (arch === null || !key.startsWith(`${arch}.`)) {
        await skipValue(r, type);
        continue;
      }
      const name = key.slice(arch.length + 1);
      if (type === 9) {
        const arr = await readSmallArray(r);
        if (arr) keys[name] = arr;
        continue;
      }
      const value = await readScalar(r, type);
      if (value !== null) keys[name] = value;
    }
    const n = (k: string) => {
      const v = keys[k];
      return typeof v === "number" ? v : null;
    };
    if (facts.architecture) {
      facts.nLayers = n("block_count");
      facts.nCtxTrain = n("context_length");
      facts.expertCount = n("expert_count");
      facts.shape = shapeFromKeys(keys);
    }
    return facts;
  } finally {
    await fh.close();
  }
}
