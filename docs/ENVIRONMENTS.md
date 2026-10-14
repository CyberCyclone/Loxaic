# Environments on the box

Two environments run on a machine you own, driven by `scripts/envs.sh` from
your workstation — or on the workstation itself, with `ENVS_SSH=local` (below):

| Slot | What it runs | Web / API | Expo Go | Database |
|---|---|---|---|---|
| `preview` | the pull request being reviewed right now | `:42000` | `:42001` | dropped when the slot changes PR |
| `dev` | the trunk, redeployed as `dev` moves | `:43000` | `:43001` | kept |

```bash
./scripts/envs.sh preview up 136     # review PR 136 — replaces whatever is there
./scripts/envs.sh preview sync       # destroy it if its PR has closed
./scripts/envs.sh preview down       # destroy it now
./scripts/envs.sh dev up             # deploy origin/dev; no-op if already current
./scripts/envs.sh dev down           # stop, keeping the database
./scripts/envs.sh list               # both slots: commit, status, URLs
./scripts/envs.sh sync               # preview sync + dev up (what the timer runs)
./scripts/envs.sh dev logs server    # follow a slot's logs
```

## Running them on your workstation (`ENVS_SSH=local`)

Set `ENVS_SSH=local` in `scripts/envs.local` and every command the script would
send over ssh runs in bash on this machine instead; the commit is pushed to a
bare repo under `~/$ENVS_ROOT` rather than the box's. Everything else — the
compose file, the fixed ports, the state files, what `sync` tears down — is the
same code, so a slot behaves identically wherever it runs. Point
`ENVS_HOSTNAME` at this machine's own tailnet name for a phone to reach it.

It is not `ENVS_SSH=you@localhost`: that needs Remote Login switched on, a
security setting nobody should have to change to run a preview. What it does
need is disk: each slot builds a server and a Metro image of about 5 GB between
them, plus build cache, and a laptop runs out long before a server does. The
slots stop when the machine sleeps and come back with Docker, since every
service is `restart: unless-stopped`.

## Why it pulls instead of being pushed to

The obvious design is a GitHub Actions job that deploys to the box: a
self-hosted runner, or an SSH key in repository secrets, or a tunnel. All three
end the same way — something in GitHub holds a credential to a machine on your
home network, and in a public repository a pull request from a fork is
a stranger's code running on hardware you own.

So the direction is inverted. `envs.sh` runs on **your workstation**, which is
already authenticated to GitHub, and pushes to the box over an SSH key you
already have:

- GitHub Actions holds no credential to the box, because it never deploys.
- The box opens no inbound port to the internet, and needs no GitHub account,
  token, or network access of its own — your workstation is the only thing that
  talks to GitHub.
- You decide which pull requests are ever deployed, by typing their number.

A preview still *runs a pull request's code* — that is what a preview is — so
the isolation lives in the environment itself. See "What an environment cannot
reach" below.

## One preview slot, on fixed ports

The Expo Go link is typed into a phone by hand, so it has to be the same link
every time: `exp://<host>:42001`, for every pull request, forever. That is why
there is one slot rather than one environment per PR, and why the ports are
fixed rather than derived from the PR number. `preview up` for a different pull
request replaces what is there.

Two consequences worth knowing:

- **Only one pull request can be previewed at a time.** Reviewing a second one
  takes the first one down.
- **Changing which PR occupies the slot drops the database first.** Two
  branches can carry different migrations, and applying one branch's schema on
  top of the other's data produces failures that belong to neither. Redeploying
  the *same* PR keeps everything, so you stay signed in while you iterate.

The dev slot is the opposite case: its database is long-lived test data and
migrations are forward-only, so moving the trunk forward is never a reason to
drop it. `dev down --volumes` is the only thing that will.

## Setup

Copy `scripts/envs.local.example` to `scripts/envs.local` (gitignored) and fill
in your box's address. Then, once, on the box itself:

```bash
sudo apt-get update && sudo apt-get install -y docker.io docker-compose-v2 curl git
sudo usermod -aG docker "$USER"
```

(`git` because the deploy pushes to a bare repository on the box, and `curl`
because the deploy waits on the server's own `/health` before reporting
success. Ubuntu Server and the Debian cloud images ship neither.)

The group change only applies to a **new** login, so reconnect and confirm the
daemon answers without `sudo`:

```bash
docker version --format '{{.Server.Version}}'
```

That is all the box needs. `envs.sh` creates everything else — a bare repo at
`~/<ENVS_ROOT>/repo.git` and a worktree per slot — on first use.

### Reaching Expo Go from outside the LAN

Expo Go loads a bundle from a live Metro server; it cannot open a published EAS
update, which is built for a runtime version only a real build has. So the
phone has to reach the box. On the same Wi-Fi it already can. From anywhere
else, put both the box and the phone on your tailnet:

```bash
curl -fsSL https://tailscale.com/install.sh | sh && sudo tailscale up
```

Then set `ENVS_HOSTNAME` to the tailnet name. Deploys keep going over the LAN
address in `ENVS_SSH` — fast, and already working — while the URL baked into
the app bundle and advertised by Metro is one that resolves from anywhere.

### A real model for dev, a mock for previews

`DEV_INFERENCE_URL` points the dev slot at a real backend (LM Studio on the box
at `:1234`). The slot's server converts it into an added provider on first boot
— the built-in provider is now the managed llama.cpp runtime, which the slots
turn off (`LLAMA_MODE=off`: no GPU in there). Previews stay on
`MOCK_INFERENCE`, and the two differ on purpose:

- A preview runs **unreviewed** code and exists to check a flow quickly. The
  mock drives the full agent tool loop — approvals, tool calls, the lot —
  without a model, so several previews a day cost nothing.
- The dev slot runs **merged** code, is long-lived, and is what the dev app
  build talks to every day. The things that only show up against a real model —
  tool-call formatting, streaming timing, the prompt-reuse figures — are
  exactly what a standing private environment is for. There is only one dev
  slot, so it cannot queue behind itself.

LM Studio must be set to serve on the LAN rather than loopback, or a container
cannot reach it. With `DEV_INFERENCE_URL` unset the dev slot falls back to mock
and says so.

## What an environment cannot reach

A pull request's code runs here, so two things are deliberately withheld:

- **The Docker socket.** Mounting `/var/run/docker.sock` is what the agent's
  container sandbox would need, and it is equivalent to handing that code root
  on the box. Both slots run `SANDBOX_MODE=off`, and agent tool calls that need
  a sandbox fail with a reason. If you are specifically testing sandbox
  behaviour on a branch you trust, set `PREVIEW_SANDBOX_MODE=host` (or
  `DEV_SANDBOX_MODE=host`) in `scripts/envs.local` and redeploy — and
  understand that you have just given that branch your user account on that
  machine. It belongs in `envs.local` rather than in the slot's env file on the
  box, because every deploy rewrites that file from scratch.
- **Credentials of any kind.** Neither slot is given a key to anything, and the
  dev slot's only outbound dependency is the LM Studio on the same machine.

**What it *can* reach is the network, and that is the real limit of this.** A
preview has unrestricted outbound access in both directions that matter:

- **At build time**, `server.Dockerfile`'s contents come from the deployed
  commit — a pull request can rewrite it — and even untouched it runs that
  commit's `pnpm install`, so that lockfile's postinstall scripts execute as
  root with a network.
- **At run time**, both containers sit on an ordinary bridge network. They can
  reach the box's own LM Studio, anything else on the home LAN — the router, a
  NAS, the other slot's published port — and the whole internet.

So the honest summary is: this is safe against a mistake and against code you
have read, and it is *not* a sandbox for code you have not. Deploying a fork's
pull request means running a stranger's build scripts on your LAN. Read the
diff first, which is the same rule that applies to checking a branch out
locally.

Each slot also gets its own database, its own uploads volume, and its own
`BETTER_AUTH_SECRET`, so a session minted against one is not valid against the
other. Neither database publishes a port.

## Keeping it current

`sync` retires a preview whose pull request has closed and brings the dev slot
level with `origin/dev`. Run it by hand, or from a timer so it happens without
you:

```bash
cat > ~/Library/LaunchAgents/com.loxaic.envs-sync.plist <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.loxaic.envs-sync</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>-lc</string>
    <string>cd ~/Documents/Git/Loxaic && ./scripts/envs.sh sync</string>
  </array>
  <key>StartInterval</key><integer>300</integer>
  <key>StandardOutPath</key><string>/tmp/loxaic-envs-sync.log</string>
  <key>StandardErrorPath</key><string>/tmp/loxaic-envs-sync.log</string>
</dict></plist>
EOF
launchctl load ~/Library/LaunchAgents/com.loxaic.envs-sync.plist
```

The timer lives on your workstation rather than the box for the same reason the
deploy does: it is the machine already allowed to ask GitHub questions. It will
take a preview down within five minutes of its pull request merging — that is
the point, but it surprises once.

## When something looks stale

Expo Go caches a bundle per URL, and the preview URL never changes, so a
redeploy can leave the previous PR's JS on screen. Shake the device → **Reload**.

Two slots mean two image builds on the box. `docker builder prune` reclaims the
layer cache when it grows; `docker image prune` the unused images.
