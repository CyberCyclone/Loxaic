/**
 * Who may manage, list and use which custom image (#253). Pure: every caller
 * — the routes, workspace creation, sandbox creation — asks these, so the
 * rules exist once.
 *
 * - The policy (`settings.ts`'s `customImages`) gates everything: "off" means
 *   nothing but the built-in image, "shared" adds images an admin loaded, and
 *   "everyone" adds each person's own.
 * - A personal image is its owner's alone. Nobody else — an admin included —
 *   may see, manage or use it, and a conversation uses its *owner's*, never
 *   whoever happens to send the message that creates the sandbox.
 * - Only a row with a digest from its own successful pull, whose check found
 *   nothing missing, can become a container.
 */
import type { CustomImagesPolicy } from "../settings.ts";

export type ImageScope = "shared" | "personal";

export interface ImageCheck {
  /** Tools or conditions Loxaic needs and the image lacks. Any one makes the
   * image unusable. */
  missing: string[];
  /** Things that limit what the image can do, without stopping it. */
  warnings: { code: ImageWarningCode; message: string }[];
}

/** `git`: GitHub workspaces refuse the image. The rest are said, not acted on. */
export type ImageWarningCode = "git" | "gh" | "rg" | "ca" | "path" | "root";

export interface ImageRowLike {
  ownerId: string | null;
  digest: string | null;
  check: unknown;
}

export function scopeOf(row: { ownerId: string | null }): ImageScope {
  return row.ownerId === null ? "shared" : "personal";
}

/** Reads a stored check defensively: jsonb is whatever was written. */
export function readCheck(raw: unknown): ImageCheck | null {
  if (typeof raw !== "object" || raw === null) return null;
  const value = raw as { missing?: unknown; warnings?: unknown };
  if (!Array.isArray(value.missing) || !Array.isArray(value.warnings)) return null;
  const missing = value.missing.filter((m): m is string => typeof m === "string");
  const warnings = value.warnings.flatMap((w) => {
    const item = w as { code?: unknown; message?: unknown } | null;
    if (!item || typeof item.code !== "string" || typeof item.message !== "string") return [];
    return [{ code: item.code as ImageWarningCode, message: item.message }];
  });
  return { missing, warnings };
}

/** Whether the row's last good pull can become a container. */
export function isUsable(row: ImageRowLike): boolean {
  if (!row.digest) return false;
  const check = readCheck(row.check);
  return check !== null && check.missing.length === 0;
}

export function hasGit(row: ImageRowLike): boolean {
  const check = readCheck(row.check);
  return check !== null && !check.warnings.some((w) => w.code === "git");
}

export function scopeAllowed(policy: CustomImagesPolicy, scope: ImageScope): boolean {
  if (policy === "off") return false;
  return scope === "shared" || policy === "everyone";
}

/**
 * Why `ownerId`'s conversation may not run in this image, or null when it may.
 * `ownerId` is the conversation's owner: a shared conversation's editors work
 * in the owner's image, as they work in the owner's GitHub checkout.
 */
export function useRefusal(
  row: ImageRowLike | null,
  policy: CustomImagesPolicy,
  ownerId: string,
  purpose: { github: boolean },
): string | null {
  if (!row) return "That image no longer exists. Choose another one.";
  const scope = scopeOf(row);
  if (scope === "personal" && row.ownerId !== ownerId) return "That image no longer exists. Choose another one.";
  if (!scopeAllowed(policy, scope)) {
    return scope === "shared"
      ? "Custom images are turned off on this server."
      : "Your own images are turned off on this server; an admin allows only shared ones.";
  }
  if (!isUsable(row)) return "That image has not been pulled and checked successfully yet.";
  if (purpose.github && !hasGit(row)) return "That image has no git, which a GitHub workspace needs.";
  return null;
}

/** Why this caller may not manage images of this scope, or null when they may. */
export function manageRefusal(policy: CustomImagesPolicy, scope: ImageScope, isAdmin: boolean): string | null {
  if (scope === "shared") {
    if (!isAdmin) return "Only an admin can manage shared images.";
    return policy === "off" ? "Custom images are turned off. Turn them on under Settings → Agent Sandbox." : null;
  }
  return policy === "everyone" ? null : "Adding your own images is turned off on this server.";
}
