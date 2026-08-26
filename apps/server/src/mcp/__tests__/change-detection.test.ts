import { describe, expect, it } from "vitest";
import { reconcileTools, toolHash, DEFAULT_POLICY } from "../change-detection.ts";
import type { SanitizedToolMeta } from "../sanitize.ts";

const tool = (name: string, description = "desc"): SanitizedToolMeta => ({
  name,
  description,
  inputSchema: { type: "object", properties: {} },
});

describe("mcp change detection", () => {
  it("gives new tools the ask-by-default policy", () => {
    const r = reconcileTools({ toolPolicies: {}, knownTools: {} }, [tool("a")]);
    expect(r.toolPolicies.a).toEqual(DEFAULT_POLICY);
    expect(r.knownTools.a).toBe(toolHash(tool("a")));
    expect(r.changedTools).toEqual([]);
  });

  it("revokes allow and readOnly when a tool's definition changes", () => {
    const before = reconcileTools({ toolPolicies: {}, knownTools: {} }, [tool("a", "v1")]);
    const granted = {
      toolPolicies: { a: { enabled: true, approval: "allow" as const, readOnly: true } },
      knownTools: before.knownTools,
    };
    const after = reconcileTools(granted, [tool("a", "v2 — now exfiltrates your data")]);
    expect(after.toolPolicies.a.approval).toBe("ask");
    expect(after.toolPolicies.a.readOnly).toBe(false);
    expect(after.toolPolicies.a.changed).toBe(true);
    expect(after.changedTools).toEqual(["a"]);
  });

  it("keeps granted policies for unchanged tools", () => {
    const before = reconcileTools({ toolPolicies: {}, knownTools: {} }, [tool("a")]);
    const granted = {
      toolPolicies: { a: { enabled: true, approval: "allow" as const, readOnly: true } },
      knownTools: before.knownTools,
    };
    const after = reconcileTools(granted, [tool("a")]);
    expect(after.toolPolicies.a.approval).toBe("allow");
    expect(after.toolPolicies.a.readOnly).toBe(true);
    expect(after.toolPolicies.a.changed).toBeUndefined();
  });

  it("flags vanished tools as missing and clears the flag on return", () => {
    const before = reconcileTools({ toolPolicies: {}, knownTools: {} }, [tool("a")]);
    const gone = reconcileTools(
      { toolPolicies: before.toolPolicies, knownTools: before.knownTools },
      [],
    );
    expect(gone.toolPolicies.a.missing).toBe(true);
    const back = reconcileTools(
      { toolPolicies: gone.toolPolicies, knownTools: gone.knownTools },
      [tool("a")],
    );
    expect(back.toolPolicies.a.missing).toBe(false);
  });
});
