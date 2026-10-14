# apps/server/src/egress

The HTTP proxy through which a GitHub workspace's sandbox reaches GitHub: it holds the owner's token and enforces what the sandbox may write. Every request arriving here is written by the model, so treat it as hostile.

## The token boundary

- **The GitHub token never enters a sandbox.** A sandbox gets `HTTPS_PROXY` with a Loxaic credential, trust in the proxy's CA, and `GH_TOKEN=loxaic-egress-proxy` (a placeholder `gh` requires).
- For `github.com`/`api.github.com` the proxy terminates TLS with its CA, strips any `Authorization` the sandbox sent, checks the request, then adds the owner's token. Every other host is a plain tunnel to a public address only (`isBlockedAddress`).
- The credential is an HMAC over `{conversation, owner}` (`credential.ts`), never stored; it must exist before the sandbox row (the clone runs inside `provider.create`). Honour it only while the conversation exists and still belongs to that owner.
- Decide the caller per request (`callerFor`), never per connection — git and gh keep connections open across a disconnect or delete. Keep only the verified identity with the socket.
- Only a GitHub workspace's sandbox is given the proxy (`egressFor` in `agent/sandbox-manager.ts`), and `callerFor` refuses any other workspace; never a scratch or local one (a local workspace uses the user's own git/gh login).
- Tokens are cached 30 s; connecting and disconnecting GitHub must call `forgetEgressToken`.

## Request targets

- Accept only origin-form targets (`isOriginForm`). Build the upstream URL from the upstream origin plus a parsed path and re-check the origin (`upstreamTarget`); never `new URL(path, base)` — absolute-form and `//host`, `/\host` re-base it and leak the token.

## Write rules (`rules.ts`, pure)

- Reads pass for anything the token can read; the token's own scope is the boundary.
- git pushes only to `refs/heads/<workspace branch>` of its repository; force pushes allowed, deletes and tags refused.
- Parse receive-pack commands (pkt-lines to the flush, ≤ 64 KB, ≤ 100 updates) before forwarding any pack bytes; refuse with a receive-pack report (side-band when asked) so git prints the reason.
- Inflate a gzipped push only as far as its commands (`readGzipPushHead`) and forward the original bytes; never `gunzipSync` the whole body.
- `readBody` drains past its cap (to 8×) and answers 413; never destroy the request — the client then sees a reset, not the reason.
- REST writes allowed: open a PR from the branch, edit the branch's own PR (never `state`), comments, and reviewers/labels/assignees on its own PR.
- GraphQL: queries pass; mutations only from the allowlist, each checked (`createPullRequest` against the repo node id and branch, `addComment` against the subject's repo, own-PR mutations via a `node(id)` lookup).
- Parse GraphQL with the linear tokenizer (`graphql.ts`, 64 KB cap) that resolves aliases; refuse a mutation with literal input, a top-level fragment or a missing variable; check every operation in the document, not only `operationName`'s.
- Everything else (merge, close, delete, other branches or repos, settings) is a 403 with a sentence.

## Sandbox environment (`env.ts`)

- Give the egress env per command (`withEgress`, applied in `getConversationSandbox` and `attachRunningSandbox`), never baked into the container — a paused container resumes with its old env and the port changes per server start.
- Write the CA and the system-roots bundle to `<root>/.loxaic/` once per sandbox per CA.
- A CA that cannot be written raises `EgressCaError`: a clone fails with its sentence; other commands still run and get it appended to stderr on failure. Never skip silently — the clone would fail as "repository not found".

## Listening and the CA

- Listen on loopback always, plus the Docker bridge gateway on Linux; never a public address. Give containers the gateway address directly, not a hosts entry (a paused container must still find it).
- `EGRESS_PROXY_PORT` is ephemeral by default — don't fix it (servers on one machine would collide); `EGRESS_PROXY_BIND`/`EGRESS_PROXY_HOST` override. A proxy that fails to start is logged and the server runs on.
- The CA lives in `EGRESS_CA_DIR` (default `<cwd>/egress-ca`, gitignored), per deployment, key 0600; X.509 is built with `node-forge`.
- A sealed sandbox (no network) has no GitHub by design.
- Unverified on Linux, Podman and OrbStack; Linux depends on a host firewall letting containers reach the bridge gateway.
