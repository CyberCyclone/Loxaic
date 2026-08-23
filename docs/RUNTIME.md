# Runtime: container engine + inference backend

Shannon needs two things from the host it runs on: a container engine (for
Postgres and disposable agent sandboxes) and an inference backend (llama.cpp).
Neither is locked to a specific product — pick what fits your hardware.

## Container engine

The server talks to containers through [dockerode](https://github.com/apocas/dockerode),
which speaks the **Docker Engine API** — not "Docker" specifically. Any engine
that exposes that API works. Point the server at it with `CONTAINER_SOCKET` in
`.env` (see [`.env.example`](../.env.example)); leave it empty to use the
default `/var/run/docker.sock`.

| Engine | Platforms | Socket | Notes |
|---|---|---|---|
| **Docker Desktop** | Mac, Windows, Linux | default | Easiest on Mac/Windows. Free for personal/small-business use. |
| **OrbStack** | Mac | default (drop-in) | Lighter/faster than Docker Desktop on Mac; fully compatible. |
| **Colima** | Mac, Linux | `~/.colima/default/docker.sock` | Free, open-source Docker Desktop alternative. |
| **Podman** | Linux, Mac, Windows | `podman machine` prints the socket path | Fully open-source, daemonless. Rootless by default. |
| **Docker Engine (native)** | Linux, Proxmox LXC/VM | default | What you're likely running on a Proxmox host or VM already. |

Only Postgres and the `shannon-sandbox` image need the container engine —
inference does not go through it (see below), so this choice has no bearing on
GPU access for the model.

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

## Putting it together

`docker-compose.yml` covers Postgres + the sandbox image unconditionally; the
`inference` service is a convenience default (CPU-friendly llama.cpp image) —
override or replace it per the table above. Set `CONTAINER_SOCKET` only if
you're not using the default Docker Desktop/Engine socket location.

```bash
# Mac: native inference, Docker Desktop/OrbStack for everything else
llama-server --host 0.0.0.0 --port 4002 --jinja -m model.gguf -ngl 999 &
docker compose up db server   # skip the `inference` service

# Proxmox / AMD ROCm: everything in Docker
docker compose -f docker-compose.yml -f docker-compose.rocm.yml up -d

# Podman anywhere
podman machine start
export CONTAINER_SOCKET=$(podman machine inspect --format '{{.ConnectionInfo.PodmanSocket.Path}}')
docker compose up -d   # `docker compose` works fine against a podman socket via podman-compose or docker-compose + DOCKER_HOST
```

See [`docs/REMOTE_ACCESS.md`](REMOTE_ACCESS.md) for exposing whichever setup
you land on to other devices.
