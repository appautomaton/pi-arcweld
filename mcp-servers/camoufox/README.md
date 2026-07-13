# Local Camoufox MCP

A small, locally owned MCP stdio server for the shared Camoufox ARM64 runtime.

## Architecture

```text
Pi / MCP host
  -> <checkout>/bin/camoufox-mcp
  -> src/index.js (@modelcontextprotocol/sdk)
  -> guarded tools, compact/full snapshots, completion, sessions, queue, cleanup
  -> camoufox-js 0.10.2
  -> playwright-core 1.59.0
  -> Camoufox 135.0.1-beta.24 ARM64
```

`camoufox-js` launches and configures Camoufox. `playwright-core` performs navigation and browser actions. The local server translates MCP calls into a deliberately bounded tool surface and adds URL policy, output control, completion observation, cancellation, and cleanup.

The server does not contain host-side confirmation prompts; those belong to the MCP client.

## Fresh PRoot ARM64 setup

The verified setup target is Debian 13 AArch64 under PRoot. From a fresh checkout:

```bash
npm run bootstrap:proot-arm64
```

The bootstrap:

1. verifies Debian, PRoot, AArch64, Node 24+, and required commands;
2. restores the exact npm dependency tree with `npm ci`;
3. downloads the pinned Camoufox `135.0.1-beta.24` Linux ARM64 archive;
4. verifies its byte size, archive SHA-256, and executable SHA-256;
5. installs it into `$HOME/.cache/camoufox` without overwriting an unknown cache;
6. runs `npm run doctor`.

The approximately 675 MiB browser archive is downloaded from the official Camoufox GitHub release. Runtime artifacts are not stored in this source tree. To use an already downloaded verified archive, set `CAMOUFOX_ARCHIVE=/path/to/camoufox-135.0.1-beta.24-lin.arm64.zip` when running the bootstrap.

See [docs/runtime-support.md](docs/runtime-support.md) and [config/proot-arm64-runtime.json](config/proot-arm64-runtime.json) for the support boundary and recorded hashes.

General Debian AArch64 and Apple Silicon macOS are planned follow-up targets but are not yet validated. Windows and other architectures are outside the current roadmap.

## Pi configuration

Pi loads this server as a user-global stdio MCP server:

```json
{
  "servers": {
    "camoufox": {
      "transport": "stdio",
      "command": "/absolute/path/to/camoufox/bin/camoufox-mcp",
      "args": []
    }
  }
}
```

The live configuration is in `~/.pi/agent/mcp.json`.

## Run directly

```bash
./bin/camoufox-mcp
```

## Tools

| Category | Tools |
|---|---|
| Status | `camoufox_status` |
| One-shot | `browse`, `browse_sequence`, `browse_screenshot` |
| Session lifecycle | `browse_session_start`, `browse_session_close` |
| Session work | `browse_session_navigate`, `browse_session_snapshot`, `browse_session_action`, `browse_session_screenshot` |

One-shot calls launch an isolated browser and close it when the call ends. Persistent sessions keep browser state for multi-step work and expire after ten minutes of inactivity by default.

## Preferred multi-step flow

```text
browse_session_start
  -> browse_session_navigate       compact actionable state
  -> browse_session_action         compact actionable continuation
  -> browse_session_snapshot       deliberate rich read when needed
  -> browse_session_close
```

Example action:

```json
{
  "sessionId": "sess_...",
  "actions": [
    {
      "type": "click",
      "target": "s2_e7"
    }
  ]
}
```

## Compact and full detail

Snapshot-bearing tools accept:

```json
{
  "detail": "compact"
}
```

or:

```json
{
  "detail": "full"
}
```

| Tool | Default | Returned page state |
|---|---|---|
| `browse` | `full` | Visible text, ARIA, and elements |
| `browse_sequence` | `compact` | Final ARIA continuation state |
| `browse_session_navigate` | `compact` | Actionable ARIA continuation state |
| `browse_session_snapshot` | `full` | Deliberate rich page read |
| `browse_session_action` | `compact` | Action results plus actionable ARIA continuation state |

Compact output includes:

- page URL and title
- bounded AI ARIA snapshot
- snapshot ID and reference count
- actionable refs for persistent sessions
- `omitted: ["text", "elements"]`

It skips visible-text extraction and the separate element inventory entirely. Its default ARIA budget is 12,000 characters, which keeps normal iterative actions below Pi's generic 50 KB MCP guard.

Full output preserves the previous rich fields:

- `text`
- `textTruncated`
- `ariaSnapshot`
- `ariaTruncated`
- `elements`
- `elementsTruncated`

`maxChars` limits text and ARIA output. `maxElements` applies to the full element inventory. Full output may exceed the host budget on large pages; JSON is pretty-printed so Pi can show a useful prefix and save the complete output to its protected temporary file.

## Snapshot-scoped targets

Persistent-session snapshots use Playwright's AI ARIA snapshot and publish scoped targets such as:

```text
- link "Next" [ref=s1_e6]
```

Rules:

- `target` is preferred for persistent-session actions.
- A new session snapshot replaces the previous target set.
- Navigation invalidates previous targets.
- Reusing an old target returns `STALE_TARGET`; capture a fresh snapshot and retry.
- `selector` remains available as an advanced compatibility fallback.
- Do not provide both `target` and `selector` for one action.
- One-shot snapshots use `referenceScope: "none"` and omit refs because their browser closes before another MCP call could use them.

## Action completion

The server owns bounded post-action completion instead of relying on a fixed sleep or Playwright's unbounded navigation coupling.

For each action it:

1. records requests and the starting URL;
2. performs the action with normal actionability checks;
3. observes immediate navigation and requests;
4. waits up to a hard cap for main-frame load or relevant document/script/XHR/fetch completion;
5. checks page/network safety before continuing.

It does not use `networkidle`, and it does not wait indefinitely on long polling.

Each action returns compact completion metadata:

```json
{
  "completion": {
    "kind": "navigation",
    "urlChanged": true,
    "observedRequests": 8,
    "waitedMs": 640
  }
}
```

`kind` is `navigation`, `requests`, or `settled`. A bounded completion timeout is reported as `timedOut: true` without turning an otherwise successful browser action into a failure. MCP cancellation still aborts promptly.

## Response contract

Responses use schema version 2:

```json
{
  "schemaVersion": "2",
  "ok": true,
  "operation": "browse_session_action",
  "session": {
    "id": "sess_...",
    "expiresAt": "..."
  },
  "page": {
    "url": "https://example.com/",
    "title": "Example Domain"
  }
}
```

The pretty-printed JSON text block and MCP `structuredContent` contain the same object. Screenshot bytes remain in a separate MCP image block.

Structured errors use:

```json
{
  "schemaVersion": "2",
  "ok": false,
  "operation": "browse_session_action",
  "error": {
    "code": "STALE_TARGET",
    "message": "...",
    "retryable": true,
    "suggestion": "Capture a fresh session snapshot and use one of its targets."
  }
}
```

Target-related error codes:

| Code | Meaning |
|---|---|
| `SNAPSHOT_REQUIRED` | No active snapshot exists for target resolution |
| `INVALID_TARGET` | Target syntax is invalid or was not published by the active snapshot |
| `STALE_TARGET` | Target belongs to an older snapshot generation |
| `TARGET_NOT_FOUND` | Target was valid but disappeared from the live page |

## Policy

- Only fully qualified `http:` and `https:` targets.
- Blocks local/private/link-local/multicast/documentation/reserved IPv4 and IPv6 targets before navigation and on browser requests, including WebSockets.
- No proxy input, arbitrary Firefox preferences, browser arguments, addon control, persistent profile path, or page `eval` tool. Default addon download is disabled by the server.
- Output is bounded; screenshots are capped at 5 MiB.
- MCP cancellation removes queued work or closes the request/session browser so Playwright work is interrupted.
- One browser slot, one persistent session, and an eight-request queue by default.
- stdin disconnect, `SIGHUP`, `SIGINT`, and `SIGTERM` converge on graceful browser/session cleanup.
- PRoot isolation and Camoufox's Xvfb behavior are unchanged. The URL guard is application-layer best effort, not a network sandbox.

## Checks

```bash
npm run doctor
npm test
npm run test:integration
```

`npm run test:integration` already enables `CAMOUFOX_INTEGRATION=1` and serializes the real-browser integration files.
