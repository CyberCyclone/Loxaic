import type { InstanceState } from './endpoint';

/**
 * The server a desktop install is using, as the person would name it, or
 * null off the desktop (no instance state) and before a mode is chosen.
 *
 * Not the renderer's API base URL: for a Tailscale client that is the
 * sidecar's loopback proxy (`http://127.0.0.1:49216`), an address nobody
 * typed, so the host from config.json comes first. For solo and host it is
 * what the server advertises — the tailnet address once that join lands.
 * `mode` is null while the stack is down; `storedMode` still says what
 * config.json holds, and that is when the address matters most.
 */
export function desktopServerAddress(state: InstanceState | null | undefined): string | null {
  if (!state) return null;
  const mode = state.mode ?? state.storedMode;
  if (!mode) return null;
  if (mode === 'client') return state.client?.hostUrl ?? state.apiBaseUrl;
  return state.effectiveAdvertiseUrl ?? state.host?.advertiseUrl ?? state.apiBaseUrl;
}

/**
 * The server to name when a request from this app went unanswered: what the
 * requests actually go to (`endpoint`), except for a desktop client, whose
 * requests go to the tailnet sidecar's loopback — there the host it stands
 * for is the useful name. Solo and Host talk to their own loopback stack, and
 * that is what failed; naming their advertised address would blame the
 * network instead.
 */
export function unreachableServerName(state: InstanceState | null | undefined, endpoint: string | null): string | null {
  const client = (state?.mode ?? state?.storedMode) === 'client';
  return (client ? desktopServerAddress(state) : null) ?? endpoint;
}
