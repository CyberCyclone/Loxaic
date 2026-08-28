import { TOOLS } from "@shannon/agent";
import { MAX_TOOL_NAME } from "./sanitize.ts";

/** Server slugs namespace tool names as `slug__tool`. No builtin tool name
 * contains a double underscore, so namespaced names can never shadow one. */
export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

const BUILTIN_NAMES = new Set<string>(TOOLS.map((t) => t.name));

export function isValidSlug(slug: string): boolean {
  // Rejecting builtin names as slugs is defense in depth on top of the
  // `__` separator guarantee.
  return SLUG_RE.test(slug) && !BUILTIN_NAMES.has(slug);
}

/** Wire name for an MCP tool: `slug__remoteName`, coerced into the OpenAI
 * tool-name charset and length cap. */
export function namespaceTool(slug: string, remoteName: string): string {
  const safeRemote = remoteName.replace(/[^A-Za-z0-9_-]/g, "_");
  return `${slug}__${safeRemote}`.slice(0, MAX_TOOL_NAME);
}

/** Split a wire name back into slug + remote name; null for builtin names. */
export function splitNamespaced(name: string): { slug: string; remoteName: string } | null {
  const idx = name.indexOf("__");
  if (idx <= 0) return null;
  return { slug: name.slice(0, idx), remoteName: name.slice(idx + 2) };
}
