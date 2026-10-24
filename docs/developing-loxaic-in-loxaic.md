# Developing Loxaic in Loxaic

`ghcr.io/cybercyclone/loxaic-dev` is a custom sandbox image (#320) for working on Loxaic itself from a Loxaic agent chat. It is Loxaic's own sandbox image with the toolchain Loxaic's tests need:

- Postgres 17
- Chrome for Testing and chromedriver
- Electron's libraries and Xvfb
- a JDK, the Android SDK and an emulator

With it, an agent can run the unit suites and the e2e lanes inside its own sandbox.

It is an ordinary custom image. It replaces nothing and gets no special access, except one optional admin switch (KVM, for the Android emulator). It is built for amd64 only: Google publishes no Chrome or chromedriver for Linux on ARM.

## Set it up (an admin, once)

1. **Turn custom images on.** Settings → Agent Sandbox → Custom images → **Admins load images**, or **Everyone can add their own**.
2. **Turn the sandbox network on**, on the same screen. `pnpm install` and the repository clone need it.
3. **Load the image.** Settings → Container Images → add `ghcr.io/cybercyclone/loxaic-dev:latest`.
   - The package is public, so no login is needed. If it isn't, add a registry login for `ghcr.io` with a GitHub token that can read packages.
   - Wait for **Ready**.
4. **Give the image room.** Set its limits to at least 16384 MB of memory, 8 CPUs and 8192 processes. An e2e lane runs a server, Postgres and a browser; the Android lane adds Gradle and an emulator.
5. **For the Android lane,** turn on **Hardware virtualisation (KVM)** for the image.
   - This needs Loxaic's Docker host to have `/dev/kvm`, which means a Linux machine with virtualisation on. Docker Desktop on a Mac has none.
   - The switch passes that one device and nothing else.
6. **Raise the developer's own allocation.** Admin → Users → their row → Sandboxes, to at least the image's size (16 GB and 8 CPUs).
   - The default allocation (2.5 GB) refuses an image this big, and the chat says so.

## Use it

Start an Agent chat on a GitHub workspace for the Loxaic repository, and choose **loxaic-dev** in the workspace chooser. The checkout is at `~/repo`. The agent runs the tests with `loxaic-test`:

```bash
loxaic-test start install                 # pnpm install, Electron's binary, web_fetch's Chromium
loxaic-test wait --seconds 50             # repeat until it reports passed or failed
loxaic-test start server -- src/agent/__tests__/allocation.test.ts
loxaic-test start web -- --spec ./src/specs/smoke.spec.ts
loxaic-test status
```

How the runner works:
- **Detached runs.** Each lane runs in the background, because a tool call is limited to 60 seconds. `wait` prints what the lane has written since it last looked.
- **One lane at a time.** Lanes share Postgres, port 4055 and the emulator, so `start` refuses a second while one runs.
- **Lanes:**
  - `install`
  - `server`, `mobile`, `desktop`
  - `lint`, `typecheck`
  - `web`, `electron`, `android`
  - `shell -- <command>`, for anything else long.
- **Rebuilds.** `LOXAIC_TEST_REBUILD=1` rebuilds the Electron package or the Android APK.

## What runs differently inside

There is no container engine inside a sandbox, so the copy of Loxaic under test runs its own agents' commands in host mode (`E2E_SANDBOX_MODE=host`). The sandbox around it is the isolation. The specs about the container engine itself skip with a stated reason:
- the custom-image specs;
- the degraded-engine banner.

The server suite's Docker-backed tests skip the same way. iOS can't run on Linux at all. Everything else is the same suite a laptop runs. See `apps/e2e/README.md`, "Inside a Loxaic sandbox".

## Updating the image

The image is defined in `infra/docker/dev/` (the Dockerfile, `loxaic-test.sh` and `selftest.sh`).
- On a pull request touching it, `.github/workflows/dev-image.yml` builds it and runs the selftest under the restrictions Loxaic gives every sandbox.
- On `dev`, the same workflow pushes `:latest` and `:sha-<commit>`.
- In Loxaic, press **Update** on the image to pull the new one.

To build it locally (amd64):

```bash
docker buildx bake -f infra/docker/dev/docker-bake.hcl --load
```
