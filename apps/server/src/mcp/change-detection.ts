import { createHash } from "node:crypto";
import type { SanitizedToolMeta } from "./sanitize.ts";

/**
 * A connected server can swap a benign tool for a dangerous one at any time,
 * so an allowlist entry is only valid for the exact tool it was granted for.
 * Every connect/test diffs the discovered tools against the stored snapshot:
 * new and changed tools always fall back to approval-required.
 */

export type ToolPolicy = {
  enabled: boolean;
  approval: "ask" | "allow";
  /** User-asserted; gates planning mode. Never derived from server annotations. */
  readOnly: boolean;
  /** Set when the tool's description/schema changed since the policy was granted. */
  changed?: boolean;
  /** Set when the tool disappeared from the server's listing. */
  missing?: boolean;
};

export type ToolPolicies = Record<string, ToolPolicy>;
export type KnownTools = Record<string, string>; // remoteName -> content hash

export const DEFAULT_POLICY: ToolPolicy = { enabled: true, approval: "ask", readOnly: false };

export function toolHash(tool: SanitizedToolMeta): string {
  return createHash("sha256")
    .update(JSON.stringify({ description: tool.description, inputSchema: tool.inputSchema }))
    .digest("hex");
}

export function reconcileTools(
  stored: { toolPolicies: ToolPolicies; knownTools: KnownTools },
  discovered: SanitizedToolMeta[],
): { toolPolicies: ToolPolicies; knownTools: KnownTools; changedTools: string[] } {
  const policies: ToolPolicies = { ...stored.toolPolicies };
  const known: KnownTools = {};
  const changedTools: string[] = [];
  const seen = new Set<string>();

  for (const tool of discovered) {
    seen.add(tool.name);
    const hash = toolHash(tool);
    known[tool.name] = hash;
    const prevHash = stored.knownTools[tool.name];
    const prevPolicy = policies[tool.name];

    if (!prevPolicy) {
      policies[tool.name] = { ...DEFAULT_POLICY };
    } else if (prevHash !== undefined && prevHash !== hash) {
      // The tool the user allowlisted no longer exists in that form — any
      // standing "allow" or read-only grant is revoked until re-confirmed.
      policies[tool.name] = { ...prevPolicy, approval: "ask", readOnly: false, changed: true, missing: false };
      changedTools.push(tool.name);
    } else if (prevPolicy.missing) {
      policies[tool.name] = { ...prevPolicy, missing: false };
    }
  }

  for (const [name, policy] of Object.entries(policies)) {
    if (!seen.has(name)) {
      if (!policy.missing) policies[name] = { ...policy, missing: true };
      // Keep the last-seen hash so a tool that returns *changed* still trips
      // the policy reset above.
      if (stored.knownTools[name]) known[name] = stored.knownTools[name];
    }
  }

  return { toolPolicies: policies, knownTools: known, changedTools };
}
