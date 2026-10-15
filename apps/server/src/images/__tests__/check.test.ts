import { describe, expect, it } from "vitest";
import { labelRefusal, parseProbe, PROBE_SCRIPT } from "../check.ts";

describe("parseProbe", () => {
  it("reads the user and finds nothing missing in a complete image", () => {
    expect(parseProbe("uid=1000\ngid=1000\n")).toEqual({ uid: 1000, gid: 1000, check: { missing: [], warnings: [] } });
  });

  it("lists what is missing, once each", () => {
    const out = parseProbe("uid=0\ngid=0\nmissing=realpath\nmissing=setsid -w (util-linux)\nmissing=realpath\n");
    expect(out.check.missing).toEqual(["realpath", "setsid -w (util-linux)"]);
  });

  it("turns warnings into sentences, and gathers PATH entries a login shell drops into one", () => {
    const out = parseProbe("uid=1000\ngid=1000\nwarn=git\nwarn=rg\nwarn=path:/opt/sdk/bin\nwarn=path:/opt/tools\nwarn=unknown\n");
    expect(out.check.warnings.map((w) => w.code)).toEqual(["git", "rg", "path"]);
    expect(out.check.warnings[2].message).toContain("/opt/sdk/bin, /opt/tools");
  });

  it("warns when the image runs as root, and only then", () => {
    expect(parseProbe("uid=0\ngid=0\n").check.warnings.map((w) => w.code)).toEqual(["root"]);
    expect(parseProbe("uid=1000\ngid=1000\n").check.warnings).toEqual([]);
  });

  it("requires sh, which a GitHub workspace's CA setup runs", () => {
    expect(PROBE_SCRIPT).toMatch(/for t in sh tail /);
  });

  it("counts an image whose user cannot be read as missing id", () => {
    expect(parseProbe("uid=\ngid=\n").check.missing).toEqual(["id"]);
  });

  it("checks with the exact awk program fs_read runs", () => {
    expect(PROBE_SCRIPT).toContain(`'NR>=s && NR<=e {print NR"\\t"$0}'`);
  });
});

describe("labelRefusal", () => {
  it("refuses an image that carries Loxaic's own labels, which a container inherits", () => {
    expect(labelRefusal({ "loxaic.executor": "x", other: "y" })).toMatch(/loxaic.executor/);
    expect(labelRefusal({ maintainer: "me" })).toBeNull();
    expect(labelRefusal(null)).toBeNull();
  });
});
