import { getSandboxProvider } from "./provider.ts";
import { customImagesBlocked } from "../images/store.ts";
import type { SandboxMode } from "./provider.ts";
import { getSandboxRetention, getSandboxSettings, sandboxDisabledReason } from "../settings.ts";
import type { CustomImagesPolicy, SandboxRetention } from "../settings.ts";

export interface SandboxStatus {
  mode: SandboxMode;
  available: boolean;
  /** Effective, not raw: host sandboxes run on the host's own network
   * whatever the container-only `allowNetwork` setting says. */
  allowNetwork: boolean;
  /**
   * How long a workspace survives, so a client can say so *before* someone
   * puts a day's work in one. Not admin-only: these are the terms of the thing
   * the user is about to use, and the alternative is finding out afterwards.
   */
  retention: SandboxRetention;
  reason?: string;
  /** Who may use custom images (#253), and why nobody can right now when the
   * server can't run them (not the container sandbox, not Docker). */
  customImages: CustomImagesPolicy;
  customImagesBlocked?: string;
}

/**
 * The one place that answers "can agent tools run right now, and why not".
 *
 * Both the public `GET /v1/config` and the admin settings view read from
 * here. They previously computed it separately and had already drifted —
 * config applied the host-mode network adjustment and the admin view did
 * not, so the admin screen reported the opposite network posture to the
 * endpoint everything else reads.
 */
export async function getSandboxStatus(): Promise<SandboxStatus> {
  const { mode, allowNetwork, customImages } = getSandboxSettings();
  const effectiveAllowNetwork = mode === "host" ? true : allowNetwork;

  const retention = getSandboxRetention();

  if (mode === "off") {
    return {
      mode,
      available: false,
      allowNetwork: effectiveAllowNetwork,
      retention,
      reason: sandboxDisabledReason(),
      customImages,
      ...(customImages === "off" ? {} : { customImagesBlocked: "Custom images need the container sandbox." }),
    };
  }

  const provider = await getSandboxProvider();
  const status = (await provider?.available()) ?? { ok: false, reason: "no sandbox provider" };
  // Asked only when the policy would allow them, since it means a question
  // to the engine on an unauthenticated route.
  const blocked = customImages === "off" ? null : await customImagesBlocked();
  return {
    mode,
    available: status.ok,
    allowNetwork: effectiveAllowNetwork,
    retention,
    ...(status.reason ? { reason: status.reason } : {}),
    customImages,
    ...(blocked ? { customImagesBlocked: blocked } : {}),
  };
}
