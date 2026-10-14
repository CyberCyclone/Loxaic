# scripts

Workstation-side shell scripts: `envs.sh` deploys the dev and PR-preview environments over SSH (using `infra/envs/compose.yml`), and `release.sh` cuts release tags. These rules are the security and data-safety boundaries of both.

## Environments (`envs.sh`)

- **Deploy only from the workstation over SSH. Never give GitHub (a self-hosted runner, a repository secret, a tunnel) any credential or route to the box.** The repository is public; a fork's PR is a stranger's code.
- Send the slot's configuration (`infra/envs/compose.yml`, `infra/docker/metro.Dockerfile`) from the workstation's own checkout after `git clean`, never from the commit being deployed, or a PR could rewrite the terms it runs under (e.g. mount the Docker socket).
- Environments have unrestricted egress and run the deployed commit's `pnpm install` (and its postinstall scripts) as root. Never deploy a PR you have not read.
- Keep the slot's env file outside the build context: `server.Dockerfile` does `COPY . .` and `.dockerignore` does not exclude `.env`, so the auth secret would land in an image layer.
- The box's address lives only in gitignored `scripts/envs.local` (template: `envs.local.example`). The script refuses to run without it; never add a default host.
- There is one preview slot on fixed ports (the Expo URL `exp://<host>:42001` is typed by hand); `preview up` replaces it rather than adding a second.
- Metro listens on its published port inside the container too (no `42001:8081` mapping): Expo advertises its own listening port.
- Changing which PR is previewed drops the preview database first (branches carry different migrations); redeploying the same PR keeps its volumes. Never drop the dev slot's volumes except via `dev down --volumes`.
- When the preview slot's state cannot be read, refuse rather than proceed. `sync` tears a slot down only on a definite `CLOSED` or `MERGED`; any other answer, including none, leaves it alone.
- The dev slot runs a real model; previews set `SLOT_MOCK_INFERENCE` and run the mock.

## Releases (`release.sh`)

- Cut releases with `scripts/release.sh`; the next tag comes from `apps/desktop/scripts/next-tag.mjs`, never by hand. Pushing the `v*` tag is what triggers `release.yml`.
- `next-tag.mjs` continues betas on an unreleased line and refuses a plain bump while a newer beta is outstanding (use `promote`).
- `promote` tags the beta's own commit, not `dev`'s head: what ships is what testers ran.
- Never pipe into `grep -q` under `pipefail`; capture the output, then match with a here-string (`grep -qx … <<< "$out"`).
