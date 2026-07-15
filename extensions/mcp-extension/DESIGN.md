# Pi MCP Client Design

## Status

Implemented production baseline for version 0.1.0.

## Goal

Provide a small, secure MCP client extension for Pi that works with local stdio servers and remote Streamable HTTP servers without loading every MCP tool definition into the model context.

## Principles

- Use the official `@modelcontextprotocol/sdk`.
- Treat configuration, server metadata, and server output as untrusted input.
- Keep the model-facing tool surface stable and small.
- Discover complete MCP catalogs in the background and keep full schemas in the host.
- Give the model a bounded capability summary so it can route tasks without explicit user hints.
- Use deterministic weighted keyword search; do not add embeddings or external search infrastructure.
- Do not reimplement server-side schema validation.
- Fail closed at trust and credential boundaries.
- Add features only when a real use case requires them.

## Implemented Scope

### Transports

- stdio for local servers.
- Streamable HTTP for remote servers.

The server implementation language is irrelevant. A stdio server may be launched with an installed executable, Node.js, Python, `npx`, `uv`, or `uvx` when the user explicitly configures that launcher.

### Model-facing tools

The extension registers two stable Pi tools.

#### `mcp`

Catalog and connection operations:

- `status`: list configured servers and connection state.
- `list`: list tools from one server with cursor-based pagination.
- `search`: weighted keyword search across one server or every ready server.
- `describe`: return one tool's original description and input schema.

Search is a convenience, not the only discovery path. The model can always list and page through the complete catalog.

#### `mcp_call`

Invoke one exact server/tool pair with an arguments object. The MCP server remains responsible for validating the arguments against its declared schema.

### Commands

`/mcp` opens a live TUI control panel for status, session enable/disable, reconnect, and the confirmed future-session enabled default. Fast paths provide `/mcp status`, `enable`, `disable`, `reconnect`, and `set-default`.

The compact footer treats only current-session-enabled servers as the health denominator and reports disabled servers separately, so an intentional disable is not presented as degraded availability. An all-disabled session collapses to an explicit `<count> off` state rather than `0/0`; cross-server search likewise reports that no servers are enabled and suggests `/mcp` instead of presenting an empty ratio.

The panel is deliberately not a general configuration editor. It never displays or edits headers, environment values, stdio arguments, URLs beyond a sanitized origin, or other secret-bearing fields.

### Authorization policy

The user-global configuration is the user's consent to connect to and invoke the configured servers. The extension does not add per-session, per-connection, or per-call confirmation prompts.

### Server lifecycle

- Session startup begins non-blocking discovery for every server enabled by default; disabled servers remain visible but do not launch or connect.
- Discovery performs initialize and complete paginated `tools/list`, then caches server metadata and tool schemas in memory.
- Current-session enable/disable is independent of the future-session default in `mcp.json`.
- Disable synchronously invalidates the connection generation and aborts in-flight connect, refresh, and call operations before closing the transport.
- Reconnect never enables a disabled server implicitly.
- A first agent turn waits only briefly for discovery; slow or failed servers do not block the session indefinitely.
- Tool operations reuse the in-flight connection promise instead of opening duplicate connections. A caller may cancel its own wait without aborting that manager-owned shared startup.
- Disable and reconnect wait for canceled startup, refresh, and transport cleanup before a replacement connection can begin.
- stdio discovery starts the configured child process during session startup.
- Business tool calls remain on demand and are never run during discovery.
- The in-memory catalog is refreshed after connection.
- `notifications/tools/list_changed` refreshes the catalog.
- Transport closure marks the server disconnected.
- A later operation may reconnect.
- Tool calls are never automatically retried because they may have produced side effects.
- No background reconnect timers.
- `session_shutdown` closes every client and child process.

### Protocol behavior

- Follow all `tools/list` cursors with a fixed page limit.
- Propagate Pi's `AbortSignal` to MCP requests.
- Distinguish connection, protocol, cancellation, and MCP tool errors.
- Do not advertise roots, sampling, elicitation, or other client capabilities until implemented.

## Configuration

The extension reads one user-owned file:

```text
$PI_CODING_AGENT_DIR/mcp.json
```

Default location:

```text
~/.pi/agent/mcp.json
```

It does not read project-local files or import configuration from other applications.

Example:

```json
{
  "servers": {
    "filesystem": {
      "transport": "stdio",
      "command": "/usr/bin/node",
      "args": [
        "/opt/mcp/filesystem-server/dist/index.js",
        "/home/user/work"
      ]
    },
    "context7": {
      "transport": "stdio",
      "command": "/usr/bin/npx",
      "args": [
        "-y",
        "@upstash/context7-mcp@1.2.3"
      ]
    },
    "python": {
      "transport": "stdio",
      "command": "/opt/mcp/python/.venv/bin/python",
      "args": [
        "-m",
        "example_mcp_server"
      ]
    },
    "remote": {
      "transport": "streamable-http",
      "url": "https://example.com/mcp",
      "headers": {
        "Authorization": "Bearer ${REMOTE_MCP_TOKEN}"
      }
    }
  }
}
```

### Validation

- Reject unknown fields.
- Accept optional boolean `enabled`; omitted means enabled. Disabled servers are still fully validated.
- Persisting a default re-reads raw JSON, atomically changes only `enabled`, and preserves file mode, `${NAME}` placeholders, and config symlinks by replacing the resolved target; normalized secret-bearing config is never serialized.
- Reject invalid server names.
- Require an absolute stdio command path.
- Pass stdio arguments directly without a shell.
- Permit `npx`, `uv`, and `uvx` only when explicitly configured by absolute path.
- Recommend pinned package versions, but do not parse package-manager syntax.
- Parse `mcp.env` next to `mcp.json` with Node's `util.parseEnv` without mutating `process.env`.
- Resolve `${NAME}` only from that private MCP variable map and only in explicitly configured stdio environment values and HTTP headers.
- Do not fall back to Pi's process environment.
- Reject missing referenced variables instead of replacing them with empty strings.
- Reject invalid URLs.

### stdio environment

A child server does not inherit Pi's complete environment. It receives:

- a minimal runtime environment required to launch the process;
- values explicitly declared in the server configuration.

Secrets remain in the manager's private configuration objects and are not inherited by Pi's bash tool or unrelated child processes. Each server receives only values explicitly referenced in its own configuration.

## Output Handling

Reuse Pi's output limits and helpers:

- `DEFAULT_MAX_BYTES`;
- `DEFAULT_MAX_LINES`;
- `truncateHead`;
- `formatSize`.

When text output exceeds the limit:

- return a bounded preview;
- save the full text to a mode-`0600` temporary file;
- return the file path and truncation metadata.

Do not store the complete raw MCP response in tool-result details.

Supported result content:

- text;
- structured content serialized as bounded JSON;
- images passed through as native Pi image blocks when valid.

Unsupported content returns an explicit bounded description rather than being silently discarded.

## Security Boundaries

### Local launchers

`npx`, `uvx`, and similar commands may download and execute code. The extension never chooses or constructs these launchers. It only runs the exact command and arguments in the user-owned configuration.

### Remote servers

Static headers are supported. OAuth is not implemented because a compliant implementation requires discovery, PKCE, issuer/resource validation, redirect handling, and secure token storage.

### Server metadata

Tool descriptions, schemas, annotations, server identity, instructions, and output are untrusted server content. Annotations may be displayed but never determine authorization policy. Server instructions and tool descriptions are normalized and truncated before model exposure.

## Progressive Discovery

Pi 0.80.6 does not expose provider-native `defer_loading`, `tool_reference`, or `tool_search`. The extension therefore implements a host-side fallback:

1. Fetch and cache complete catalogs in the background.
2. Inject a bounded summary containing server instructions, tool names, and short descriptions.
3. Use `mcp search` for ranked cross-server discovery.
4. Use `mcp describe` to retrieve one exact full schema.
5. Use `mcp_call` to invoke the exact tool.

The capability summary has a fixed global character budget. Small catalogs fit completely; large catalogs are explicitly marked partial and direct the model to `mcp search` or paginated `mcp list`. Full schemas never enter the summary.

### Prompt-cache safety

The system prompt sits ahead of the entire conversation in every provider's prompt-cache prefix, so a system prompt that changes between turns re-bills the whole context. The summary is therefore a frozen session snapshot:

- It is rendered once, on the first agent turn after the bounded warmup wait, and reused byte-for-byte on every later turn.
- The exact summary and reported runtime state are stored in a private session entry. Extension reloads and resumed branches restore that snapshot rather than rendering a new early prompt prefix.
- It contains no volatile state: no connection status words, no live errors, no text that a status flicker can change. A server that is not ready at snapshot time gets one stable line directing the model to `mcp status` and `mcp search`.
- Current-session enable/disable and semantic catalog changes after the freeze are coalesced into hidden appended messages. Appended messages extend the cached prefix instead of invalidating it.
- Catalog fingerprints cover server identity/instructions and tool descriptions/schemas/annotations, with recursively sorted object keys. A ready zero-tool server is distinct from a non-ready server.
- Connection-state flicker, transient disconnects, error-text changes, and future-session-default-only changes are not announced. `mcp status` remains the live view, and a reconnect that restores an identical catalog produces no message.

## Non-goals

- Provider-native deferred tool loading.
- Direct registration of MCP tools as Pi tools.
- JSON Schema to TypeBox conversion.
- Embeddings or semantic/vector tool search.
- OAuth.
- Legacy SSE or WebSocket transports.
- Resources and prompts.
- Sampling and elicitation.
- MCP Apps or interactive UI resources.
- Automatic imports from Claude, Cursor, Codex, or other hosts.
- Automatic `npx` or `uvx` installation.
- Project-local configuration.
- Persistent metadata cache.
- Background health checks or reconnect loops.
- General TUI configuration editing beyond the enabled-by-default toggle.

## Packaging

The private package is named `pi-arcweld-mcp`, version `0.1.0`, under the MIT license. npm publication remains disabled with `"private": true`.

## Files

```text
extensions/mcp-extension/
├── DESIGN.md
├── README.md
├── LICENSE
├── package.json
├── src/
│   ├── index.ts
│   ├── config.ts
│   ├── manager.ts
│   ├── output.ts
│   └── ui.ts
└── test/
    ├── fixture-server.ts
    ├── freeze.test.ts
    ├── mcp.test.ts
    └── ui.test.ts
```

- `index.ts`: Pi tools, command, and session lifecycle.
- `config.ts`: strict user-global configuration loading.
- `manager.ts`: official SDK transports, lifecycle controls, catalogs, semantic fingerprints, and calls.
- `output.ts`: MCP result conversion and truncation.
- `ui.ts`: responsive themed MCP control panel.
- `fixture-server.ts`: local deterministic stdio MCP server.
- `mcp.test.ts`: config, manager, transport, and output checks.
- `freeze.test.ts`: frozen-prefix and append-only runtime regression checks.
- `ui.test.ts`: responsive rendering and keyboard-flow checks.

## Verification Coverage

The deterministic test suite verifies:

1. Invalid configuration fails closed.
2. Missing MCP environment variables fail closed and process environment fallback is rejected.
3. HTTP and stdio servers receive only their explicitly referenced variables.
4. Streamable HTTP configuration is validated.
5. `tools/list` pagination is complete and bounded.
6. `notifications/tools/list_changed` refreshes the catalog.
7. Cancellation reaches the MCP SDK request.
8. Session shutdown terminates the stdio child process.
9. A disconnected tool call is not automatically retried.
10. Oversized output is truncated and securely spilled to disk.
11. MCP `isError` results become Pi tool errors.
12. The fixture completes connect, list, describe, call, and shutdown over stdio.
13. Default-disabled servers skip warmup; session enable/disable/reconnect are race-safe and do not retry calls.
14. Durable default writes preserve raw secret placeholders, exact permissions, symlink targets, and unrelated configuration.
15. Tool definitions and the frozen MCP system-prompt suffix stay byte-identical across runtime controls, catalog changes, and extension lifecycle restoration.
16. Shared startup cancellation, cleanup serialization, and trailing catalog refreshes are regression-tested.
17. The TUI remains readable at narrow and wide widths, bounds large server lists, strips terminal controls, and requires explicit confirmation for persistent changes.

## Future Work

Add only in response to a concrete use case:

1. Standards-compliant OAuth for Streamable HTTP.
2. Trusted project-local configuration gated by Pi project trust.
3. Resources and prompts.
4. Provider-native deferred tool loading when Pi exposes it.
5. Sampling, elicitation, or MCP Apps.
