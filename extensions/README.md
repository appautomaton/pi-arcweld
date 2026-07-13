# Pi extensions

`extensions/` is the repository root for every curated Pi extension. Keep local variants here so their code, documentation, and user-level wiring can be reviewed together.

## Inventory

| Path | Form | User-level loading |
| --- | --- | --- |
| `mcp-extension/` | Package with runtime dependencies | Local-path package in `~/.pi/agent/settings.json` |
| `plan-mode/` | Package directory | Symlink at `~/.pi/agent/extensions/plan-mode` |
| `questionnaire.ts` | Self-contained curated extension | Symlink at `~/.pi/agent/extensions/questionnaire.ts` |
| `web-search.ts` | Exa-backed `web_search` tool | Symlink at `~/.pi/agent/extensions/web-search.ts` |
| `grok-search.ts` | Grok-backed web/X `grok_search` tool | Symlink at `~/.pi/agent/extensions/grok-search.ts` |

The questionnaire started from Pi's upstream example and is maintained here as a self-contained local variant. Keeping its imports package-based makes it safe to load through the user-level symlink, while the local copy owns its model-facing clarification policy.

The search extensions are also self-contained. `web-search.ts` reads `exaApiKey` only from the machine-local `~/.pi/agent/web-search.json`; never commit that credential file. `grok-search.ts` resolves `cli-proxy-api/grok-4.5` and its credential through Pi's model registry, so the machine must configure that provider and model separately.

## Loading model

Pi auto-discovers global files and directories under `~/.pi/agent/extensions/`. Use symlinks there for extensions that should support `/reload` directly from this checkout.

Use a local-path package registration for a package whose `package.json` declares Pi resources and owns runtime dependencies:

```bash
pi install ./extensions/mcp-extension
```

Pi records a local package path without copying the package. Relative package paths are resolved from the settings file that contains them.

Do not add a root npm workspace or install dependencies in `pi-mono/`.

## Development

Each package owns its own dependencies and checks. Install and validate from the package directory:

```bash
cd extensions/mcp-extension
npm ci --ignore-scripts
npm run check
npm test
npm run pack:check
```

Use the same command sequence in `extensions/plan-mode/`. Test the self-contained extensions through their user-level symlinks or explicitly with:

```bash
pi -e ./extensions/questionnaire.ts
pi -e ./extensions/web-search.ts
pi -e ./extensions/grok-search.ts
```

For search configuration checks, run `/web-search-status` for Exa and confirm `cli-proxy-api/grok-4.5` appears in `pi --list-models` for Grok.

After changing an auto-discovered extension, run `/reload` in an active Pi session. Restart Pi after changing package registration or dependencies.
