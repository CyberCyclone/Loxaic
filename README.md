# Loxaic

Self-hosted, multi-user AI platform — an open-source alternative to hosted assistants and
coding agents such as Claude and Claude Code, running on your own hardware: llama.cpp (or any
OpenAI-compatible) inference, a real agent tool-calling loop with sandboxed code execution,
MCP plugin support with the official Brave Search server built in, and one universal client
for iOS, Android, the web and the desktop.

Loxaic is an independent project. It is not affiliated with, endorsed by, or sponsored by
Anthropic, OpenAI, or any other model provider named in this repository.

## Quick start

**Desktop (recommended)** — the self-contained app brings its own Postgres and server, so
there is nothing else to install. Download an installer from
[Releases](https://github.com/CyberCyclone/Loxaic/releases), or build one:

```bash
pnpm install
pnpm --filter @loxaic/desktop package
```

**Docker Compose** — Postgres, Redis, the server (which also serves the web app), inference
and ntfy. Its credentials are fixed development values, so use it to evaluate or develop,
not on a network you do not trust:

```bash
docker compose up --build
```

**Development:**

```bash
pnpm install
pnpm dev --filter=@loxaic/server   # API on :4000 (MOCK_INFERENCE=true needs no model)
pnpm --filter @loxaic/mobile web   # Expo web on :8081
```

The first account to sign up becomes the admin.

## Documentation

**Start here: [`AGENTS.md`](AGENTS.md)** — the source of truth for architecture, conventions,
and gotchas for anyone (human or agent) making changes.

- [`docs/DEPLOY.md`](docs/DEPLOY.md) — running it: server, web, Expo Go, EAS Update, Electron.
- [`docs/RUNTIME.md`](docs/RUNTIME.md) — choosing a container engine (Docker/Podman/OrbStack/Colima) and an inference backend (Mac/Metal, Windows/NVIDIA, Proxmox/ROCm) for your hardware.
- [`docs/REMOTE_ACCESS.md`](docs/REMOTE_ACCESS.md) — reaching your server from Expo Go, a browser, or Electron without opening router ports (Tailscale, or bring your own).

## Contributing

Contributions are welcome — see [`CONTRIBUTING.md`](CONTRIBUTING.md). Every commit needs a
DCO sign-off (`git commit -s`). Please report security issues privately, as described in
[`SECURITY.md`](SECURITY.md), and follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## If you fork this

Two things point at this project's own infrastructure, and a fork that ships its
own builds has to repoint both before building:

- **Mobile updates** — `extra.eas.projectId`, `updates.url` and `owner` in
  `apps/mobile/app.json` name our EAS project, so a fork's app built as-is would
  download *our* over-the-air updates. `npx eas-cli init` in `apps/mobile`
  creates a project of your own.
- **Desktop updates** — `apps/desktop/src/updates/release-repo.cjs` names this
  GitHub repository, which the packaging config bakes into every build's update
  feed, so a fork's desktop app would update itself from our releases.

Everything else forks cleanly — nothing in this repository is a credential, and
the server and web builds need none of the above.

## License

[Apache License 2.0](LICENSE). Third-party components keep their own licences — see
[`NOTICE`](NOTICE).
