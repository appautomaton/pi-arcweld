# Pi extensions

`extensions/` is the repository root for every curated Pi extension. Keep local variants here so their code, documentation, and user-level wiring can be reviewed together.

## Inventory

| Path | Form | User-level loading |
| --- | --- | --- |
| `plan-mode/` | Package directory | Symlink at `~/.pi/agent/extensions/plan-mode` |
| `pi-arcweld-todos/` | Package directory | Symlink at `~/.pi/agent/extensions/pi-arcweld-todos` |
| `cache-preserving-compaction/` | Cache-friendly custom compaction package | Symlink at `~/.pi/agent/extensions/cache-preserving-compaction` |
| `questionnaire.ts` | Self-contained curated extension | Symlink at `~/.pi/agent/extensions/questionnaire.ts` |
| `vibrant-footer.ts` | Theme-reactive powerline footer with native Pi session usage accounting | Symlink at `~/.pi/agent/extensions/vibrant-footer.ts` |
| `claude-cache-retention.ts` | Claude-only one-hour prompt-cache policy for the local CPA provider | Not enabled on this machine; optional user-level symlink |
| `exa-search.ts` | Exa-backed `exa_search` tool | Symlink at `~/.pi/agent/extensions/exa-search.ts` |
| `codex-web-search.ts` | Codex hosted `web_search` injection plus explicit `web_run` tool | Symlink at `~/.pi/agent/extensions/codex-web-search.ts` |
| `claude-web-search/` | Cache-stable isolated Anthropic `WebSearch` tool | Symlink at `~/.pi/agent/extensions/claude-web-search` |
| `gemini-web-search.ts` | Cache-stable isolated Google Search Grounding `google_search` tool for Gemini models | Symlink at `~/.pi/agent/extensions/gemini-web-search.ts` |
| `grok-search.ts` | Grok-backed web/X `grok_search` tool | Optional symlink at `~/.pi/agent/extensions/grok-search.ts` |

`vibrant-footer.ts` is a two-row powerline. The first row is model, context, cache hit, session traffic, output tokens per second, and cost. The second row is the working path, one theme hue per character, then the branch. Chip colors come from the active theme: accent tokens are the backgrounds and `toolPendingBg` is the ink, so a light theme and a dark theme both re-skin the bar. It totals native assistant, tool-result, standalone, compaction, and branch-summary usage across the full session. Nested tool usage is counted through its parent result. The cache percentage is the latest assistant request. Fresh input on the traffic chip is uncached input plus cache writes. A snowflake means the last request is more than five minutes old after cache activity was seen. Pi does not store a cache expiry, so there is no countdown. Toggle it with `/vibrant-footer`.

The questionnaire started from Pi's upstream example and is maintained here as a self-contained local variant. Its `model-only` exposure keeps user interaction directly accessible to the model and out of nested codemode calls. Keeping its imports package-based makes it safe to load through the user-level symlink, while the local copy owns its model-facing clarification policy.

The search extensions are also self-contained. `exa-search.ts` reads `exaApiKey` only from the machine-local `~/.pi/agent/exa-search.json`; never commit that credential file. `grok-search.ts` exposes a `model` parameter with two values, both at `medium` reasoning: `grok-4.20-multi-agent-0309` (default; four parallel agents fan out for broad multi-angle coverage at $1.25/$2.50 per 1M tokens plus per-search tool fees) and `grok-4.6` (single-agent sequential pass on one line of inquiry; higher token rate at $2.00/$6.00 per 1M). It resolves the selected model and its credential through Pi's model registry, so the machine must configure that model separately. It accepts any provider that declares the model for the Responses API and reports configured credentials, so no provider id is named in the code and renaming the local gateway in `models.json` cannot disable the tool. Requests use Pi-resolved endpoints and authentication headers. Model-facing prompt text stays deliberately short: it injects the current date, requires the search tool before answering, states a stopping rule so search breadth is bounded, and asks for a conclusion-first answer under 300 words with canonical source URLs only. Failed, incomplete, or empty responses are marked as tool errors while preserving reported usage. Grok Responses token usage is returned as native tool-result usage, with cached input and reasoning splits preserved. Pi estimates model-token cost from the configured model rates; zero rates leave that estimate unavailable, and server-side search charges are not included because no search tariff is configured. The result details carry this cost limitation. Because that provider is machine-specific, the symlink is optional: `scripts/check-user-wiring.sh` validates its target when the link exists and reports it as not enabled when it is absent.

`codex-web-search.ts` owns both Codex web-access modes. It appends Codex's provider-side `{ "type": "web_search" }` declaration to requests for the built-in `openai-codex` OAuth provider and `cli-proxy-api` GPT models using the OpenAI Responses API. In this hosted mode, OpenAI decides when to search or open pages while producing the response. Pi currently displays the final model text but does not surface intermediate `web_search_call` activity or preserve structured citation annotations.

For eligible `cli-proxy-api` GPT Responses models, the same extension also registers the sequential `web_run` function tool. `web_run` sends explicit search, open, click, find, screenshot, finance, weather, sports, and time commands to the CPA provider's `/v1/alpha/search` route. CPA authenticates upstream with its stored Codex OAuth account and forwards the request to the ChatGPT Codex search service; the target webpage is fetched by OpenAI, not by Pi or CPA. The tool keeps a stable Pi session id so returned references such as `turn0search0` and `turn0view0` can be reused by later calls, returns bounded source metadata, omits opaque `encrypted_output`, and truncates oversized model-facing output using Pi's standard limits. Its TUI renderer keeps the default result view to six terminal lines and caps the expanded preview at 28 lines; this display-only limit does not reduce the result sent to the model.

The explicit route is intentionally limited to the verified CPA path for now. Direct `openai-codex` models retain hosted `web_search`, but do not expose `web_run` until the direct alpha-search OAuth/account-header path is separately validated. The `/alpha/search` API is an internal alpha Codex endpoint and may change without the compatibility guarantees of a public stable API. Each call uses Codex account capacity, so batch independent operations when practical. `exa_search` remains available as a fallback for models without hosted search, or when Exa results are explicitly requested.

`claude-web-search/` registers one stable ordinary `WebSearch` definition for built-in Anthropic Claude models and `claude-*` plus `kimi-*` models on the local `cli-proxy-api-anthropic` provider. Session-start and model-selection hooks keep the tool inactive for unsupported models, preventing GPT routes from calling an Anthropic-only tool; availability remains fixed between turns for a selected model. Normal agent requests are never rewritten and never receive a hosted-search declaration. When the model explicitly calls `WebSearch`, the tool sends a minimal nested request through Pi's model registry using the same model, endpoint, authentication, headers, cancellation, retries, and usage accounting; only that isolated request receives `web_search_20250305`. Its system/tool prefix is fixed and cache-eligible, while the query is the dynamic suffix. Hosted server blocks and bounded `pause_turn` history remain in memory, CPA Kimi's malformed IDs are normalized there, and the outer conversation receives only an ordinary tool result with text and source URLs. The extension does not register a provider or persist replay markers.

`gemini-web-search.ts` exposes the cache-stable isolated `google_search` tool exclusively for Gemini models (e.g. `gemini-3.8-flash` under `cli-proxy-api-google` and upstream `google` provider models). Session-start and model-selection hooks dynamically activate `google_search` when a Gemini model is selected and deactivate it for non-Gemini models (such as GPT or Claude). When called, it executes an isolated sub-request via Pi's model registry with Google Search Grounding (`googleSearch`), returning structured factual synthesis and cited URLs while preserving the main agent conversation's prompt cache and tool stability. `/gemini-search-status` (and `/google-search-status`) inspects availability for the current model.

`claude-cache-retention.ts` upgrades existing Anthropic `cache_control` markers to a one-hour TTL only for the `cli-proxy-api-anthropic` provider. This keeps `PI_CACHE_RETENTION` unset so OpenAI and other Pi providers retain their default cache policies.

`cache-preserving-compaction/` intercepts Pi's default compaction summarization call. It replays the last native system prompt, conversation, tools, headers, reasoning level, and session ID, then appends one structured user checkpoint instruction. This preserves the existing provider prompt prefix when the provider still has it cached. Failed or invalid summaries cancel compaction instead of falling back to Pi's uncached standalone summarizer.

`pi-arcweld-todos` and `plan-mode` are a decoupled pair. The todos package registers the always-on `update_todos` tool that tracks long-horizon work in every mode; plan mode is a policy layer that instructs the model to record its plan through that same tool. The only shared contract is the tool name `update_todos` and its `details.todos` shape, so either extension loads and runs without the other.

## Native MCP

The active MCP client is built into Pi. User configuration uses `mcpServers` in `~/.pi/agent/mcp.json`; Camoufox and Chrome DevTools retain their deployed absolute launcher paths. Both use `exposure: "codemode"` and a fixed `description`, so connecting or changing their tool catalogs does not add declarations to the model's tool list or change the server summary.

Use `searchTools()`, `describeTool()`, and `describeNamespace()` inside codemode, then call `tools.mcp__<server>__<tool>()`. Native MCP also provides OAuth, resources, and trusted project overrides. It inherits the Pi process environment and does not read the former client's `mcp.env` file. See the [upstream MCP documentation](../pi-mono/packages/coding-agent/docs/mcp.md).

The former local MCP client has been removed. Native MCP owns discovery and calls; no replacement `/mcp` command or client wrapper is loaded.

## Loading model

Pi auto-discovers global files and directories under `~/.pi/agent/extensions/`. Use symlinks there for extensions that should support `/reload` directly from this checkout.

Use a local-path package registration for a package whose `package.json` declares Pi resources and owns runtime dependencies:

```bash
pi install ./path/to/package
```

Pi records a local package path without copying the package. Relative package paths are resolved from the settings file that contains them.

Do not add a root npm workspace or install dependencies in `pi-mono/`.

## Development

The shared check tools are owned by `scripts/checks/`, independently of any extension:

```bash
npm ci --ignore-scripts --prefix scripts/checks
scripts/check-workspace.sh
```

Source-only packages use this pinned TypeScript/TSX toolchain and temporarily link only the built Pi runtime packages during checks; they keep no extension-local dependency tree. Each package also exposes `npm run check`, `npm test`, and `npm run pack:check`. Test the self-contained extensions through their user-level symlinks or explicitly with:

```bash
pi -e ./extensions/questionnaire.ts
pi -e ./extensions/vibrant-footer.ts
pi -e ./extensions/exa-search.ts
pi -e ./extensions/codex-web-search.ts
pi -e ./extensions/claude-web-search
pi -e ./extensions/grok-search.ts
```

For search configuration checks, run `/exa-search-status` for Exa, `/codex-web-search-status` to inspect both hosted `web_search` and explicit `web_run` availability for the selected model, `/claude-web-search-status` for the isolated cache-stable Anthropic route, and confirm both `grok-4.20-multi-agent-0309` and `grok-4.6` appear in `pi --list-models` for Grok.

After changing an auto-discovered extension, run `/reload` in an active Pi session. Restart Pi after changing package registration or dependencies.

The upstream update helper runs `scripts/check-workspace.sh` against the rebuilt runtime before reporting success. The checks exercise nested tool dispatch, resumed todo state, plan-mode custom runs, compaction request prefixes, questionnaire keyboard input, and footer usage accounting. Provider availability remains a separate live check: a passing test suite cannot detect a removed CPA model alias or expired credentials. After provider or model changes, verify one real search through each affected extension; Claude search requires a configured supported Anthropic route.
