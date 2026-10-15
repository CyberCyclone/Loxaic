import { describe, expect, it } from "vitest";
import { Readable } from "node:stream";
import { extract, pack, type Header } from "tar-stream";
import { rewriteHeader, rewriteOwnership } from "../archive-rewrite.ts";

const base: Header = {
  name: "loxaic/repo/run.sh", size: 0, mode: 0o4755, uid: 1001, gid: 1001, uname: "loxaic", gname: "loxaic",
  mtime: new Date(0), type: "file", linkname: "", devmajor: 0, devminor: 0,
};

async function read(stream: Readable): Promise<{ header: Header; body: Buffer }[]> {
  const out: { header: Header; body: Buffer }[] = [];
  const reader = extract();
  reader.on("entry", (header, entry, next) => {
    const chunks: Buffer[] = [];
    entry.on("data", (c: unknown) => { chunks.push(c as Buffer); });
    entry.on("end", () => { out.push({ header, body: Buffer.concat(chunks) }); next(); });
  });
  await new Promise<void>((resolve, reject) => {
    reader.on("finish", resolve);
    reader.on("error", reject);
    // As copyHome does: a piped stream's failure is not passed downstream.
    stream.on("error", reject);
    stream.pipe(reader);
  });
  return out;
}

describe("rewriteHeader", () => {
  it("gives an entry the new user, drops the old names, and clears setuid and setgid", () => {
    const out = rewriteHeader({ ...base, mode: 0o6755 }, 1234, 1234);
    expect(out).toMatchObject({ uid: 1234, gid: 1234, uname: "", gname: "", mode: 0o755, name: base.name });
  });
});

describe("rewriteOwnership", () => {
  it("streams every entry through re-owned, symlinks kept as links and contents untouched", async () => {
    const source = pack();
    const big = Buffer.alloc(3 * 1024 * 1024, 7);
    source.entry({ ...base, name: "loxaic", type: "directory", mode: 0o755 });
    source.entry({ ...base, name: "loxaic/big.bin", size: big.length, mode: 0o644 }, big);
    source.entry({ ...base, name: "loxaic/link", type: "symlink", linkname: "/etc/passwd", mode: 0o777 });
    source.finalize();

    const entries = await read(rewriteOwnership(source as unknown as Readable, 0, 0));
    expect(entries.map((e) => [e.header.name, e.header.uid, e.header.gid])).toEqual([
      ["loxaic", 0, 0],
      ["loxaic/big.bin", 0, 0],
      ["loxaic/link", 0, 0],
    ]);
    expect(entries[1].body.equals(big)).toBe(true);
    expect(entries[2].header).toMatchObject({ type: "symlink", linkname: "/etc/passwd" });
  });

  it("fails rather than ending early when the source does", async () => {
    const broken = new Readable({ read() { this.destroy(new Error("container gone")); } });
    await expect(read(rewriteOwnership(broken, 0, 0))).rejects.toThrow();
  });
});
