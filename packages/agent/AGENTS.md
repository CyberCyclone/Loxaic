# packages/agent

Shared tool definitions and permission-mode logic used by the server and the client: the builtin `TOOLS`, `ResolvedTool`/`ToolSource`, and the special tools kept outside `TOOLS`. The wire event union (`StreamEventKind`) lives in `packages/types`, not here.

## Package

- No build step: relative imports must include the `.ts` extension; production runs this source under Node's native TypeScript support.

## Tools outside TOOLS

- Keep `PLAN_TOOL`, `QUESTIONS_TOOL`, `subagentTool` and `skillTool` out of `TOOLS`. Being outside `TOOLS` is what keeps them off "Allow always" (`isToolName`); none asks for approval and none is a write tool.
- Pass every name and description in the skill list through `inert` so it cannot close a marker; the list sits at the front of every request.
- The `skill` tool is deliberately offered in planning mode too: it never asks and writes nothing.

## Prompt prefix

- Tool descriptions are part of every request's prefix. Changing one (the `todo_write` rules, any mode prompt) makes every existing chat and agent conversation re-read its whole prompt once; do it deliberately.
