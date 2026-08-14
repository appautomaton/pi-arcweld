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
| `codex-web-search.ts` | Codex hosted `web_search` injection plus explicit `web_run` tool | Symlink at `~/.pi/agent/extensions/codex-web-search.ts` |
| `claude-web-search/` | Cache-stable isolated Anthropic `WebSearch` tool | Symlink at `~/.pi/agent/extensions/claude-web-search` |
| `grok-search.ts` | Grok-backed web/X `grok_search` tool | Optional symlink at `~/.pi/agent/extensions/grok-search.ts` |

The questionnaire started from Pi's upstream example and is maintained here as a self-contained local variant. Keeping its imports package-based makes it safe to load through the user-level symlink, while the local copy owns its model-facing clarification policy.

The search extensions are also self-contained. `exa-search.ts` reads `exaApiKey` only from the machine-local `~/.pi/agent/exa-search.json`; never commit that credential file. `grok-search.ts` resolves `cli-proxy-api/grok-4.5` and its credential through Pi's model registry, so the machine must configure that provider and model separately. Because that provider is machine-specific, the symlink is optional: `scripts/check-user-wiring.sh` validates its target when the link exists and reports it as not enabled when it is absent.

`codex-web-search.ts` owns both Codex web-access modes. It appends Codex's provider-side `{ "type": "web_search" }` declaration to requests for the built-in `openai-codex` OAuth provider and `cli-proxy-api` GPT models using the OpenAI Responses API. In this hosted mode, OpenAI decides when to search or open pages while producing the response. Pi currently displays the final model text but does not surface intermediate `web_search_call` activity or preserve structured citation annotations.

For eligible `cli-proxy-api` GPT Responses models, the same extension also registers the sequential `web_run` function tool. `web_run` sends explicit search, open, click, find, screenshot, finance, weather, sports, and time commands to the CPA provider's `/v1/alpha/search` route. CPA authenticates upstream with its stored Codex OAuth account and forwards the request to the ChatGPT Codex search service; the target webpage is fetched by OpenAI, not by Pi or CPA. The tool keeps a stable Pi session id so returned references such as `turn0search0` and `turn0view0` can be reused by later calls, returns bounded source metadata, omits opaque `encrypted_output`, and truncates oversized model-facing output using Pi's standard limits. Its TUI renderer keeps the default result view to six terminal lines and caps the expanded preview at 28 lines; this display-only limit does not reduce the result sent to the model.

The explicit route is intentionally limited to the verified CPA path for now. Direct `openai-codex` models retain hosted `web_search`, but do not expose `web_run` until the direct alpha-search OAuth/account-header path is separately validated. The `/alpha/search` API is an internal alpha Codex endpoint and may change without the compatibility guarantees of a public stable API. Each call uses Codex account capacity, so batch independent operations when practical. `exa_search` remains available as a fallback for models without hosted search, or when Exa results are explicitly requested.

`claude-web-search/` registers one stable ordinary `WebSearch` definition for built-in Anthropic Claude models and `claude-*` plus `kimi-*` models on the local `cli-proxy-api-anthropic` provider. Session-start and model-selection hooks keep the tool inactive for unsupported models, preventing GPT routes from calling an Anthropic-only tool; availability remains fixed between turns for a selected model. Normal agent requests are never rewritten and never receive a hosted-search declaration. When the model explicitly calls `WebSearch`, the tool sends a minimal nested request through Pi's model registry using the same model, endpoint, authentication, headers, cancellation, retries, and usage accounting; only that isolated request receives `web_search_20250305`. Its system/tool prefix is fixed and cache-eligible, while the query is the dynamic suffix. Hosted server blocks and bounded `pause_turn` history remain in memory, CPA Kimi's malformed IDs are normalized there, and the outer conversation receives only an ordinary tool result with text and source URLs. The extension does not register a provider or persist replay markers.

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

Use the same command sequence in `extensions/plan-mode/` and `extensions/claude-web-search/`. The Claude web-search package borrows the workspace's existing TypeScript/TSX toolchain and temporarily links only the built Pi runtime packages during checks; it keeps no extension-local dependency tree. Test the self-contained extensions through their user-level symlinks or explicitly with:

```bash
pi -e ./extensions/questionnaire.ts
pi -e ./extensions/exa-search.ts
pi -e ./extensions/codex-web-search.ts
pi -e ./extensions/claude-web-search
pi -e ./extensions/grok-search.ts
```

For search configuration checks, run `/exa-search-status` for Exa, `/codex-web-search-status` to inspect both hosted `web_search` and explicit `web_run` availability for the selected model, `/claude-web-search-status` for the isolated cache-stable Anthropic route, and confirm `cli-proxy-api/grok-4.5` appears in `pi --list-models` for Grok.

After changing an auto-discovered extension, run `/reload` in an active Pi session. Restart Pi after changing package registration or dependencies.
