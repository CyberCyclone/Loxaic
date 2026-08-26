import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
  /** Dev-only tooling: advertised only when this server can actually launch
   * it, and hidden in the GUI unless the user has dev mode on. */
  dev?: true;
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
  {
    key: "mock-dev",
    name: "Mock MCP (dev)",
    slug: "mock-dev",
    transport: "stdio",
    dev: true,
    description:
      "Local test server with deliberately hostile tools (oversized output, prompt-injection text, a hang). " +
      "No credentials and no network calls — use it to exercise MCP end-to-end without spending API budget.",
    secretKeys: [],
    resolveLaunch() {
      // Runs the fixture through the workspace's own tsx. Both the binary and
      // the fixture are dev-only, so this throws in a production install and
      // the entry is simply never advertised.
      const tsx = resolveBin("tsx", "tsx");
      const fixture = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../test-fixtures/mock-mcp-server.ts");
      if (!existsSync(fixture)) throw new Error("mock MCP fixture is not present in this build");
      return { command: process.execPath, args: [tsx, fixture] };
    },
  },
];

export function catalogEntry(key: string): CatalogEntry | undefined {
  return BUILTIN_CATALOG.find((e) => e.key === key);
}

/**
 * Can this deployment actually launch the entry? Dev tooling depends on
 * devDependencies (tsx) and on test fixtures that a production build doesn't
 * ship, so availability is decided by probing rather than by NODE_ENV —
 * whether the user *sees* it is then purely their dev-mode setting.
 */
export function canLaunch(entry: CatalogEntry): boolean {
  try {
    entry.resolveLaunch();
    return true;
  } catch {
    return false;
  }
}
