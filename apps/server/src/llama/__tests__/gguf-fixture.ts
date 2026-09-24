/**
 * Build a small but valid GGUF file in memory: a header, some metadata, no
 * tensors. Enough for the header reader, the download tests (which serve it
 * as a "model"), and anything else that needs a file that parses.
 */
type Value = { type: "u32"; v: number } | { type: "str"; v: string } | { type: "strs"; v: string[] } | { type: "f32"; v: number };

function u32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
}
function u64(n: number): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
}
function str(s: string): Buffer {
  const bytes = Buffer.from(s, "utf8");
  return Buffer.concat([u64(bytes.length), bytes]);
}

export function buildGguf(kvs: [string, Value][], padTo = 0): Buffer {
  const parts: Buffer[] = [Buffer.from("GGUF", "ascii"), u32(3), u64(0), u64(kvs.length)];
  for (const [key, value] of kvs) {
    parts.push(str(key));
    switch (value.type) {
      case "u32":
        parts.push(u32(4), u32(value.v));
        break;
      case "f32": {
        const b = Buffer.alloc(4);
        b.writeFloatLE(value.v);
        parts.push(u32(6), b);
        break;
      }
      case "str":
        parts.push(u32(8), str(value.v));
        break;
      case "strs":
        parts.push(u32(9), u32(8), u64(value.v.length), ...value.v.map(str));
        break;
    }
  }
  const out = Buffer.concat(parts);
  return padTo > out.length ? Buffer.concat([out, Buffer.alloc(padTo - out.length)]) : out;
}

/** A plausible dense model header: qwen3, 28 layers, 40k context, with a
 * vocabulary array in the way the way a real file has one. */
export function denseModel(padTo = 0): Buffer {
  return buildGguf(
    [
      ["general.architecture", { type: "str", v: "qwen3" }],
      ["general.name", { type: "str", v: "Test" }],
      ["qwen3.block_count", { type: "u32", v: 28 }],
      ["qwen3.context_length", { type: "u32", v: 40960 }],
      ["qwen3.rope.freq_base", { type: "f32", v: 1000000 }],
      ["tokenizer.ggml.tokens", { type: "strs", v: Array.from({ length: 5000 }, (_, i) => `tok${String(i)}`) }],
    ],
    padTo,
  );
}
