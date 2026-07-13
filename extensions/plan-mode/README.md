# Pi plan mode

A cache-safe plan-mode extension for [Pi](https://github.com/earendil-works/pi).

Plan mode keeps Pi's tool inventory and system prompt stable. It appends plan-state context instead of changing active tools or filtering prior messages, preserving provider prompt-cache prefixes across plan-mode transitions.

## Scope

While active, the extension:

- blocks Pi's built-in `write` and `edit` tools except for canonical, non-symlinked Markdown files under `<project>/<config-dir>/plans/`;
- blocks model calls to Pi's built-in `bash` tool;
- leaves every other installed tool under that tool's own policy.

It is a guard for local file mutation and model shell execution, not a universal side-effect sandbox. User-entered shell commands remain under user control.

## Commands

- `/plan` — toggle plan mode
- `/todos` — show the current plan steps
- `Ctrl+Alt+P` — toggle plan mode

Use `--plan` to start a session in plan mode.

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
