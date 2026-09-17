import { createRequire } from "node:module";
import path from "node:path";
import { DEFAULT_POLICY, type ToolPolicy } from "./change-detection.ts";

/**
 * Built-in MCP servers appear pre-listed in the GUI. Two kinds:
 *
 * - **stdio** entries ship as pinned dependencies; the user only supplies
 *   credentials. Launch commands resolve the installed package's bin directly
 *   (never `npx`): the exact audited version from the lockfile runs, offline,
 *   with no cold-start install.
 * - **http** entries take their credential from somewhere the user has already
 *   given it, never from a second copy in `mcp_servers.secrets`. The GitHub
 *   entry is provisioned when a GitHub token is connected and removed when it
 *   is disconnected (`mcp/github-server.ts`); `client-manager.ts` reads the
 *   token through `getOwnerToken()` at connect time.
 */
interface CatalogBase {
  key: string;
  name: string;
  slug: string;
  description: string;
}

export interface StdioCatalogEntry extends CatalogBase {
  transport: "stdio";
  secretKeys: { env: string; label: string }[];
  resolveLaunch(): { command: string; args: string[] };
}

export interface HttpCatalogEntry extends CatalogBase {
  transport: "http";
  /** Where the credential comes from. The row itself stores none. */
  credentials: "github-connection";
  resolveUrl(): { url: string; allowPrivateNetwork: boolean };
}

export type CatalogEntry = StdioCatalogEntry | HttpCatalogEntry;

const require = createRequire(import.meta.url);

function resolveBin(pkg: string, binName: string): string {
  const pkgJsonPath = require.resolve(`${pkg}/package.json`);
  const pkgJson = require(`${pkg}/package.json`) as { bin?: string | Record<string, string> };
  const bin = typeof pkgJson.bin === "string" ? pkgJson.bin : pkgJson.bin?.[binName];
  if (!bin) throw new Error(`Package ${pkg} has no bin entry ${binName}`);
  return path.join(path.dirname(pkgJsonPath), bin);
}

export const GITHUB_BUILTIN_KEY = "github";
export const GITHUB_MCP_DEFAULT_URL = "https://api.githubcopilot.com/mcp/";

/**
 * GitHub tools that only read, and so start allowed and planning-safe rather
 * than asking. Applied when a tool is first *discovered* (see
 * `catalogDefaultPolicy`), never written into a row ahead of time: GitHub has
 * renamed tools before (`get_issue_comments` became `issue_read`), and a
 * pre-seeded name the server no longer lists would sit in the Tools sheet as
 * "missing" forever. A name here that the server does not offer costs nothing.
 *
 * A tool that changes shape still loses its grant — change detection revokes
 * it exactly as it would a grant the user made by hand.
 */
export const GITHUB_READONLY_TOOLS: ReadonlySet<string> = new Set([
  "get_me",
  "get_teams",
  "get_team_members",
  "get_file_contents",
  "get_repository_tree",
  "list_branches",
  "list_commits",
  "get_commit",
  "list_tags",
  "get_tag",
  "list_releases",
  "get_latest_release",
  "get_release_by_tag",
  "search_repositories",
  "search_code",
  "search_commits",
  "search_issues",
  "search_pull_requests",
  "search_users",
  "list_issues",
  "issue_read",
  "list_issue_types",
  "list_issue_fields",
  "get_label",
  "list_label",
  "list_pull_requests",
  "pull_request_read",
]);

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
    key: GITHUB_BUILTIN_KEY,
    name: "GitHub",
    slug: "github",
    transport: "http",
    credentials: "github-connection",
    description:
      "Issues, pull requests, files, and code search in your repositories, through GitHub's official MCP server. Set up with your GitHub connection.",
    resolveUrl() {
      // Read at connect time, never stored (see client-manager.ts). An operator who sets
      // GITHUB_MCP_URL has vouched for that address, exactly as they vouch for
      // GITHUB_API_URL (which github/client.ts fetches with no guard at all), so
      // the SSRF guard is lifted for it — that is also what lets the unit and
      // e2e fixtures, which listen on loopback, stand in for GitHub.
      const override = process.env.GITHUB_MCP_URL;
      return override
        ? { url: override, allowPrivateNetwork: true }
        : { url: GITHUB_MCP_DEFAULT_URL, allowPrivateNetwork: false };
    },
  },
];

export function catalogEntry(key: string | null | undefined): CatalogEntry | undefined {
  if (!key) return undefined;
  return BUILTIN_CATALOG.find((e) => e.key === key);
}

/** True for a row whose credential comes from another connection, not its own secrets. */
export function isCredentialLinked(row: { builtinKey: string | null }): boolean {
  const entry = catalogEntry(row.builtinKey);
  return entry?.transport === "http";
}

/** The policy a newly discovered tool on this row starts with. */
export function catalogDefaultPolicy(row: { builtinKey: string | null }): (name: string) => ToolPolicy {
  if (row.builtinKey === GITHUB_BUILTIN_KEY) {
    return (name) =>
      GITHUB_READONLY_TOOLS.has(name)
        ? { enabled: true, approval: "allow", readOnly: true }
        : { ...DEFAULT_POLICY };
  }
  return () => ({ ...DEFAULT_POLICY });
}
