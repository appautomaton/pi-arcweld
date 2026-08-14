# Local Camoufox MCP

A small, locally owned MCP stdio server for the shared Camoufox runtime on ARM64 platforms.

## Supported systems

Two runtime profiles are selected automatically by `scripts/runtime-profile.js`:

| Profile | System | Status |
| --- | --- | --- |
| `proot-arm64` | Debian 13 AArch64 under PRoot | Verified |
| `darwin-arm64` | macOS on Apple Silicon | Pending revalidation |

[docs/runtime-support.md](docs/runtime-support.md) is the single source of truth for the support boundary and roadmap. Each `config/<profile>-runtime.json` records that profile's configured pins, artifact hashes, and current verification status.

## Directory roles

| Location | Purpose |
| --- | --- |
| `<repository>/mcp-servers/camoufox/` | Canonical source, tests, manifests, and deployment scripts |
| `$HOME/.local/mcps/camoufox/current/` | Tested MCP release that Pi actually runs |
| `$HOME/.local/camoufox/` | Camoufox browser runtime; it contains no MCP server code |
| `$HOME/.pi/agent/mcp.json` | Machine-local Pi registration; never committed to Git |

Source changes do not affect the running MCP until `npm run deploy:local` succeeds and Pi reconnects to the server.

## Architecture

```text
Pi / MCP host
  -> ~/.local/mcps/camoufox/current/bin/camoufox-mcp
  -> deployed src/index.js (@modelcontextprotocol/sdk)
  -> guarded tools, compact/full snapshots, completion, sessions, queue, cleanup
  -> camoufox-js 0.12.0
  -> playwright-core 1.60.0
  -> profile-pinned Camoufox ARM64 (152.0.4-beta.28 on PRoot Linux)
```

`playwright-core` is held below 1.61.0 because `camoufox-js` 0.12.0 declares that upper bound; see [docs/runtime-support.md](docs/runtime-support.md).

`camoufox-js` launches and configures Camoufox. `playwright-core` performs navigation and browser actions. The local server translates MCP calls into a deliberately bounded tool surface and adds URL policy, output control, completion observation, cancellation, and cleanup.

The server does not contain host-side confirmation prompts; those belong to the MCP client.

## Prerequisites

- Pi's MCP client extension must be installed or registered; see [`../../extensions/mcp-extension/README.md`](../../extensions/mcp-extension/README.md).
- Use Node.js 24 or newer.
- The verified PRoot workflow requires Debian 13 AArch64 plus `curl`, `sha256sum`, `unzip`, and `Xvfb`.
- Keep at least 3 GiB of free space available under `$HOME/.local` during first installation; the compressed archive and extracted browser coexist there while verification runs.
- Use absolute paths in `~/.pi/agent/mcp.json`; the config does not expand `$HOME` or `~`.

## First-time setup

Run setup commands from the canonical Camoufox MCP source directory, not from the repository root or a deployed release:

```bash
cd <absolute-repository>/mcp-servers/camoufox

# Verified target: Debian 13 AArch64 under PRoot
npm run bootstrap:proot-arm64

# Install and test an independent MCP release under ~/.local/mcps/camoufox/
npm run deploy:local
```

The Apple Silicon command also exists:

```bash
npm run bootstrap:darwin-arm64
```

However, the macOS profile is currently **pending revalidation**. Treat only the PRoot ARM64 workflow as verified until the macOS checks are rerun.

The bootstrap:

1. verifies the platform, architecture, Node 24+, and required commands;
2. restores the exact npm dependency tree with `npm ci`;
3. downloads the browser archive pinned by the selected runtime profile;
4. verifies its byte size, archive SHA-256, and executable SHA-256;
5. installs the browser into `$HOME/.local/camoufox` without overwriting an unknown installation;
6. runs `npm run doctor`.

`npm run deploy:local` then copies the MCP source into a staging release, installs that release's dependencies, runs doctor, unit tests, and real-browser integration tests, and changes `current` only after all checks pass.

The browser archive (roughly 624 MiB for Linux ARM64, 297 MiB for macOS ARM64) is downloaded from the official Camoufox GitHub release. Runtime artifacts are not stored in this source tree, and nothing is installed system-wide. To use an already downloaded copy of the exact pinned archive, set `CAMOUFOX_ARCHIVE=/path/to/the-pinned.zip` when running the bootstrap; the installer still checks its recorded byte size and SHA-256.

The browser installer never overwrites `$HOME/.local/camoufox`. For an upgrade, keep or move the existing directory first, install and validate the pinned replacement, then remove the old copy only after the new browser works.

See [docs/runtime-support.md](docs/runtime-support.md) and the manifests in [config/](config/) for the support boundary and recorded hashes.

General Debian AArch64 is a planned follow-up target but is not yet validated. Windows, Intel macOS, and other architectures are outside the current roadmap.

## Pi configuration

Merge the `camoufox` entry below into the existing `servers` object in `~/.pi/agent/mcp.json`; do not replace unrelated server entries. Pass both the deployed launcher and installed browser as absolute paths:

```json
{
  "servers": {
    "camoufox": {
      "transport": "stdio",
      "command": "<absolute-home>/.local/mcps/camoufox/current/bin/camoufox-mcp",
      "args": [
        "--executable-path",
        "<absolute-home>/.local/camoufox/camoufox-bin"
      ],
      "enabled": true
    }
  }
}
```

On macOS, use `<absolute-home>/.local/camoufox/Camoufox.app/Contents/MacOS/camoufox`. Replace the placeholders with absolute paths; MCP configuration does not expand `$HOME` or `~`.

The deploy command does not edit `mcp.json` and does not restart an existing MCP process. After first adding the registration, restart Pi. After a later deploy or rollback, run:

```text
/mcp reconnect camoufox
```

A full Pi restart is also valid. Then verify:

1. `/mcp status` reports `camoufox` as `ready`;
2. `camoufox_status` reports the expected MCP version and `browserAvailable: true`;
3. from the repository root, `scripts/check-user-wiring.sh` passes when the rest of the Pi workspace is configured.

## Deployment and direct runs

```bash
npm run deploy:local      # test and deploy a new versioned release
npm run deploy:status     # show current, previous, and all releases
npm run deploy:rollback   # swap current and previous; reconnect Pi afterward
```

Pi should run the deployed launcher:

```bash
$HOME/.local/mcps/camoufox/current/bin/camoufox-mcp \
  --executable-path "$HOME/.local/camoufox/camoufox-bin"
```

Running `./bin/camoufox-mcp` from the source checkout is for development and tests only.

## Current runtime defaults

The MCP server currently launches Camoufox with these defaults:

| Setting | Default | Effect |
| --- | --- | --- |
| Fingerprint platform | Linux on PRoot; macOS on Darwin | Keeps generated fingerprints aligned with the selected platform |
| Display mode | `virtual` on Linux; ordinary headless on macOS | Linux uses an Xvfb virtual display |
| Humanized input | Enabled | Camoufox applies humanized pointer behavior |
| GeoIP lookup | Disabled | No automatic locale, timezone, or geolocation adjustment from the public IP |
| WebRTC | Disabled | Reduces network-address exposure; WebRTC applications will not work |
| Browser cache | Disabled | Reduces retained state between isolated browser runs |
| Default UBO addon | Excluded | Avoids addon download, startup overhead, and page changes from ad blocking |
| Service workers | Blocked per browser context | Reduces persistent background state |
| Browser concurrency | 1 | Additional work waits in the bounded queue |
| Queue capacity | 8 | Excess work is rejected instead of growing without bound |
| Persistent sessions | 1 | A session expires after 10 minutes of inactivity |
| Request budget | 1,024 per browser context | Stops pages that exceed the configured network-request limit |

Each new browser process receives a newly generated Camoufox fingerprint. A persistent MCP session keeps the same browser instance and fingerprint until the session closes or expires.

These resource defaults are read once when the MCP server process starts:

| Environment variable | Default | Accepted range |
| --- | ---: | ---: |
| `CAMOUFOX_MCP_MAX_CONCURRENCY` | 1 | 1–4 |
| `CAMOUFOX_MCP_MAX_QUEUE` | 8 | 0–50 |
| `CAMOUFOX_MCP_QUEUE_TIMEOUT_MS` | 30,000 | 1,000–300,000 |
| `CAMOUFOX_MCP_LAUNCH_TIMEOUT_MS` | 45,000 | 1,000–300,000 |
| `CAMOUFOX_MCP_MAX_REQUESTS` | 1,024 | 32–10,000 |
| `CAMOUFOX_MCP_MAX_SESSIONS` | 1 | 1–4 |
| `CAMOUFOX_MCP_SESSION_TTL_MS` | 600,000 | 60,000–900,000 |

Set overrides in the Camoufox server's `env` object in `~/.pi/agent/mcp.json`, then reconnect or restart the server. Values outside the accepted range are clamped. `camoufox_status` reports the active concurrency, queue, session, and session-TTL values, but it intentionally does not expose arbitrary process environment data.

Callers cannot supply arbitrary browser options, proxy settings, Firefox preferences, or page-evaluation code.

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
- Process isolation follows the platform profile: Firefox's native content sandbox on macOS, and the PRoot accommodations described in [docs/runtime-support.md](docs/runtime-support.md) under PRoot. The URL guard is application-layer best effort, not a network sandbox.

## Checks

```bash
npm run doctor
npm test
npm run test:integration
```

`npm run test:integration` already enables `CAMOUFOX_INTEGRATION=1` and serializes the real-browser integration files.
