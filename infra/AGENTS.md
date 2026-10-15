# infra

Dockerfiles and container entrypoints (`docker/`), the sandbox image and its document extractor (`docker/sandbox.Dockerfile`, `docker/sandbox/extract.py`), the environments' Compose file (`envs/compose.yml`), and the Go `tsnet-proxy` sidecar the desktop embeds. These rules cover what other code depends on in each.

## Sandbox image

- The image needs util-linux `setsid -w` for killing a command's process group (absent from busybox/Alpine); re-check it on any base-image change.
- The image tag is a hash of `sandbox.Dockerfile` and everything under `sandbox/`, so editing either rebuilds every deployment's image once. Anything the Dockerfile `COPY`s must also be staged by `apps/desktop/scripts/build-server.mjs`, or packaged installs fail to build the image.

## Document extraction (`docker/sandbox/extract.py`)

- **Run the zip decompression-bomb guard (entry count, total declared size, per-entry ratio, read from the central directory) before opening any zip-based format.** Every format except PDF and RTF is a zip; never inflate to decide.
- Extraction reads and never executes: no macros, embedded scripts or PDF JavaScript.

## llama.cpp sidecar (`docker/llama-router.sh`, attach mode)

- The server mints `router.key` (0600) in `LLAMA_DIR`; `llama-router.sh` waits for it before starting the router with it. Without the key the router answers any browser tab.
- Compose publishes 4002 on loopback only (`127.0.0.1:4002`); never bind it to `0.0.0.0`.
- The script writes `--list-devices` to `router-devices.txt` and `--help` to `router-help.txt` in the shared volume; the server reads both (CPU warning, extra-option checks). Keep the file names in step with the server.
- The models volume is mounted at the same path in the server and the sidecar, because the preset names model files absolutely.

## Environments (`envs/compose.yml`)

- Slot containers get no Docker socket and no host credentials; never mount `/var/run/docker.sock` (it hands the deployed code the daemon). `scripts/envs.sh` sends this file from the workstation, not from the deployed commit.

## tsnet-proxy

- Its stdout line protocol (`AUTH_URL`, `LISTENING`, `SERVING`, `STATUS`) is parsed by `apps/desktop/src/supervisor/tsnet.js`; change both together.
- The auth key arrives only on stdin (`--auth-key-stdin`), never argv or env.
