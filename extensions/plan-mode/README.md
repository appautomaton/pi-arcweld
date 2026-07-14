# Pi plan mode

A cache-safe plan-mode extension for [Pi](https://github.com/earendil-works/pi).

Plan mode is a safe, read-only policy layer. While active it blocks local edits and the model shell, so you can explore and plan with no risk of unexpected changes. It keeps Pi's tool inventory and system prompt stable, appending plan-state context instead of changing active tools or filtering prior messages, so provider prompt-cache prefixes survive plan-mode transitions. Progress tracking is not its job: the model records its plan by calling the `update_todos` tool from [`pi-arcweld-todos`](../pi-arcweld-todos/README.md), which then tracks execution in every mode.

## Scope

While active, the extension:

- blocks Pi's built-in `write` and `edit` tools except for canonical, non-symlinked Markdown files under `<project>/<config-dir>/plans/`;
- restricts Pi's built-in `bash` tool to read-only commands (search and inspection such as `rg`, `grep`, `find`, `git log`/`diff`, `cat`, `jq`, `wc`), blocking anything that would mutate files or state;
- leaves every other installed tool under that tool's own policy.

The read-only bash allowlist (`commands.ts`) is a conservative, application-layer best-effort guard against accidental mutation, not an adversarial sandbox: a command is allowed only when it begins with a known read-only tool and contains no mutation token, so `rg foo | head` passes while `rg foo > out` or `... | xargs rm` do not. Everything read-only stays available in plan mode: the questionnaire tool, MCP tools (the MCP client and the Camoufox server), and the web search tools. Plan mode guards local file mutation and shell writes, not external side effects. It does not hold back outbound MCP calls, and user-entered shell commands remain under user control.

## Planning and handoff

Plan mode is a safe, read-only space. If the user is only asking a question or getting oriented, it stays out of the way and never demands a plan. The handoff appears only when the model records an *actionable* plan: an `update_todos` list with at least one step still `pending`, which cannot be carried out while writes are blocked. Pure exploration completes its todos as it reads, so nothing is pending and no menu appears. When there is a pending plan and the agent stops, plan mode offers Execute, Stay, or Refine. Execute lifts the restrictions and asks the model to start the first step; the `pi-arcweld-todos` widget tracks progress from there. Plan mode reads only the tool name `update_todos` and its `details.todos`, with no code dependency on that extension.

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
