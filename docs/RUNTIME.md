# Runtime: container engine + inference backend

Loxaic runs two ways — see [`DEPLOY.md`](DEPLOY.md) for the full comparison:

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
starting the engine after Loxaic is already running needs no restart.

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

The `loxaic-sandbox` image is built automatically on first use if it isn't
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
| `host` | **No isolation** — commands run directly on the machine Loxaic is on. An explicit opt-in: logs a prominent warning at boot and on first use. Only enable this if you trust everything the agent might be asked to run. |
| `off` | Sandboxed tools are disabled entirely; the agent falls back to read-only/no-tool behavior. |

`GET /v1/config` reports the current mode and whether it's actually usable
right now (`{"sandbox":{"mode":"container","available":false,"reason":"…"}}`)
— useful for a client to show *why* before a tool call fails mid-run.

### What a sandbox can and can't do

Agent tool calls run in a container that is deliberately unprivileged:

| | |
|---|---|
| **User** | non-root (`loxaic`, uid 1001) — cannot write the image's own `/usr/bin`, `/etc`, `/lib` |
| **Capabilities** | none at all (`CapDrop: ALL`), and `no-new-privileges` so none can be regained |
| **Network** | none, unless an admin enables it (see below) |
| **Memory / CPU / pids** | 512 MB, 1 CPU, 100 processes |
| **Per user** | 5 concurrent sandboxes (`SANDBOX_MAX_PER_USER`) |

The root filesystem is deliberately *not* read-only: it would need tmpfs mounts for the working
directory and `/tmp`, whose pages count against the same memory limit, so a large repository
clone or document extraction would be killed rather than isolated — and every system directory
is already unwritable to a non-root user, so it would buy very little.

The per-user cap exists because every other limit is per *container*: without it, one person
with many open conversations could hold several times the whole budget on a shared host. Raise
it with `SANDBOX_MAX_PER_USER` if your host is comfortably provisioned.

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

**Starting an agent chat in a GitHub repository requires this.** The clone
happens inside the sandbox, so a deployment with network off cannot offer it;
the workspace chooser says so and points at this setting. `SANDBOX_EXTRA_HOSTS`
(`name:ip`, comma-separated; `host-gateway` is accepted as an ip) adds
`/etc/hosts` entries to networked sandboxes, for reaching a service on the host
machine by name from Linux or Podman. Which token that clone uses, and what it
has to be allowed to do, is the next section.

### Connecting GitHub (which token, and which permissions)

Agent chats that work in one of your repositories need a GitHub personal access
token, connected per user under **Settings → GitHub**. A token rather than a
GitHub app: there is nothing to register, no callback URL, and it works the same
for a deployment nobody outside it can reach.

**Both kinds of token work.**

| What Loxaic does | Fine-grained token | Classic token |
|---|---|---|
| List and find your repositories | Metadata: Read | `repo` |
| List branches, clone the repo | Contents: Read | `repo` |
| Push your branch | Contents: Read and write | `repo` |
| Open a pull request | Pull requests: Read and write | `repo` |

Metadata: Read is mandatory and GitHub adds it for you as soon as you select any
other repository permission. In practice a fine-grained token wants **Contents:
Read and write** plus **Pull requests: Read and write**.

#### Two fine-grained settings that are easy to miss

- **Repository access.** Either "All repositories", or "Only select
  repositories" with every repo you intend to work in listed. A repo that is not
  on that list does not exist as far as the token is concerned.
- **Resource owner.** Yourself, for your own repos. For an organisation's repo
  you have to pick the organisation, that organisation has to allow fine-grained
  tokens at all, and an owner may have to approve your token before it starts
  working. Until then it is `pending` and answers as though it had no access.

#### Why "Connected" is not the same as "it works"

Connecting validates the token by asking GitHub who you are, and GitHub answers
that for a fine-grained token holding **no permissions whatsoever**. So a green
"Connected" proves the token is yours and nothing else. Two further things
compound it: fine-grained tokens report no scope list, so the connection screen
has nothing to show you, and listing a repository needs only Metadata, so a repo
you cannot actually clone still appears in the picker.

The clone is where it used to surface, inside a sandbox, minutes later, reported
only as GitHub's own misleading wording:

```
remote: Write access to repository not granted.
```

That message says *write* even when the missing permission is **Contents: Read**
and the operation was a read-only clone. Loxaic now checks Contents when you
pick a repository, so a token that cannot reach the code is refused up front,
naming the permission to add, rather than failing in a container later.

### How long a workspace lasts

An agent's sandbox is where its work actually lives — the files it edited, the
repo it checked out, the dependencies it installed — so it is kept, not
cleaned up:

| After | What happens | Default | Setting |
|---|---|---|---|
| Idle for a while | The container **stops**. Nothing is lost; the next message starts it again exactly as it was | 4 hours | `idleStopMs` / `SANDBOX_IDLE_STOP_MS` |
| Unused for a long time | The workspace is **deleted**, along with anything uncommitted in it | 30 days | `reapAfterMs` / `SANDBOX_REAP_AFTER_MS` |
| The conversation is deleted | The workspace is deleted immediately | — | — |

Deleting on the long timer can be switched off entirely (`reapEnabled` /
`SANDBOX_REAP_ENABLED`), in which case workspaces are kept until their
conversation is. That trades disk for certainty, and which way to trade is a
deployment decision — a machine hosting a team accumulates a stopped container
per conversation that ever ran a tool.

Stopped workspaces cost disk, not memory or CPU, and do not count against the
per-user sandbox cap (`SANDBOX_MAX_PER_USER`), which is about running ones. The
retention terms are shown to users in the agent Inspector before they start
work, and a workspace nearing deletion says when.

Durations are stored and pinned in **milliseconds**; the settings screen shows
hours and days. `reapAfterMs` must be longer than `idleStopMs` — a workspace is
always paused before it can be deleted — and the API rejects a pair that isn't.

### How many chats can use the model at once

Local model servers cache the *prompt prefix* of the last request they served.
Two conversations taking turns therefore evict each other's cache and both pay
a full prompt re-evaluation on every message — on a 14.5k-token thread that is
the difference between 312 ms and 14.5 seconds, per step.

So runs queue. A chat beyond the limit waits and is shown its place ("Queued ·
#2") rather than appearing stuck. A run that stops to ask permission for a tool
gives its place up while it waits for you and takes it back first afterwards.

The limit follows the model server by default:

| Backend | Resolved limit |
|---|---|
| `llama.cpp --parallel N` | N — it really does keep N prompt caches |
| LM Studio | 1 — it reports nothing about slots |
| Anything else | 1 |

An admin can pin a number in **Settings → Agent Sandbox → Concurrent runs**, or
a deployment can pin it with `INFERENCE_MAX_CONCURRENT_RUNS`. Setting it higher
than the server can actually hold makes *every* conversation slower and reports
no error, so raise it only to match a `--parallel` you actually configured.

### Hosting for others requires a container engine

The desktop app runs in one of three modes, chosen at first launch and stored
in `<dataDir>/config.json`:

| Mode | What it is | Container engine |
|---|---|---|
| **Solo** | The self-contained app for one person on one machine | Not required — `SANDBOX_MODE` stays fully flexible (`off`/`host`/`container`) |
| **Host** | The same stack, exposed so other people sign in and use its models | **Required.** The server refuses to boot otherwise |
| **Client** | No local stack; joins a host by URL | Not applicable |

The Host requirement is enforced in three places, so it can't be sidestepped:
onboarding won't complete without a reachable engine, a server started with
`LOXAIC_HOSTING=1` and a non-container sandbox mode **fails its boot** with a
named error, and `PATCH /v1/admin/settings/sandbox` refuses to switch away
while hosting.

The reason is narrow and worth stating plainly: hosting means running *other
people's* model-directed commands on your machine. `host` mode has no
isolation at all (it says so itself — commands run directly on the host, with
its filesystem and network), and `off` leaves no isolation story for a later
switch. Neither is defensible once the work isn't yours. A Solo install is
your own machine running your own commands, so it keeps the choice.

### The terminal

The agent screen has a terminal panel (the `>_` button in its header, once a
conversation has a workspace). It opens a shell **in that workspace**, wherever
it is: a container sandbox on the server, a host-mode directory, or a folder on
your own machine.

What you get depends on where it opened, and the panel says which:

| Workspace | Shell | What that means |
|---|---|---|
| Container sandbox | Real terminal (PTY) | Prompt, colour, `Ctrl-C`, arrow keys, `vim` — click into it and type |
| Host mode, or a local workspace | Bash over pipes | Commands run and output comes back, but there is **no prompt and nothing echoes**; use the line input at the bottom |

A local workspace with container isolation opens its shell *inside* that
container, so `pwd` is `/home/loxaic/repo` rather than the folder's path on
your machine — the folder is mounted there.

The pipe-mode limitation is deliberate rather than unfinished: a real terminal
on those two would need a native module (`node-pty`), and the packaged desktop
app runs its server and executor under Electron's own Node, where a binding
built for system Node will not load. A container gets a PTY for free because
the terminal lives inside the container.

Two more things worth knowing:

- The terminal opens where the agent's own commands run — the checkout, not the
  home directory above it. Under container mode that changed in #62; a
  `POST /v1/sandboxes/:id/exec` with no `workdir` now lands in
  `/home/loxaic/repo` too, matching host mode and the documented contract.
- Opening the panel never *creates* a workspace. If the conversation has not run
  a tool yet there is nothing to open, and it says so; a paused workspace is
  resumed.

### Local workspaces: an agent working in a folder on *your* machine

From the desktop app, an agent conversation can run in a folder on the machine
you are sitting at — even when the model and the server are somewhere else.
The desktop app keeps a small **executor** process connected to the server
(`/ws/executor`), and a conversation whose workspace is **Local** sends its
tool calls there instead of to a server sandbox.

- It works in every desktop mode, **Client included**: a laptop joined to a GPU
  box can have the agent edit a project on the laptop.
- Folders are chosen with the OS's own folder dialog, in the workspace chooser
  ("Choose a folder on this machine…"). Nothing else can add one — not the
  server, not a page. The executor refuses anything outside those folders,
  resolving symlinks, on every request.
- Two isolation choices, made at chat start and fixed afterwards:
  - **Direct** — commands run as you, in that folder, with no sandbox. Fast,
    and everything on your machine is reachable.
  - **Container** — the folder is mounted into a container on your machine and
    the agent sees it and nothing else of your filesystem. Offered only when
    Docker or Podman is running there; the first one builds the sandbox image,
    which takes a few minutes.
  Either way, anyone you share the chat with as an editor is running commands
  on your machine — the chooser says so.
- The server's own sandbox settings (`SANDBOX_MODE`, network access, the Host
  requirement above) do not apply: nothing runs on the server.
- Close the desktop app and the machine goes offline; a tool call then fails
  with "Your machine … is offline — open the Loxaic desktop app there and try
  again" rather than waiting. Nothing in the folder is ever deleted by Loxaic.
- Where things live: chosen folders in `<dataDir>/executor-roots.json`; the
  executor itself is `dist/executor.js` beside the bundled server, so a dev
  launch needs `pnpm --filter @loxaic/desktop build:server` first (the chooser
  says so if it is missing).

### Where settings live

Sandbox configuration resolves **environment variable > stored setting >
default**:

- **Stored** — what an admin sets in **Settings → Agent Sandbox**, saved in the
  `server_settings` table and applied at runtime (no restart). Requires the
  admin role; other users see a read-only status view.
- **Environment** — `SANDBOX_MODE`, `CONTAINER_SOCKET`, `SANDBOX_ALLOW_NETWORK`,
  `SANDBOX_IDLE_STOP_MS`, `SANDBOX_REAP_ENABLED`, `SANDBOX_REAP_AFTER_MS`,
  `INFERENCE_MAX_CONCURRENT_RUNS` pin their field. A pinned field is rejected by the API (`409`) and shown as
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
RTF, EPUB, and PDF are all extracted inside the same `loxaic-sandbox` image
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
open Loxaic.dmg   # or: ./loxaic --headless

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
