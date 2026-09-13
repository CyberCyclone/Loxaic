# Loxaic

Self-hosted, multi-user AI platform — an open-source Claude + Claude Code replacement running
on your own hardware (llama.cpp inference, custom agent harness, sandboxed code execution,
MCP plugin support with the official Brave Search server built in, offline-first clients with
conversation forks).

**Start here: [`AGENTS.md`](AGENTS.md)** — the source of truth for architecture, conventions,
and gotchas for anyone (human or agent) making changes. ([`HANDOVER.md`](HANDOVER.md) is a
legacy document kept for historical context only.)

- [`docs/DEPLOY.md`](docs/DEPLOY.md) — running it: server, web, Expo Go, EAS Update, Electron.
- [`docs/RUNTIME.md`](docs/RUNTIME.md) — choosing a container engine (Docker/Podman/OrbStack/Colima) and an inference backend (Mac/Metal, Windows/NVIDIA, Proxmox/ROCm) for your hardware.
- [`docs/REMOTE_ACCESS.md`](docs/REMOTE_ACCESS.md) — reaching your server from Expo Go, a browser, or Electron without opening router ports (Tailscale, or bring your own).

## If you fork this

The mobile app's beta and production builds verify over-the-air updates against the signing
certificate committed at [`apps/mobile/certs/certificate.pem`](apps/mobile/certs/certificate.pem).
That is a public key — it is embedded in every build and proves an update came from this
project's keyholder — but it means a fork built as-is trusts **our** key and no other, and
`apps/mobile/app.json` still points `updates.url` at our EAS project.

So a fork that intends to ship its own builds needs its own identity:

```bash
cd apps/mobile
npx expo-updates codesigning:generate \
  --key-output-directory keys --certificate-output-directory certs \
  --certificate-validity-duration-years 20 --certificate-common-name "Your Project"
```

Commit the new `certs/certificate.pem`, keep `keys/private-key.pem` out of git (it already is
— see `.gitignore`) and out of any CI secret a pull request can reach, and point
`extra.eas.projectId`, `updates.url` and `owner` in `app.json` at your own EAS project.
Changing the certificate changes the runtime version by design, so your first build starts a
fresh update lineage rather than colliding with ours.

Everything else forks cleanly — nothing in this repository is a credential, and the server,
desktop and web builds need none of the above.
