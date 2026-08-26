import { createRequire } from "node:module";
import path from "node:path";

/**
 * Built-in MCP servers ship as pinned dependencies and appear pre-listed in
 * the GUI; the user only supplies credentials. Launch commands resolve the
 * installed package's bin directly (never `npx`): the exact audited version
 * from the lockfile runs, offline, with no cold-start install.
 */
export type CatalogEntry = {
  key: string;
  name: string;
  slug: string;
  transport: "stdio";
  description: string;
  secretKeys: { env: string; label: string }[];
  resolveLaunch(): { command: string; args: string[] };
};

const require = createRequire(import.meta.url);

function resolveBin(pkg: string, binName: string): string {
  const pkgJsonPath = require.resolve(`${pkg}/package.json`);
  const pkgJson = require(`${pkg}/package.json`) as { bin?: string | Record<string, string> };
  const bin = typeof pkgJson.bin === "string" ? pkgJson.bin : pkgJson.bin?.[binName];
  if (!bin) throw new Error(`Package ${pkg} has no bin entry ${binName}`);
  return path.join(path.dirname(pkgJsonPath), bin);
}

export const BUILTIN_CATALOG: CatalogEntry[] = [
  {
    key: "brave",
    name: "Brave Search",
    slug: "brave",
    transport: "stdio",
    description: "Web, news, image, video, and local search plus AI summaries via the official Brave Search MCP server.",
    secretKeys: [{ env: "BRAVE_API_KEY", label: "Brave API key" }],
    resolveLaunch() {
      return {
        command: process.execPath,
        args: [resolveBin("@brave/brave-search-mcp-server", "brave-search-mcp-server")],
      };
    },
  },
];

export function catalogEntry(key: string): CatalogEntry | undefined {
  return BUILTIN_CATALOG.find((e) => e.key === key);
}
