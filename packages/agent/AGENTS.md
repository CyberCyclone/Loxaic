# packages/agent

Shared tool definitions and permission-mode logic used by the server and the client: the builtin `TOOLS`, `ResolvedTool`/`ToolSource`, and the special tools kept outside `TOOLS`. The wire event union (`StreamEventKind`) lives in `packages/types`, not here.

## Package

- No build step: relative imports must include the `.ts` extension; production runs this source under Node's native TypeScript support.

## Tools outside TOOLS

- Keep `PLAN_TOOL`, `QUESTIONS_TOOL`, `subagentTool` and `skillTool` out of `TOOLS`. Being outside `TOOLS` is what keeps them off "Allow always" (`isToolName`); none asks for approval and none is a write tool.
- `resolveBuiltinTools(mode)` appends the plan and questions tools in planning mode only; the skill tool is offered in planning too.
- `skillTool`'s description lists the conversation's frozen catalog; its `name` is a plain string, not an enum, so a skill announced later still loads.
- Pass every name and description in the skill list through `inert` so it cannot close a marker; the list sits at the front of every request.

## Prompt prefix

- Tool descriptions are part of every request's prefix. Changing one (the `todo_write` rules, any mode prompt) makes every existing chat and agent conversation re-read its whole prompt once; do it deliberately.
