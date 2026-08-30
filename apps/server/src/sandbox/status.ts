import { getSandboxProvider } from "./provider.ts";
import type { SandboxMode } from "./provider.ts";
import { getSandboxSettings, sandboxDisabledReason } from "../settings.ts";

export interface SandboxStatus {
  mode: SandboxMode;
  available: boolean;
  /** Effective, not raw: host sandboxes run on the host's own network
   * whatever the container-only `allowNetwork` setting says. */
  allowNetwork: boolean;
  reason?: string;
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
  const { mode, allowNetwork } = getSandboxSettings();
  const effectiveAllowNetwork = mode === "host" ? true : allowNetwork;

  if (mode === "off") {
    return { mode, available: false, allowNetwork: effectiveAllowNetwork, reason: sandboxDisabledReason() };
  }

  const provider = await getSandboxProvider();
  const status = (await provider?.available()) ?? { ok: false, reason: "no sandbox provider" };
  return {
    mode,
    available: status.ok,
    allowNetwork: effectiveAllowNetwork,
    ...(status.reason ? { reason: status.reason } : {}),
  };
}
