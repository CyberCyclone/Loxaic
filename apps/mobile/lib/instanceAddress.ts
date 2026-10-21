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
export function desktopServerAddress(state: InstanceState | null): string | null {
  if (!state) return null;
  const mode = state.mode ?? state.storedMode;
  if (!mode) return null;
  if (mode === 'client') return state.client?.hostUrl ?? state.apiBaseUrl;
  return state.effectiveAdvertiseUrl ?? state.host?.advertiseUrl ?? state.apiBaseUrl;
}
