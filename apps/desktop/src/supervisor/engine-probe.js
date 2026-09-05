import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Is a container engine reachable right now?
 *
 * Host mode requires one — the server refuses to boot without container
 * isolation (see `hostingBlockedReason`) — so onboarding asks before letting
 * a user commit to a mode that would fail at startup, and says which engines
 * it looked for when the answer is no.
 *
 * Deliberately a socket-existence check rather than a dockerode handshake:
 * the supervisor has no dependency on dockerode (the *server* does), and the
 * question here is "is it worth trying", not "is it healthy". The server's own
 * probe is the authority; this one only keeps the user out of a dead end.
 * The candidate list mirrors container-provider.ts's discovery order.
 */
export function probeContainerEngine() {
  const home = os.homedir();
  const candidates = [
    { name: "Docker", socket: process.env.CONTAINER_SOCKET ?? "/var/run/docker.sock" },
    { name: "Docker Desktop", socket: path.join(home, ".docker/run/docker.sock") },
    { name: "Podman", socket: path.join(home, ".local/share/containers/podman/machine/podman.sock") },
    { name: "Podman (rootless)", socket: `/run/user/${String(process.getuid?.() ?? 0)}/podman/podman.sock` },
    { name: "Colima", socket: path.join(home, ".colima/default/docker.sock") },
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate.socket)) {
      return { ok: true, engine: candidate.name, socket: candidate.socket };
    }
  }
  return {
    ok: false,
    reason:
      "No container engine found. Host mode runs other users' agent commands, " +
      "so it requires Docker or Podman for isolation. Install one and try again — " +
      "or choose Solo, which needs no engine.",
    looked: candidates.map((c) => c.socket),
  };
}
