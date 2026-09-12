# Pull request previews

Every open pull request can have a running environment of its own — a server, a
database, and a Metro dev server that Expo Go can open — on a machine you
control. `scripts/preview.sh` is the whole interface.

```bash
./scripts/preview.sh up 136     # deploy PR 136
./scripts/preview.sh list       # what is running
./scripts/preview.sh logs 136   # follow its logs
./scripts/preview.sh down 136   # destroy it, volumes and all
./scripts/preview.sh sync       # destroy every preview whose PR has closed
```

## Why it pulls instead of being pushed to

The obvious design is a GitHub Actions job that deploys to the box: a
self-hosted runner, or an SSH key in repository secrets, or a tunnel. All three
end the same way — something in GitHub holds a credential to a machine on your
home network, and once this repository is public, a pull request from a fork is
a stranger's code running on hardware you own.

So the direction is inverted. `preview.sh` runs on **your workstation**, which
is already authenticated to GitHub, and pushes to the host over an SSH key you
already have:

- GitHub Actions holds no credential to the host, because it never deploys.
- The host opens no inbound port to the internet, and needs no GitHub account,
  token, or network access of its own — your workstation is the only thing that
  talks to GitHub.
- You decide which pull requests are ever deployed, by typing their number.

A preview still *runs a pull request's code* — that is what a preview is — so
the isolation lives in the environment itself. See "What a preview cannot
reach" below.

## Host setup

Once, on the machine that will run the previews (`192.168.1.13` by default):

```bash
sudo apt-get update && sudo apt-get install -y docker.io docker-compose-v2 curl
sudo usermod -aG docker "$USER"
```

The group change only applies to a **new** login, so log out and back in — or
just reconnect over SSH — and confirm the daemon answers without `sudo`:

```bash
docker version --format '{{.Server.Version}}'
```

That is all the host needs. `preview.sh` creates everything else (a bare repo
at `~/loxaic-previews/repo.git`, one worktree per PR) on first use.

### Reaching Expo Go from outside the LAN

Expo Go loads a bundle from a live Metro server — it cannot open a published
EAS update, which is built for a runtime version only a real build has. So the
phone has to reach the host. On the same Wi-Fi it already can, via the LAN
address. From anywhere else, put both the host and the phone on your tailnet:

```bash
curl -fsSL https://tailscale.com/install.sh | sh && sudo tailscale up
```

Then point previews at the tailnet name rather than the LAN address, and both
the app's API calls and Metro follow:

```bash
export PREVIEW_HOSTNAME=your-box.tail1234.ts.net
```

This is separate from `PREVIEW_SSH` on purpose: deploys keep going over the LAN
address (fast, and already working), while the URL handed to the phone is one
that resolves from anywhere.

## Ports

Two per PR, derived from its number, so a preview's URL is stable across
redeploys and predictable without looking anything up:

| | Port | Reached at |
|---|---|---|
| Server + web app | `42000 + (PR % 200) * 2` | `http://<host>:<port>` |
| Metro (Expo Go) | that, `+ 1` | `exp://<host>:<port>` |

PR 136 is therefore always `42072` and `42073`. The modulus wraps after 200, so
PRs 136 and 336 want the same block; `up` refuses rather than quietly stealing
a live preview's ports.

Metro listens on its published port *inside* the container as well as outside,
which is why the port is passed in rather than left at 8081. Expo builds the
URL it hands the phone from its own listening port and knows nothing about a
port mapping — published as `42073:8081` it would advertise `exp://host:8081`,
and the phone would fail to connect to a port nothing serves.

## What a preview cannot reach

A pull request's code runs here, so two things are deliberately withheld:

- **The Docker socket.** Mounting `/var/run/docker.sock` is what the agent's
  container sandbox would need, and it is equivalent to handing PR code root on
  the host. Previews run `SANDBOX_MODE=off` instead. Agent tool calls that need
  a sandbox fail with a reason, which is the honest outcome; if you are
  specifically testing sandbox behaviour on a branch you trust, redeploy that
  one preview with `PREVIEW_SANDBOX_MODE=host` and understand that you have
  just given that branch your user account on that machine.
- **Inference credentials.** `MOCK_INFERENCE=true` drives the full agent tool
  loop — approvals, tool calls, the lot — without reaching LM Studio, so
  concurrent previews never queue behind each other over one model.

Each preview also gets its own database, its own uploads volume, and its own
`BETTER_AUTH_SECRET`, so a session minted against one PR's server is not valid
against another's. The database publishes no port at all.

## Destroying previews when a PR merges

`sync` asks GitHub which pull requests are still open and destroys every
deployed preview that is not among them. Run it by hand, or from a timer so it
happens without you:

```bash
# macOS: every 15 minutes, logging where you can find it
cat > ~/Library/LaunchAgents/com.loxaic.preview-sync.plist <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.loxaic.preview-sync</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>-lc</string>
    <string>cd ~/Documents/Git/Open-Shannon && ./scripts/preview.sh sync</string>
  </array>
  <key>StartInterval</key><integer>900</integer>
  <key>StandardOutPath</key><string>/tmp/loxaic-preview-sync.log</string>
  <key>StandardErrorPath</key><string>/tmp/loxaic-preview-sync.log</string>
</dict></plist>
EOF
launchctl load ~/Library/LaunchAgents/com.loxaic.preview-sync.plist
```

The timer lives on your workstation rather than the host for the same reason
the deploy does: it is the machine already allowed to ask GitHub questions.
