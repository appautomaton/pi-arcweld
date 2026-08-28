# Cache-preserving compaction

This Pi extension replaces the default standalone summarization request with a cache-friendly shadow request:

```text
last native system prompt
+ last native conversation
+ last assistant response
+ one structured user checkpoint instruction
```

It keeps the active model, tools and tool-choice payload, request headers, reasoning level, and session ID. The resulting summary is returned through `session_before_compact`, so Pi writes a normal `CompactionEntry` and retains its configured recent tail.

The extension is provider-agnostic and uses only Pi's public extension and provider APIs. It does not modify `pi-mono`.

## Failure policy

If the request snapshot is unavailable, the summary fails, the response is truncated, empty, or attempts a tool call, compaction is cancelled. It never silently falls back to Pi's uncached default summarization request.

A provider may still report zero cache reads because of eviction, unsupported caching, model or tool changes, or another extension changing the outgoing payload after this extension captured it. The compaction still succeeds, but Pi displays a warning when usage reports `cacheRead: 0`.

## Loading

The curated machine-local loading method is a symlink:

```bash
ln -s /Users/ac/dev/agents/coding/pi-arcweld/extensions/cache-preserving-compaction \
  ~/.pi/agent/extensions/cache-preserving-compaction
```

Run `/reload` in an active Pi session after changing the extension.

## Pairing settings

Compaction thresholds are global Pi settings and apply per active model context window:

```json
{
  "compaction": {
    "enabled": true,
    "reserveTokens": 20000,
    "keepRecentTokens": 15000
  }
}
```

Pi triggers at `contextWindow - reserveTokens`, so a 200,000-token model compacts at
180,000 tokens and keeps about 15,000 recent tokens. The summary request gets the active
model's full `model.maxTokens` output allowance; this extension adds no separate cap.

## Snapshot lifetime

The request snapshot lives in the Pi process on a shared `Symbol.for(...)` global, keyed by
Pi session ID, so `/reload`, `/new` and `/resume` keep working. It is dropped when the session
tree changes, when the model changes, and on a full Pi restart. After a model switch, complete
one ordinary request on the new model first: cache built for another model cannot be replayed.

## Validation

```bash
npm run check
npm test
npm run pack:check
```
