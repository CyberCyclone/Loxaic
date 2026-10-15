# scripts

Workstation-side shell scripts: `envs.sh` deploys the dev and PR-preview environments over SSH (using `infra/envs/compose.yml`), and `release.sh` cuts release tags. These rules are the security and data-safety boundaries of both.

## Environments (`envs.sh`)

- **Deploy only from the workstation over SSH. Never give GitHub (a self-hosted runner, a repository secret, a tunnel) any credential or route to the box.** The repository is public; a fork's PR is a stranger's code.
- Send the slot's configuration (`infra/envs/compose.yml`, `infra/docker/metro.Dockerfile`) from the workstation's own checkout after `git clean`, never from the commit being deployed, or a PR could rewrite the terms it runs under (e.g. mount the Docker socket).
- Environments have unrestricted egress and run the deployed commit's `pnpm install` (and its postinstall scripts) as root. Never deploy a PR you have not read.
- Keep the slot's env file outside the build context: `server.Dockerfile` does `COPY . .` and `.dockerignore` does not exclude `.env`, so the auth secret would land in an image layer.
- The box's address lives only in gitignored `scripts/envs.local` (template: `envs.local.example`). The script refuses to run without it; never add a default host.

## Releases (`release.sh`)

- Cut releases with `scripts/release.sh`; the next tag comes from `apps/desktop/scripts/next-tag.mjs`, never by hand. Pushing the `v*` tag is what triggers `release.yml`.
- Never pipe into `grep -q` under `pipefail`; capture the output, then match with a here-string (`grep -qx … <<< "$out"`).
