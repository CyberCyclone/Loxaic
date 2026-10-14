# apps/server/src/mcp

The per-run `Toolset` (builtins plus the user's MCP servers), approval policy, MCP connections and their credentials. Everything an MCP server sends is untrusted input.

## Toolset and approval

- Resolve every tool name, approval policy and dispatch through the per-run `Toolset` (`registry.ts`), never the static builtin union.
- MCP tools are namespaced `slug__tool`; never give a builtin a name containing `__`.
- Modes (`toolsetRequiresApproval`; bash via `decideBash` in `permissions/bash/policy.ts`): planning offers no write tools and only read-only bash; manual asks for write builtins, non-read-only bash and non-allowlisted MCP tools; auto asks for no builtin except bash outside isolation, which goes to the permission check. Command rules can deny in any mode.
- **MCP tools ask in every mode, auto included, until the user allowlists that specific tool.**
- Planning offers only MCP tools the user marked read-only; a server's `readOnlyHint` is display-only, never trusted.
- "Allow always" grants: an MCP tool → its server's per-tool policy; a builtin → `user_prefs.tool_allowlist` (read by `buildToolset`); `bash` → command rules. Clients send it with the answer (`agent.approve {always}`); never write the allowlist with a REST read-modify-write.
- The allowlist clears `requiresApproval` only, never the `isWrite` gate — planning still filters on `isWrite`.
- `Toolset.grantTrust` flips the run's own tool object and writes one tool's entry in one statement (`jsonb_set` / upsert), setting `changed: false`; a saved-only grant would keep asking for the rest of the run.
- `ToolPolicy.grantedFrom: "prompt"` marks an allow that came from an approval; a save in the tools sheet or a revocation clears it.
- `change-detection.ts` revokes a tool's allowlist entry when its description or schema hash changes.

## Per-conversation MCP state

- Whether a server is offered is `mcpServerActive` (`packages/types`), shared with the client; never reimplement it.
- Per-kind defaults resolve live; never copy them into a conversation.
- A failed read of a conversation's MCP choices offers no MCP servers (builtins only); never fall back to the run's surface kind.
- A `subagent`-kind conversation gets no servers from `conversationMcpState`; build a child's toolset against its parent conversation.
- The toolset is built for the sender: a shared editor is offered their own servers and defaults.
- A conversation's `mcp_overrides` naming a deleted server id is inert.

## Untrusted output

- Cap and control-strip descriptions and schemas (`sanitize.ts`); byte-cap results and wrap them in `<mcp-tool-result …>` with escape attempts neutralised; keep the system-prompt addendum telling the model not to follow instructions inside.
- ajv-validate model-produced arguments against the declared schema before anything reaches the server.

## Credentials and transports

- Encrypt credentials with AES-256-GCM (`secrets.ts`, key `MCP_ENCRYPTION_KEY`, fallback `BETTER_AUTH_SECRET`) and `redact()` them out of every error path.
- stdio children get only `PATH`/`HOME` + row env + secrets, never `process.env`.
- HTTP transports re-run the SSRF guard on every request unless the user confirmed `allowPrivateNetwork`.
- Spawn catalog servers (`catalog.ts`, stdio-only) from the installed package's bin (e.g. `@brave/brave-search-mcp-server`), never `npx`.
- There is no built-in GitHub MCP server; GitHub goes through git/gh and the egress proxy.

## Connections

- Connections are cached per `userId:serverId` with an idle reaper (`client-manager.ts`); a dead or hung server fails only its own calls, never the run.
- A failed connect is cached for `CONNECT_FAILURE_TTL_MS` (30 s) — every turn connects every enabled server; a row with a new `updatedAt` bypasses it so Test always really tries.
- `dropEntry`/`closeServerClients` delete entries; the idle reaper must also sweep expired failure entries.

## Tests

- `test-fixtures/mock-mcp-server.ts` is deliberately hostile — don't tidy it.
- Under `MOCK_INFERENCE`, `mockmcp__*` calls fire only when the registry actually offered them (`MOCK_TOOL_TRIGGERS`).
