import { describe, it, expect } from "vitest";
import { nextTag, orderTags } from "../next-tag.mjs";

/**
 * Deciding the next version is the one part of cutting a release that nobody
 * should be doing in their head at the point of running the command. Every
 * rule here is a case where the obvious answer and the right one differ.
 */
describe("orderTags", () => {
  it("orders by version, not by the order they were pushed", () => {
    // A tag can be pushed at any commit at any time, so creation order is not
    // a reliable answer to "what version are we on".
    const ordered = orderTags(["v1.0.0", "v1.2.0", "v1.1.5"]).map((t) => t.tag);
    expect(ordered).toEqual(["v1.2.0", "v1.1.5", "v1.0.0"]);
  });

  it("puts a stable release ahead of its own betas", () => {
    const ordered = orderTags(["v1.2.0-beta.1", "v1.2.0", "v1.2.0-beta.9"]).map((t) => t.tag);
    expect(ordered[0]).toBe("v1.2.0");
    expect(ordered).toEqual(["v1.2.0", "v1.2.0-beta.9", "v1.2.0-beta.1"]);
  });

  it("ignores tags that are not releases of ours", () => {
    // The repository has at least one (`pr32-prerebase`), and a release tool
    // that tripped over somebody's scratch tag would be unusable.
    expect(orderTags(["v1.0.0", "pr32-prerebase", "v2", "release-1"]).map((t) => t.tag)).toEqual([
      "v1.0.0",
    ]);
  });
});

describe("nextTag", () => {
  it("starts at 0.0.1-beta.1 when nothing has ever been released", () => {
    expect(nextTag("beta", [])).toBe("v0.0.1-beta.1");
    expect(nextTag("patch", [])).toBe("v0.0.1");
  });

  it("continues an unreleased beta line rather than starting a new one", () => {
    // The mistake this prevents: 1.2.0-beta.1 followed by 1.2.1-beta.1, which
    // silently abandons the beta everyone is testing.
    expect(nextTag("beta", ["v1.1.0", "v1.2.0-beta.1"])).toBe("v1.2.0-beta.2");
    expect(nextTag("beta", ["v1.2.0-beta.9"])).toBe("v1.2.0-beta.10");
  });

  it("starts a beta line for the next patch after a stable release", () => {
    expect(nextTag("beta", ["v1.2.0"])).toBe("v1.2.1-beta.1");
  });

  it("sizes a new beta line when asked, because the size is known up front", () => {
    expect(nextTag("beta:minor", ["v1.2.3"])).toBe("v1.3.0-beta.1");
    expect(nextTag("beta:major", ["v1.2.3"])).toBe("v2.0.0-beta.1");
  });

  it("promotes the newest beta to the release it is a candidate for", () => {
    expect(nextTag("promote", ["v1.1.0", "v1.2.0-beta.3"])).toBe("v1.2.0");
  });

  it("refuses to promote when there is no beta outstanding", () => {
    expect(() => nextTag("promote", ["v1.2.0"])).toThrow(/not a beta/);
    expect(() => nextTag("promote", [])).toThrow(/nothing to promote/);
  });

  it("refuses a plain bump while a newer beta is outstanding, and says what to do", () => {
    // Publishing 1.2.1 while 1.3.0-beta.2 is under test would ship a release
    // that skips everything the beta testers have been exercising. That may be
    // deliberate, but it is never the default.
    expect(() => nextTag("patch", ["v1.2.0", "v1.3.0-beta.2"])).toThrow(/use "promote"/);
  });

  it("bumps from the newest stable release once the beta has shipped", () => {
    const tags = ["v1.2.0-beta.1", "v1.2.0"];
    expect(nextTag("patch", tags)).toBe("v1.2.1");
    expect(nextTag("minor", tags)).toBe("v1.3.0");
    expect(nextTag("major", tags)).toBe("v2.0.0");
  });

  it("rejects a kind it does not know rather than guessing", () => {
    expect(() => nextTag("nightly", ["v1.0.0"])).toThrow(/unknown release kind/);
    expect(() => nextTag("beta:huge", ["v1.0.0"])).toThrow(/unknown bump/);
  });

  it.each(["constructor", "toString", "valueOf"])(
    "rejects %s, which a plain lookup would find on the prototype",
    (key) => {
      expect(() => nextTag(key, ["v1.0.0"])).toThrow(/unknown release kind/);
      expect(() => nextTag(`beta:${key}`, ["v1.0.0"])).toThrow(/unknown bump/);
    },
  );

  it("does not read a misspelled beta kind as a plain beta", () => {
    // release.sh passes its argument through verbatim, so "betaminor" asking
    // for a minor line and silently getting a patch one would be worse than
    // an error.
    expect(() => nextTag("betaminor", ["v1.2.3"])).toThrow(/unknown release kind/);
  });
});
