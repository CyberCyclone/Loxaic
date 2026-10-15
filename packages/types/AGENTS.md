# packages/types

Types and pure helpers shared by the server and every client: the stream wire protocol (`src/stream-protocol.ts`), model references, MCP switch resolution, sub-agent folds, todos and wait limits. Installed app builds of older versions read this protocol, so changes must stay backward compatible.

## Wire compatibility

- Add wire fields as optional, and keep old optional fields (`ContextBreakdown.history_limit`/`history_truncated`) for older servers. An absent field means "not told", never 0 or false.
- Never add a separate `provider` field for model refs — older native builds drop unknown fields and would run the local model.

## Model references

- A model reference is one opaque string: built-in models keep their bare upstream id, added providers use `slug::upstreamId`. Build and split them only with `formatModelRef`/`parseModelRef` (`MODEL_REF_SEPARATOR`) — `/` and `:` occur inside real ids.

## Shared logic

- `parseTodoList` is the only parser of `todo_write` arguments, used by the executor and the client alike.
- `foldSubAgentEvent` is the one fold of `subagent.started`/`progress`/`ended` into `StreamSnapshot.subagents`, used by server and client; these events are emitted on change only, never on a timer.
- `mcpServerActive` (`mcp-state.ts`) alone decides whether an MCP server is offered, for the registry and every switch. Order: globally `enabled` (filtered before it), then `mcpOverrides.disabledServerIds` (wins if in both lists), then `enabledServerIds`, then the per-kind default (`on_in_chat`/`on_in_agent`/`on_in_routines`, default true).

## Workspaces

- `Workspace` is `scratch` (stored as null), `github` or `local`; set once at `POST /v1/conversations {kind: "agent", workspace}` and never patched. There is deliberately no PATCH path.
