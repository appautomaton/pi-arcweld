# Cache-stable isolated Anthropic web search

A Pi extension that exposes one ordinary `WebSearch` tool and executes Anthropic-compatible hosted `web_search_20250305` only inside a minimal isolated request.

Supported routes:

- Built-in `anthropic` Claude models using Anthropic Messages.
- `claude-*` and `kimi-*` models on the local `cli-proxy-api-anthropic` provider.

## Architecture

The main agent request always sees the same ordinary tool schema:

```text
WebSearch(query, allowed_domains?, blocked_domains?)
```

When the model calls it, the extension makes a nested request through Pi's model registry using the same selected provider, model, resolved authentication, configured endpoint, headers, cancellation signal, and usage accounting. That request contains only:

- A fixed search-specific system prompt.
- One user message whose final suffix is the concrete query.
- One hosted `{ "type": "web_search_20250305", "name": "web_search", "max_uses": 8 }` declaration.
- In-memory assistant history only when the provider returns `pause_turn`.

The hosted response is reduced to ordinary text and source URLs and returned as the outer `WebSearch` tool result. Native `server_tool_use` and `web_search_tool_result` blocks never enter the main Pi conversation or session file.

## Cache behavior

The extension is deliberately cache-friendly:

- It does not register or override a provider.
- It does not use `before_provider_request` or rewrite main-agent payloads.
- It does not dynamically enable or disable tools between turns.
- The ordinary `WebSearch` schema is byte-stable after extension load.
- `bash`, `read`, `edit`, and other tool continuations receive the same main tool list and cannot trigger hosted search by declaration alone.
- The isolated request has a fixed system/tool prefix; only its query message and optional domain filters vary.
- Nested model usage is attached to the ordinary tool result so Pi's session totals remain accurate.

Reloading the extension changes the main tool list once and therefore creates one unavoidable new cache prefix. Subsequent turns keep that prefix stable.

## Robustness

- Queries are trimmed and validated before any network request.
- `allowed_domains` and `blocked_domains` are mutually exclusive, deduplicated, and bounded.
- Search requests have bounded output, retries, timeout, and `pause_turn` continuations.
- CPA Kimi's missing or mismatched hosted-search IDs are normalized only in the nested request's in-memory continuation state.
- SSE bytes are forwarded unchanged to Pi's Anthropic adapter while a side observer collects hosted result blocks.
- Tool output uses Pi's standard 50 KB / 2000-line truncation limits.
- Cancellation propagates through the tool, nested model request, and response observer.

The previous replay-marker format is intentionally not migrated. Sessions created by the old always-injected implementation are outside the compatibility scope of this rewrite.

## Status

Use `/claude-web-search-status` to show whether the selected model supports the isolated route and to confirm that hosted search is absent from normal provider requests.

## Dependency and development model

This auto-discovered local extension has no `dependencies`, `devDependencies`, lockfile, or persistent extension-local `node_modules`. Pi supplies `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, and `typebox` through the host runtime. Wildcard peer declarations document the direct Pi imports without creating a second dependency tree.

The workspace check script creates a temporary `node_modules` symlink to the built Pi runtime only while TypeScript and test commands run, then removes it. Run:

```bash
npm run check
npm test
npm run pack:check
```

Tests use synthetic SSE, fake nested model calls, and a real Pi RPC loading check. They verify cache-prefix stability, in-memory pause continuation, malformed Kimi ID normalization, output formatting, cancellation/error boundaries, and directory-symlink loading without invoking a live model.
