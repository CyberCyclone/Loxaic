/**
 * Re-owns a tar stream for another image's user (#253): every entry gets the
 * new uid and gid, and loses any setuid or setgid bit. What moves a
 * workspace's home from one container into another when its image changes.
 *
 * A stream transform over tar-stream, so a home of any size passes through
 * without being held in memory, and nothing is ever extracted on this host:
 * the archive goes from one container straight into the next. Symlinks stay
 * links, which inside the new container point where they pointed in the old.
 */
import { PassThrough, type Readable } from "node:stream";
import { extract, pack, type Header } from "tar-stream";

/** What a header becomes. Pure, so the rules are tested apart from streams. */
export function rewriteHeader(header: Header, uid: number, gid: number): Header {
  return {
    ...header,
    uid,
    gid,
    // Names emptied on purpose: tar prefers a name to the number, and the old
    // image's user name may belong to someone else in the new image.
    uname: "",
    gname: "",
    mode: header.mode & ~0o6000,
  };
}

export function rewriteOwnership(source: Readable, uid: number, gid: number): Readable {
  const reader = extract();
  const writer = pack();
  const out = new PassThrough();
  const fail = (err: Error) => {
    reader.destroy(err);
    out.destroy(err);
  };
  reader.on("entry", (header, stream, next) => {
    const entry = writer.entry(rewriteHeader(header, uid, gid), (err) => {
      if (err) fail(err);
      else next();
    });
    stream.on("error", fail);
    stream.pipe(entry);
  });
  reader.on("finish", () => { writer.finalize(); });
  reader.on("error", fail);
  source.on("error", fail);
  writer.on("error", fail);
  source.pipe(reader);
  writer.pipe(out);
  return out;
}
