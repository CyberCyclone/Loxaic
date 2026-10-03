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
 * Reads the metadata key/value section sequentially through a small buffer.
 * The tokenizer's arrays (hundreds of thousands of strings) are skipped, never
 * held: the one tokenizer key wanted is the chat template, which is what says
 * whether the model takes a thinking level (inference/thinking.ts), and it
 * usually comes after them. The read stops as soon as it has it.
 */

export interface GgufFacts {
  architecture: string | null;
  nLayers: number | null;
  nCtxTrain: number | null;
  expertCount: number | null;
  /** Null when the file does not describe its attention (the fit estimate
   * then falls back to a rough figure). */
  shape: ModelShape | null;
  /** `tokenizer.chat_template`, or null when the file carries none (or one
   * past `MAX_TEMPLATE`, which no real template comes near). */
  chatTemplate: string | null;
  /** The model's multi-token-prediction head, when the file carries one:
   * `nextn_predict_layers` above zero **and** at least one `blk.N.nextn.`
   * tensor, since a quantizer can keep the key and drop the tensors — and
   * llama.cpp's `draft-mtp` then fails the load. `sharedTarget` is a sidecar
   * head that borrows the main model's embeddings and output, which b11342
   * cannot load. Null when there is no head. */
  mtp: GgufMtp | null;
}

export interface GgufMtp {
  layers: number;
  sharedTarget: boolean;
}

/** The longest chat template kept. Real ones are a few to a few tens of KB. */
const MAX_TEMPLATE = 1024 * 1024;

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
/** The most tensor-info entries walked looking for an MTP tensor. Real models
 * have a few thousand; the walk stops at the first match anyway. */
const MAX_TENSORS = 1_000_000;
const NEXTN_TENSOR = /^blk\.\d+\.nextn\./;

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
  offset(): number {
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

  /**
   * Skips `n` length-prefixed strings. Awaits only when the buffer runs low,
   * not once per string: a vocabulary is a few hundred thousand of them, and
   * reading past it to the chat template used to cost that many awaited reads
   * on the event loop.
   */
  async skipStrings(n: number): Promise<void> {
    for (let i = 0; i < n; i++) {
      if (this.buf.length - this.pos < 8) await this.fill(8);
      const len = Number(this.buf.readBigUInt64LE(this.pos));
      this.pos += 8;
      this.skip(len);
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
    if (inner === 8) await r.skipStrings(n);
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
    if (inner === 8) await r.skipStrings(n);
    else if (width !== undefined) r.skip(width * n);
    else throw new Error("Nested GGUF arrays are not supported");
    return;
  }
  const size = FIXED[type];
  if (size === undefined) throw new Error(`Unknown GGUF value type ${String(type)}`);
  r.skip(size);
}

/** Walks the tensor-info entries for a `blk.N.nextn.` tensor. Each entry is
 * a name, a dimension count, the dimensions, a type and an offset. */
async function hasNextnTensor(r: Reader, count: number): Promise<boolean> {
  if (count > MAX_TENSORS) throw new Error("GGUF tensor count too large");
  for (let i = 0; i < count; i++) {
    const name = await r.str();
    if (NEXTN_TENSOR.test(name)) return true;
    const dims = await r.u32();
    if (dims > 8) throw new Error("GGUF tensor has too many dimensions");
    r.skip(8 * dims + 4 + 8);
  }
  return false;
}

export async function readGgufFacts(file: string): Promise<GgufFacts> {
  const facts: GgufFacts = {
    architecture: null,
    nLayers: null,
    nCtxTrain: null,
    expertCount: null,
    shape: null,
    chatTemplate: null,
    mtp: null,
  };
  const fh = await open(file, "r");
  try {
    const r = new Reader(fh, (await fh.stat()).size);
    if ((await r.u32()) !== MAGIC) throw new Error("Not a GGUF file");
    const version = await r.u32();
    if (version < 2) throw new Error("GGUF v1 is not supported");
    const tensorCount = Number(await r.u64());
    const declaredKv = Number(await r.u64());
    const kvCount = Math.min(declaredKv, MAX_KV);
    const allKeysRead = declaredKv <= MAX_KV;
    const keys: Record<string, number | boolean | string | number[] | boolean[]> = {};
    let pastTokenizer = false;
    for (let i = 0; i < kvCount; i++) {
      const key = await r.str();
      const type = await r.u32();
      if (key === "tokenizer.chat_template" && type === 8) {
        const len = Number(await r.u64());
        if (len <= MAX_TEMPLATE) facts.chatTemplate = (await r.take(len)).toString("utf8");
        else r.skip(len);
        // Nothing past the template is wanted once the architecture is known —
        // unless the file claims an MTP head, whose tensors have to be found
        // in the tensor list after the last key.
        if (facts.architecture && !(Number(keys.nextn_predict_layers) > 0)) break;
        continue;
      }
      // Architecture keys come before the tokenizer's in every file seen, but
      // GGUF does not require it: only a tokenizer key that follows the
      // architecture ends the reading of model keys, so one that comes first
      // cannot hide `general.architecture` and everything keyed under it.
      if (key.startsWith("tokenizer.") && facts.architecture) pastTokenizer = true;
      if (pastTokenizer) {
        await skipValue(r, type);
        continue;
      }
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
    if (Number(keys.nextn_predict_layers) > 0 && allKeysRead) {
      // Every key has been read (the template break above is skipped for
      // exactly this case), so the tensor infos start here. A list that does
      // not parse costs only this fact, never the others.
      const found = await hasNextnTensor(r, tensorCount).catch(() => false);
      if (found) {
        facts.mtp = { layers: Number(keys.nextn_predict_layers), sharedTarget: keys.nextn_shared_target_tensors === true };
      }
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

/** A per-layer token-embedding table: one row per token per layer, looked up
 * by token id on every step — 27.5 GiB in Qwen3.8-Flash-Next, 1.8 GiB in
 * Gemma 4 E4B. llama.cpp keeps it on the CPU side (an input-layer tensor, read
 * from the mapped file on demand when over 4 GiB), and where it lives is an
 * admin's choice (load-settings.ts `tablePlacement`). */
export const LOOKUP_TABLE_TENSOR = "per_layer_token_embd.weight";

export interface GgufTensorSpan {
  name: string;
  bytes: number;
}

/**
 * Find a tensor in one GGUF file and its size in bytes, or null when the file
 * does not hold it. Every key is skipped (the tensor infos follow the last),
 * then the info list is walked, bounded like the MTP walk. The size is the gap
 * to the next tensor's data, so no table of quantisation block sizes is
 * needed: data is laid out in offset order, each tensor padded to the file's
 * alignment.
 */
export async function findTensor(file: string, name: string): Promise<GgufTensorSpan | null> {
  const fh = await open(file, "r");
  try {
    const size = (await fh.stat()).size;
    const r = new Reader(fh, size);
    if ((await r.u32()) !== MAGIC) throw new Error("Not a GGUF file");
    if ((await r.u32()) < 2) throw new Error("GGUF v1 is not supported");
    const tensorCount = Number(await r.u64());
    const kvCount = Number(await r.u64());
    if (kvCount > MAX_KV) throw new Error("GGUF key count too large");
    if (tensorCount > MAX_TENSORS) throw new Error("GGUF tensor count too large");
    let alignment = 32;
    for (let i = 0; i < kvCount; i++) {
      const key = await r.str();
      const type = await r.u32();
      if (key === "general.alignment" && type === 4) {
        const a = await r.u32();
        if (a > 0 && a <= 1 << 20) alignment = a;
        continue;
      }
      await skipValue(r, type);
    }
    const offsets: number[] = [];
    let target: number | null = null;
    for (let i = 0; i < tensorCount; i++) {
      const tensorName = await r.str();
      const dims = await r.u32();
      if (dims > 8) throw new Error("GGUF tensor has too many dimensions");
      r.skip(8 * dims + 4);
      const offset = Number(await r.u64());
      offsets.push(offset);
      if (tensorName === name) target = offset;
    }
    if (target === null) return null;
    const dataStart = Math.ceil(r.offset() / alignment) * alignment;
    const next = offsets.filter((o) => o > target).reduce((a, b) => Math.min(a, b), Infinity);
    const end = Number.isFinite(next) ? next : size - dataStart;
    const bytes = end - target;
    return bytes > 0 && dataStart + end <= size ? { name, bytes } : null;
  } finally {
    await fh.close();
  }
}
