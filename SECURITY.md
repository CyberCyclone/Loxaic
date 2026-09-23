# Security policy

## Reporting a vulnerability

**Please do not open a public issue for a security problem.** Report it privately through
GitHub's [private vulnerability reporting](https://github.com/CyberCyclone/Loxaic/security/advisories/new)
(the repository's **Security** tab → **Report a vulnerability**). Only the maintainers can see
the report, and the fix can be developed and disclosed from the same advisory.

Include what you can of: the affected component (server, desktop, mobile, sandbox, executor),
the version or commit, the deployment mode, steps to reproduce, and the impact you believe it
has. You should get an acknowledgement within a week. Please give us a reasonable window to
ship a fix before disclosing publicly.

## Supported versions

Fixes land on `dev` and ship in the next release. Only the latest stable release and the
current beta receive them; there are no backports to older versions.

## What is in scope

Loxaic runs model-directed code, so some of its behaviour is by design rather than a
vulnerability. Worth knowing before you report:

- **Sandboxed execution.** Agent commands run in a container with no network unless an admin
  enables it. Escaping the container, reaching the network while it is disabled, or reading
  another user's workspace is in scope. See "Tool loop" in [`AGENTS.md`](AGENTS.md#tool-loop-chat-and-agent-both).
- **Host mode is an explicit opt-in with no isolation** (`SANDBOX_MODE=host`), and a
  **Direct local workspace runs commands as you on your own machine** — neither is a sandbox,
  and commands they run reaching the host are expected. See
  [`AGENTS.md`](AGENTS.md#local-workspaces-the-desktops-executor).
- **MCP servers and fetched web content are untrusted input** to the model. Prompt injection
  that leads to an action a user did not approve is in scope; see
  [`AGENTS.md`](AGENTS.md#mcp-servers).
- **Updates are not code-signed on every channel.** Mobile over-the-air updates are unsigned,
  and desktop updates on Windows and Linux rely on the release feed's checksums. This is a
  documented limitation (see [`docs/DEPLOY.md`](docs/DEPLOY.md#over-the-air-updates-are-not-signed)
  and [`AGENTS.md`](AGENTS.md#the-desktop-updater)), not something to report — but a way to
  get an update installed that did not come from this repository's releases is in scope.
- Authentication, authorization between users (including shared conversations), credential
  storage (API keys, GitHub tokens, MCP secrets) and the SSRF guard on `web_fetch` are all in
  scope.
