# Pi plan mode

A cache-safe plan-mode extension for [Pi](https://github.com/earendil-works/pi).

Plan mode is a policy layer. It keeps Pi's tool inventory and system prompt stable, appending plan-state context instead of changing active tools or filtering prior messages, so provider prompt-cache prefixes survive plan-mode transitions. Progress tracking is not its job: the model records its plan by calling the `update_todos` tool from [`pi-arcweld-todos`](../pi-arcweld-todos/README.md), which then tracks execution in every mode.

## Scope

While active, the extension:

- blocks Pi's built-in `write` and `edit` tools except for canonical, non-symlinked Markdown files under `<project>/<config-dir>/plans/`;
- blocks model calls to Pi's built-in `bash` tool;
- leaves every other installed tool under that tool's own policy.

It is a guard for local file mutation and model shell execution, not a universal side-effect sandbox. User-entered shell commands remain under user control.

## Planning and handoff

The plan-mode prompt asks the model to explore, reason about trade-offs, and record its plan as an ordered `update_todos` list of `pending` steps. When the agent stops with a plan recorded, plan mode offers Execute, Stay, or Refine. Execute lifts the restrictions and asks the model to start the first todo; the `pi-arcweld-todos` widget tracks progress from there. Plan mode reads only the tool name `update_todos` and its `details.todos`, with no code dependency on that extension.

## Commands

- `/plan` — toggle plan mode
- `Ctrl+Alt+P` — toggle plan mode

Use `--plan` to start a session in plan mode. The todo list itself is shown by `/todos` from `pi-arcweld-todos`.

## Loading

The user-level Pi agent loads this package through the symlink `~/.pi/agent/extensions/plan-mode` → this directory. Run `/reload` after changing the extension.

## Development

```bash
cd extensions/plan-mode
npm ci --ignore-scripts
npm run check
npm test
npm run pack:check
```
