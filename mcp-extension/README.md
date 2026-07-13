# Pi MCP Client

A small MCP client extension for Pi. It discovers user-configured stdio and Streamable HTTP capabilities in the background while keeping the model-facing tool surface fixed at two tools.

## Status

The package currently uses the temporary private name `pi-mcp-client-local`. It is not published to npm.

## Install locally

```bash
cd /home/dev/agents/pi/mcp-extension
npm install --ignore-scripts
pi install /home/dev/agents/pi/mcp-extension
```

A local-path install records the package path in Pi settings; it does not copy or rebuild the package. During development, edit `src/*.ts` and run `/reload` in Pi. Run `npm install --ignore-scripts` again only when dependencies change.

For a one-run test without changing settings:

```bash
pi -e /home/dev/agents/pi/mcp-extension
```

## Configuration

Create `$PI_CODING_AGENT_DIR/mcp.json`, or `~/.pi/agent/mcp.json` when `PI_CODING_AGENT_DIR` is unset.

The config is user-global only. The extension does not read project MCP files or import settings from other applications. Presence in this file is consent to connect to and invoke the server.

```json
{
  "servers": {
    "remote": {
      "enabled": false,
      "transport": "streamable-http",
      "url": "https://example.com/mcp",
      "headers": {
        "Authorization": "Bearer ${REMOTE_MCP_TOKEN}"
      }
    }
  }
}
```

`enabled` is optional and defaults to `true`. A server with `"enabled": false` remains visible in `/mcp` but is not connected or launched during startup; it can still be enabled temporarily for the current session.

Secret variables are loaded privately from `mcp.env` next to `mcp.json`; they are not copied into Pi's `process.env`. Missing referenced variables fail closed.

```dotenv
# ~/.pi/agent/mcp.env (mode 0600)
REMOTE_MCP_TOKEN=...
```

`mcp.json` references values with `${NAME}`. Only variables actually referenced by a server are injected into that server's configured headers or stdio environment.

### Context7 live smoke target

Context7's official remote endpoint works anonymously with shared rate limits:

```json
{
  "servers": {
    "context7": {
      "transport": "streamable-http",
      "url": "https://mcp.context7.com/mcp"
    }
  }
}
```

Use the `CONTEXT7_API_KEY` header when higher limits are needed.

### Installed Node.js server

```json
{
  "servers": {
    "node-server": {
      "transport": "stdio",
      "command": "/usr/bin/node",
      "args": ["/opt/mcp/server/dist/index.js"]
    }
  }
}
```

### `npx`

```json
{
  "servers": {
    "context7": {
      "transport": "stdio",
      "command": "/usr/bin/npx",
      "args": ["-y", "@upstash/context7-mcp@1.2.3"]
    }
  }
}
```

`npx` may download and execute code. Use an absolute launcher path, pin the package version, and review the package before adding it to the config.

### Python virtual environment

```json
{
  "servers": {
    "python-server": {
      "transport": "stdio",
      "command": "/opt/mcp/server/.venv/bin/python",
      "args": ["-m", "example_mcp_server"]
    }
  }
}
```

### `uv run`

```json
{
  "servers": {
    "python-project": {
      "transport": "stdio",
      "command": "/home/user/.local/bin/uv",
      "args": ["run", "--project", "/opt/mcp/project", "python", "-m", "example_mcp_server"]
    }
  }
}
```

### `uvx`

```json
{
  "servers": {
    "python-package": {
      "transport": "stdio",
      "command": "/home/user/.local/bin/uvx",
      "args": ["--from", "example-mcp-server==1.2.3", "example-mcp-server"]
    }
  }
}
```

`uvx` may download and execute code. Pin versions and review packages before configuration.

## Discovery model

At session startup, the extension starts non-blocking discovery for every server enabled by default:

```text
initialize → complete paginated tools/list → cache metadata and schemas
```

The first agent turn waits up to three seconds for discovery, then freezes a bounded capability summary containing server instructions, tool names, and short descriptions. Full JSON schemas remain host-side. Slow or failed servers do not block the turn indefinitely; a cross-server `mcp search` waits on the existing background discovery promise when the model needs those capabilities.

The frozen summary is reused byte-for-byte on every later turn to keep the provider prompt-cache prefix intact. It is also stored as a private session entry so extension reloads and resumed session branches restore the exact same snapshot and current-session enablement. It contains no connection status or error text. Session enable/disable and semantic catalog changes after the freeze are coalesced into hidden append-only messages instead of rewriting the system prompt. Catalog fingerprints include descriptions and schemas, while reconnects that restore identical catalogs stay silent. `mcp status` is always the live view.

This is a host-side progressive-discovery fallback for Pi 0.80.6, which does not expose provider-native `defer_loading`, `tool_reference`, or `tool_search`. stdio servers are therefore started during session discovery, not on their first business tool call. Tool invocations remain strictly on demand.

## Pi tools

### `mcp`

Catalog operations:

```text
mcp({ action: "status" })
mcp({ action: "list", server: "context7" })
mcp({ action: "search", query: "current library documentation" })
mcp({ action: "search", server: "context7", query: "library documentation" })
mcp({ action: "describe", server: "context7", tool: "resolve-library-id" })
```

`list` and `search` are cursor-paginated. Search uses deterministic weighted keyword ranking over tool names, descriptions, server identity, and server instructions. Omit `server` to search every ready catalog. Listing remains available when search misses.

### `mcp_call`

```text
mcp_call({
  server: "context7",
  tool: "resolve-library-id",
  arguments: {
    libraryName: "React",
    query: "React useEffect cleanup documentation"
  }
})
```

The MCP server validates tool arguments against its own schema.

### `/mcp`

Opens a live, theme-aware server control panel. It shows connection state, tool count, transport, current-session enablement, and the default for future sessions.

```text
enter/space  enable or disable for this session
r            reconnect
d            change the future-session default (confirmed)
up/down      select server
esc          close
```

The command also has scriptable fast paths:

```text
/mcp status
/mcp enable <server>
/mcp disable <server>
/mcp reconnect <server>
/mcp set-default <server> enabled|disabled
```

Session actions are immediate and never write configuration. `set-default` changes only the raw `enabled` field after confirmation and does not change the current session. The write path preserves literal `${TOKEN}` placeholders, exact file permissions, and a configured symlink by replacing its target rather than the link. It never serializes expanded secrets.

## Security model

- Only user-global configuration is loaded.
- stdio commands must be absolute paths and are launched without a shell.
- MCP credentials are parsed from the private colocated `mcp.env` with Node's `util.parseEnv`; they are not loaded into Pi's global process environment.
- Each server receives only variables referenced by its own headers or stdio configuration.
- stdio servers receive the MCP SDK's restricted default environment plus explicitly configured values, not Pi's full environment.
- Server metadata and output are treated as untrusted content.
- Server errors displayed in commands or the TUI have terminal control and ANSI escape sequences removed.
- Server instructions, tool descriptions, schemas, and annotations are untrusted metadata.
- Capability summaries have a fixed character budget; long instructions and descriptions are truncated.
- Tool annotations are informational and never authorize operations.
- Tool calls are not automatically retried because they may have side effects.
- Large output is truncated and written to a mode-`0600` temporary file.
- OAuth is not supported in this release. Remote servers requiring OAuth will fail authentication.

## Development

```bash
npm run check
npm test
npm run pack:check
```

Tests use local deterministic stdio and Streamable HTTP fixtures. They do not use `npx`, download MCP servers, or contact public MCP endpoints. Context7 is used separately as an explicit live integration smoke target so network availability and rate limits cannot make the deterministic suite flaky.
