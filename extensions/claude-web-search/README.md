# Replay-safe Claude web search

A Pi extension that enables Anthropic's provider-side `web_search` while preserving native server-tool responses across Pi tool continuations and `pause_turn` responses.

The extension overrides only `streamSimple` for the built-in `anthropic` provider and the local `cli-proxy-api-anthropic` provider. Existing model definitions, credentials, request options, and provider routing remain composed by Pi.

## Safety model

Anthropic server-tool blocks are tunneled through Pi as invisible, versioned replay markers. Before the next Anthropic request, the extension validates and restores the original blocks and ordering. Malformed markers fail locally and are never sent to the provider.

`pause_turn` responses are continued inside the provider wrapper. Pause boundaries are retained as invisible markers so later requests expand back into Anthropic's original consecutive assistant messages. Continuation is bounded, cancellation-aware, and fails clearly if a paused response unexpectedly contains executable client tools.

The extension does not log marker payloads or encrypted search content. Structured Anthropic citation annotations are not rendered by Pi. Session branches that failed under the former payload-only injector have already lost their server blocks and must restart or branch before that turn.

## Status

Use `/claude-web-search-status` to show whether the selected model uses the replay-safe route.

## Development

```bash
npm ci --ignore-scripts
npm run check
npm test
npm run pack:check
```

Tests use synthetic SSE and fake provider streams. They make no live model requests.
