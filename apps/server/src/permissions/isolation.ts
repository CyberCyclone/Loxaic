/**
 * Whether a conversation's commands run somewhere that truly contains them —
 * the one fact auto mode needs to decide between running a command unasked
 * and sending it to the permission check (bash/policy.ts).
 *
 * Isolated means a server container with no network: its worst outcome is a
 * wrecked, disposable directory. Everything else is not:
 * - a networked container (and every GitHub workspace, which needs the
 *   network to clone) can send the workspace anywhere;
 * - a host-mode sandbox has no isolation at all;
 * - a local workspace runs on the person's own machine, directly or in a
 *   container that always has the network.
 *
 * Judged from the sandbox row when there is one — its network is fixed for
 * its life — and otherwise from what the next sandbox would get.
 */
import { and, db, desc, eq, ne } from "@loxaic/db";
import { sandboxes } from "@loxaic/db/schema";
import type { Workspace } from "@loxaic/types";
import { loadWorkspace } from "../agent/workspace.ts";
import { getSandboxMode } from "../sandbox/provider.ts";
import { getSandboxSettings } from "../settings.ts";
import { CONTAINER_WORKDIR } from "../sandbox/container-engine.ts";

export interface Isolation {
  isolated: boolean;
  /** Where the workspace's own files are, as absolute paths a tool might name.
   * A write anywhere else is checked in auto mode outside isolation. Empty
   * when not known ahead of the sandbox (host mode). */
  roots: string[];
}

export async function isolationFor(conversationId: string): Promise<Isolation> {
  const workspace: Workspace = (await loadWorkspace(conversationId).catch(() => null))?.workspace ?? { kind: "scratch" };
  if (workspace.kind === "local") {
    return { isolated: false, roots: workspace.isolation === "container" ? [CONTAINER_WORKDIR] : [workspace.path] };
  }
  const mode = getSandboxMode();
  if (mode !== "container") return { isolated: false, roots: [] };
  const roots = [CONTAINER_WORKDIR];
  if (workspace.kind === "github") return { isolated: false, roots };
  const row = await db.query.sandboxes
    .findFirst({
      where: and(eq(sandboxes.conversationId, conversationId), ne(sandboxes.status, "destroyed")),
      orderBy: desc(sandboxes.createdAt),
      columns: { provider: true, limits: true },
    })
    .catch(() => undefined);
  if (row) {
    const network = (row.limits as { network?: unknown } | null)?.network;
    return { isolated: row.provider === "container" && network === false, roots };
  }
  return { isolated: !getSandboxSettings().allowNetwork, roots };
}

/**
 * Whether a file write in auto mode outside isolation should be checked like a
 * command: anything in `.git` (hooks, config: a later `git status` would run
 * what was planted there), outside the workspace (a home directory's dotfiles
 * and `~/.local/bin` change what every later command runs), or named in a way
 * that can't be placed (`~`, `..`).
 */
export function isSensitiveWrite(path: string, roots: readonly string[]): boolean {
  const segments = path.split("/");
  if (path.startsWith("~") || segments.includes("..") || segments.includes(".git")) return true;
  if (!path.startsWith("/")) return false;
  return !roots.some((root) => path === root || path.startsWith(`${root.replace(/\/+$/, "")}/`));
}
