# Open-Shannon

Self-hosted, multi-user AI platform — an open-source Claude + Claude Code replacement running
on your own hardware (llama.cpp inference, custom agent harness, sandboxed code execution,
MCP plugin support with the official Brave Search server built in, offline-first clients with
conversation forks).

**Start here: [`HANDOVER.md`](HANDOVER.md)** — architecture, run matrix, deploy story,
and known gaps. **[`AGENTS.md`](AGENTS.md)** has conventions and gotchas for anyone
(human or agent) making changes.

- [`docs/DEPLOY.md`](docs/DEPLOY.md) — running it: server, web, Expo Go, EAS Update, Electron.
- [`docs/RUNTIME.md`](docs/RUNTIME.md) — choosing a container engine (Docker/Podman/OrbStack/Colima) and an inference backend (Mac/Metal, Windows/NVIDIA, Proxmox/ROCm) for your hardware.
- [`docs/REMOTE_ACCESS.md`](docs/REMOTE_ACCESS.md) — reaching your server from Expo Go, a browser, or Electron without opening router ports (Tailscale, or bring your own).
