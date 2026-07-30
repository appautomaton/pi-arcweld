# Pi extensions

`extensions/` is the repository root for every curated Pi extension. Keep local variants here so their code, documentation, and user-level wiring can be reviewed together.

## Inventory

| Path | Form | User-level loading |
| --- | --- | --- |
| `mcp-extension/` | Package with runtime dependencies | Local-path package in `~/.pi/agent/settings.json` |
| `plan-mode/` | Package directory | Symlink at `~/.pi/agent/extensions/plan-mode` |
| `pi-arcweld-todos/` | Package directory | Symlink at `~/.pi/agent/extensions/pi-arcweld-todos` |
| `questionnaire.ts` | Self-contained curated extension | Symlink at `~/.pi/agent/extensions/questionnaire.ts` |
| `claude-cache-retention.ts` | Claude-only one-hour prompt-cache policy for the local CPA provider | Symlink at `~/.pi/agent/extensions/claude-cache-retention.ts` |
| `exa-search.ts` | Exa-backed `exa_search` tool | Symlink at `~/.pi/agent/extensions/exa-search.ts` |
| `codex-web-search.ts` | Codex `web_search` request injection | Symlink at `~/.pi/agent/extensions/codex-web-search.ts` |
| `claude-web-search/` | Replay-safe Claude provider-side `web_search` | Symlink at `~/.pi/agent/extensions/claude-web-search` |
| `grok-search.ts` | Grok-backed web/X `grok_search` tool | Symlink at `~/.pi/agent/extensions/grok-search.ts` |

The questionnaire started from Pi's upstream example and is maintained here as a self-contained local variant. Keeping its imports package-based makes it safe to load through the user-level symlink, while the local copy owns its model-facing clarification policy.

The search extensions are also self-contained. `exa-search.ts` reads `exaApiKey` only from the machine-local `~/.pi/agent/exa-search.json`; never commit that credential file. `grok-search.ts` resolves `cli-proxy-api/grok-4.5` and its credential through Pi's model registry, so the machine must configure that provider and model separately.

`codex-web-search.ts` does not register another Pi function tool. It appends Codex's provider-side `{ "type": "web_search" }` declaration to requests for the built-in `openai-codex` OAuth provider and `cli-proxy-api` GPT models using the OpenAI Responses API. When that provider-side tool is available, the search guidance prefers it. `exa_search` remains available as a fallback for models without `web_search`, or when Exa results are explicitly requested. Pi currently displays the final model text but does not surface intermediate `web_search_call` activity or preserve structured citation annotations.

`claude-web-search/` enables Anthropic's provider-side `web_search` for the built-in `anthropic` provider and the local `cli-proxy-api-anthropic` provider. The package wraps Pi's Anthropic `streamSimple` transport, tunnels native `server_tool_use` and `web_search_tool_result` blocks through session history as invisible validated replay markers, restores their exact ordering before the next request, and continues bounded `pause_turn` responses internally. Existing provider models, authentication, cache settings, headers, retries, timeouts, metadata, and cancellation remain composed by Pi. The tests use synthetic SSE and fake streams only; they make no live model requests. Structured Anthropic citation annotations are not rendered by Pi, and session branches that already lost native blocks must restart or branch before the failed turn.

`claude-cache-retention.ts` upgrades existing Anthropic `cache_control` markers to a one-hour TTL only for the `cli-proxy-api-anthropic` provider. This keeps `PI_CACHE_RETENTION` unset so OpenAI and other Pi providers retain their default cache policies.

`pi-arcweld-todos` and `plan-mode` are a decoupled pair. The todos package registers the always-on `update_todos` tool that tracks long-horizon work in every mode; plan mode is a policy layer that instructs the model to record its plan through that same tool. The only shared contract is the tool name `update_todos` and its `details.todos` shape, so either extension loads and runs without the other.

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

Use the same command sequence in `extensions/plan-mode/` and `extensions/claude-web-search/`. Test the self-contained extensions through their user-level symlinks or explicitly with:

```bash
pi -e ./extensions/questionnaire.ts
pi -e ./extensions/exa-search.ts
pi -e ./extensions/codex-web-search.ts
pi -e ./extensions/claude-web-search
pi -e ./extensions/grok-search.ts
```

For search configuration checks, run `/exa-search-status` for Exa, `/codex-web-search-status` for the selected Codex model, `/claude-web-search-status` for the replay-safe Anthropic route, and confirm `cli-proxy-api/grok-4.5` appears in `pi --list-models` for Grok.

After changing an auto-discovered extension, run `/reload` in an active Pi session. Restart Pi after changing package registration or dependencies.
