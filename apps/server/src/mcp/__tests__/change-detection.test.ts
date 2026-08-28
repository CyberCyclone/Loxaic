import { describe, expect, it } from "vitest";
import { reconcileTools, toolHash, DEFAULT_POLICY, type ToolPolicies, type ToolPolicy } from "../change-detection.ts";
import type { SanitizedToolMeta } from "../sanitize.ts";

const tool = (name: string, description = "desc"): SanitizedToolMeta => ({
  name,
  description,
  inputSchema: { type: "object", properties: {} },
});

/** A policy the reconcile was expected to produce — a lookup miss is itself a
 * failure worth naming, rather than an undefined-property error downstream. */
function policyFor(policies: ToolPolicies, name: string): ToolPolicy {
  const policy = policies[name];
  if (!policy) throw new Error(`expected a policy for "${name}"`);
  return policy;
}

describe("mcp change detection", () => {
  it("gives new tools the ask-by-default policy", () => {
    const r = reconcileTools({ toolPolicies: {}, knownTools: {} }, [tool("a")]);
    expect(policyFor(r.toolPolicies, "a")).toEqual(DEFAULT_POLICY);
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
    expect(policyFor(after.toolPolicies, "a").approval).toBe("ask");
    expect(policyFor(after.toolPolicies, "a").readOnly).toBe(false);
    expect(policyFor(after.toolPolicies, "a").changed).toBe(true);
    expect(after.changedTools).toEqual(["a"]);
  });

  it("keeps granted policies for unchanged tools", () => {
    const before = reconcileTools({ toolPolicies: {}, knownTools: {} }, [tool("a")]);
    const granted = {
      toolPolicies: { a: { enabled: true, approval: "allow" as const, readOnly: true } },
      knownTools: before.knownTools,
    };
    const after = reconcileTools(granted, [tool("a")]);
    expect(policyFor(after.toolPolicies, "a").approval).toBe("allow");
    expect(policyFor(after.toolPolicies, "a").readOnly).toBe(true);
    expect(policyFor(after.toolPolicies, "a").changed).toBeUndefined();
  });

  it("flags vanished tools as missing and clears the flag on return", () => {
    const before = reconcileTools({ toolPolicies: {}, knownTools: {} }, [tool("a")]);
    const gone = reconcileTools(
      { toolPolicies: before.toolPolicies, knownTools: before.knownTools },
      [],
    );
    expect(policyFor(gone.toolPolicies, "a").missing).toBe(true);
    const back = reconcileTools(
      { toolPolicies: gone.toolPolicies, knownTools: gone.knownTools },
      [tool("a")],
    );
    expect(policyFor(back.toolPolicies, "a").missing).toBe(false);
  });
});
