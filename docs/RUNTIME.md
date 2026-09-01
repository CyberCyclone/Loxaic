# Runtime: container engine + inference backend

Shannon runs two ways — see [`DEPLOY.md`](DEPLOY.md) for the full comparison:

- **Self-contained** (the packaged desktop app, or its `--headless` /
  `headless.js` entry): embeds its own Postgres, no container engine needed
  to chat at all. A container engine is only relevant for the **Code/Agent**
  feature's sandboxed tool execution — and even that has a no-isolation
  fallback that needs no engine (`SANDBOX_MODE=host`, see below).
- **Docker Compose**: containers for everything — Postgres, agent sandboxes,
  and (optionally) inference.

Either way, the pieces below — which container engine, and which inference
backend — are independent choices; pick what fits your hardware.

## Container engine (agent sandboxes)

The server talks to containers through [dockerode](https://github.com/apocas/dockerode),
which speaks the **Docker Engine API** — not "Docker" specifically. Any engine
that exposes that API works, and is **auto-discovered**: the default socket is
tried first, then common Podman locations (rootless on Linux, the
`podman machine` socket on macOS/Windows), then Colima's — re-probed live, so
starting the engine after Shannon is already running needs no restart.

An admin can also pick the engine explicitly in the app (**Settings → Agent
Sandbox**): Docker and Podman are offered as choices, with whichever isn't
installed greyed out, plus a Custom option that takes a socket path. That
choice is stored server-side and applied without a restart. Setting
`CONTAINER_SOCKET` in `.env` (see [`.env.example`](../.env.example)) pins the
socket instead and makes the GUI control read-only — see
[Where settings live](#where-settings-live) below.

| Engine | Platforms | Socket | Notes |
|---|---|---|---|
| **Docker Desktop** | Mac, Windows, Linux | default | Easiest on Mac/Windows. Free for personal/small-business use. |
| **OrbStack** | Mac | default (drop-in) | Lighter/faster than Docker Desktop on Mac; fully compatible. |
| **Colima** | Mac, Linux | `~/.colima/default/docker.sock` | Free, open-source Docker Desktop alternative. |
| **Podman** | Linux, Mac, Windows | auto-discovered, or `podman machine inspect` prints it | Fully open-source, daemonless. Rootless by default. |
| **Docker Engine (native)** | Linux, Proxmox LXC/VM | default | What you're likely running on a Proxmox host or VM already. |

The `shannon-sandbox` image is built automatically on first use if it isn't
already present (from `infra/docker/sandbox.Dockerfile`, or a copy the
packaged app ships) — nothing needs to build it ahead of time. Only agent
sandboxes need the engine — inference does not go through it (see below), so
this choice has no bearing on GPU access for the model.

### No engine? `SANDBOX_MODE`

`SANDBOX_MODE` picks how agent tool calls (bash, fs_read/write/edit, grep,
glob) actually run:

| Mode | Behavior |
|---|---|
| `container` (default) | Isolated via the engine above. If none is reachable, sandboxed tool calls fail with an instructive message (which engine/socket was tried, and the two ways to fix it) — chat and everything else keeps working. |
| `host` | **No isolation** — commands run directly on the machine Shannon is on. An explicit opt-in: logs a prominent warning at boot and on first use. Only enable this if you trust everything the agent might be asked to run. |
| `off` | Sandboxed tools are disabled entirely; the agent falls back to read-only/no-tool behavior. |

`GET /v1/config` reports the current mode and whether it's actually usable
right now (`{"sandbox":{"mode":"container","available":false,"reason":"…"}}`)
— useful for a client to show *why* before a tool call fails mid-run.

### Sandbox network access

Sandbox containers get **no network** by default (`NetworkMode: none`):
everything running in there was directed by the model, so an outbound
connection is an exfiltration path. An agent that needs to install
dependencies (`npm install`, `pip install`) needs it turned on — an admin can
do that in **Settings → Agent Sandbox**, or a deployment can pin it with
`SANDBOX_ALLOW_NETWORK=1`.

Two things to know: it takes effect on the *next* sandbox (a container's
network mode is fixed at creation, so changing the setting stops the running
ones), and it does not apply to host mode, where sandboxes always have the
host's own network. `web_fetch` is unaffected either way — it always runs on
the server, behind an SSRF guard, never in the sandbox.

### Where settings live

Sandbox configuration resolves **environment variable > stored setting >
default**:

- **Stored** — what an admin sets in **Settings → Agent Sandbox**, saved in the
  `server_settings` table and applied at runtime (no restart). Requires the
  admin role; other users see a read-only status view.
- **Environment** — `SANDBOX_MODE`, `CONTAINER_SOCKET`, `SANDBOX_ALLOW_NETWORK`
  pin their field. A pinned field is rejected by the API (`409`) and shown as
  "set by environment" in the GUI, so a Compose file, systemd unit, or the
  desktop supervisor stays authoritative when it sets something explicitly.

A deployment that sets none of these is fully configurable from the app; one
that sets all of them ignores the GUI entirely. Both are supported.

## Postgres

**Self-contained**: embedded automatically (via [`embedded-postgres`](https://www.npmjs.com/package/embedded-postgres)) —
data lives under the app's user-data directory, on an ephemeral localhost
port chosen at startup. No container engine, no separate install, nothing to
configure. See [`DEPLOY.md`](DEPLOY.md) for the exact data-dir/port defaults
and how they coexist with a dev stack on the same machine.

**Docker Compose**: unchanged — the `db` service (`postgres:17-alpine`), same
as always.

## Inference backend

`llama.cpp` is launched with `--jinja` for tool-calling support. Where it runs
is controlled by `INFERENCE_BASE_URL` and is fully decoupled from the container
engine above — set it to wherever your `llama-server` (or the Docker Compose
`inference` service) is listening.

**Containers on macOS cannot access the GPU** (no Metal passthrough), so a
containerized llama.cpp on a Mac would be CPU-only. Run it natively there.

| Platform / GPU | Recommended setup |
|---|---|
| **macOS (Apple Silicon)** | Run `llama-server` **natively** with Metal: `brew install llama.cpp` or build from source, then `llama-server --host 0.0.0.0 --port 4002 --jinja -m model.gguf -ngl 999`. Set `INFERENCE_BASE_URL=http://localhost:4002`. |
| **Windows / NVIDIA** | Either a CUDA-enabled `llama.cpp` container (via Docker Desktop + WSL2 GPU passthrough) or the native Windows binary from the llama.cpp releases. Both work with the default `docker-compose.yml` `inference` service if you swap the image for a CUDA build. |
| **Linux / Proxmox / AMD (ROCm)** | Use the provided override: `docker compose -f docker-compose.yml -f docker-compose.rocm.yml up -d`. Tuned for the AMD V620 (gfx1030, `HSA_OVERRIDE_GFX_VERSION=10.3.0`) — adjust that value for other RDNA2/3 cards per the [ROCm gfx compatibility table](https://rocm.docs.amd.com/en/latest/reference/gpu-arch-specs.html). |
| **Linux / NVIDIA** | The default `docker-compose.yml` `inference` image, or swap for a CUDA build + `--gpus all` in a compose override, similar to the ROCm one. |

## Vision models

Picture attachments (see the composer's **+** button) are always sendable, but
the loaded model only *sees* them if `llama-server` was started with a
multimodal projector. Without one, llama.cpp rejects the request and the chat
shows a friendly "this model can't see images" message instead of failing
silently — the message and image are still saved either way.

A vision model is two files: the main GGUF and its `mmproj` (multimodal
projector) GGUF, usually published in the same Hugging Face repo. Pass both to
`llama-server`:

```bash
# Native (e.g. macOS/Metal)
llama-server --host 0.0.0.0 --port 4002 --jinja \
  -m Qwen2.5-VL-7B-Instruct-Q4_K_M.gguf \
  --mmproj Qwen2.5-VL-7B-Instruct-mmproj-F16.gguf \
  -ngl 999
```

For the Docker Compose `inference` service, drop both GGUFs into `./models/`
and add the flag to `command`:

```yaml
  inference:
    command: >
      --host 0.0.0.0 --port 8080
      -m /models/model.gguf
      --mmproj /models/mmproj.gguf
      --ctx-size 8192
      --jinja
```

Any llama.cpp-supported VLM works (Qwen2.5-VL, Gemma 3, LLaVA, etc.) as long
as the `mmproj` file matches the main model's release.

## Document attachments

Plain text, Markdown, CSV, JSON, HTML, and source-code attachments always
work — they're just UTF-8 bytes, decoded on the server with no parser
involved, so they need nothing extra beyond a running server.

**PDF and Office formats need a container sandbox.** DOCX, XLSX, PPTX, ODT,
RTF, EPUB, and PDF are all extracted inside the same `shannon-sandbox` image
agent tool calls use, never on the server itself — so `SANDBOX_MODE` must be
`container`, with an engine actually reachable (see
[Container engine](#container-engine-agent-sandboxes) above).

**`host` does not count for this.** It runs tools directly on the machine, so a
parser reading an untrusted document there is reading it on the server, with the
host's own filesystem and network and none of the container's limits. Under
`host` or `off`, those uploads are rejected outright rather than stored as files
nothing can safely read, and the app shows a modal explaining why. Every text
format above still works regardless of the sandbox setting.

Nothing extra needs installing for this: the extraction tooling is baked into
the sandbox image, which builds itself on first use. The image tag is derived
from a hash of its build inputs, so changing the Dockerfile or the extraction
script rebuilds it automatically rather than leaving an already-built host on
a stale image.

The extracted text is what actually reaches the model — inlined as plain
text, the same way an OpenAI-compatible backend has no other way to accept a
document. Extraction is **text only**, matching what Claude does with the same
formats: images embedded in a document are not read or interpreted. There's no
rendering step and no `mmproj` equivalent for documents, so a scanned or
image-only PDF with no text layer — or a DOCX that is one big screenshot —
extracts to nothing useful, the same limitation the underlying tools have.

## Putting it together

```bash
# Self-contained app: no container engine needed at all to chat.
# For agent sandboxes, install Docker or Podman — nothing else to configure,
# it's auto-discovered. Without one, SANDBOX_MODE=host or =off still work.
open Open-Shannon.dmg   # or: ./open-shannon --headless

# Docker Compose — Mac: native inference, Docker Desktop/OrbStack for everything else
llama-server --host 0.0.0.0 --port 4002 --jinja -m model.gguf -ngl 999 &
docker compose up db server   # skip the `inference` service

# Docker Compose — Proxmox / AMD ROCm: everything in Docker
docker compose -f docker-compose.yml -f docker-compose.rocm.yml up -d

# Docker Compose — Podman anywhere
podman machine start
docker compose up -d   # CONTAINER_SOCKET is usually unnecessary now (auto-discovered);
                        # `docker compose` itself still needs DOCKER_HOST or podman-compose
```

See [`docs/REMOTE_ACCESS.md`](REMOTE_ACCESS.md) for exposing whichever setup
you land on to other devices.
