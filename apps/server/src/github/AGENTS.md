# apps/server/src/github

The user's GitHub connection (one personal access token), its encryption, and the thin REST client. Sandboxes never see the token; they reach GitHub through `egress/`.

## The token

- One PAT per user (`github_connections`, `userId` primary key) — a PAT, not OAuth.
- Encrypt it with the `mcp/secrets.ts` AES-256-GCM scheme, kept in its own module (`connection.ts`), same key (`MCP_ENCRYPTION_KEY`, fallback `BETTER_AUTH_SECRET`). `getOwnerToken()` is the only decrypt site outside tests.
- Cache scrypt-derived keys per salt; never `scryptSync` per request — it blocks the event loop and every user's stream.
- A token that can no longer be decrypted is `GithubTokenUnreadableError`, never a 500: repo and branch routes answer 409 "disconnect and reconnect", workspace creation a 400.
- Disconnecting hard-deletes the row, and must call `forgetEgressToken` (the egress proxy caches tokens 30 s).
- GitHub access belongs to the conversation owner, never the sender.
- Redact the token from every error message here, and again in `routes/github.ts`.

## The client (`client.ts`)

- Plain `fetch`, no octokit; read `GITHUB_API_URL` at call time (the e2e mock points it elsewhere).
- A missing `X-OAuth-Scopes` (fine-grained PAT) is stored as null and means "unknown", never "no access".
- `listRepos`/`listBranches` follow `rel="next"` up to ten pages, only on the API's own origin.


