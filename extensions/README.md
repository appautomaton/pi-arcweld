# Local Pi Extensions

`extensions/` is the only repository root for locally maintained Pi extensions. Do not create standalone extension packages beside it.

## Contents

- `mcp-extension/` — package-backed MCP client. Pi loads it from the local package path recorded in `~/.pi/agent/settings.json`.
- `plan-mode/` — cache-safe plan-mode package, globally symlinked into `~/.pi/agent/extensions/`.
- `questionnaire.ts` — single-file local extension.

## Loading

Pi auto-discovers direct global extensions from `~/.pi/agent/extensions/`. Symlink a direct extension there when it should load globally.

Extensions that need their own npm dependencies should remain package-backed under this directory. Install or register them using their path beneath `extensions/`, for example:

```bash
pi install /home/dev/agents/pi/extensions/mcp-extension
```

A local-path package registration references the source directory; Pi does not copy it. After changing its dependencies, run that package's own install command. Do not add a root npm workspace or install dependencies in `pi-mono/`.

## Development

Each package owns its own `package.json`, lockfile, dependencies, and checks. Run its commands from that package directory, such as:

```bash
cd extensions/mcp-extension
npm run check
npm test
npm run pack:check
```
