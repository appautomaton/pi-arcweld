# MCP servers

`mcp-servers/` holds local Model Context Protocol servers. An MCP server is a standalone process that the Pi MCP client launches over stdio and talks to over the protocol. These are not Pi extensions. They are never loaded into the agent and they own their own dependencies and lifecycle.

This keeps a clear boundary: `extensions/` is client-side code loaded into Pi, and `mcp-servers/` is the separate server processes that client connects to.

## Inventory

| Path | Server | Loading |
| --- | --- | --- |
| `camoufox/` | Camoufox browser-automation MCP server (stdio) | Registered in `~/.pi/agent/mcp.json` by absolute launcher path |

## Loading model

A stdio MCP server is registered in the user-owned `~/.pi/agent/mcp.json`, which the MCP client reads. The client requires an absolute command path, so the registration points at the launcher inside this repository, for example:

```json
{
  "servers": {
    "camoufox": {
      "transport": "stdio",
      "command": "<repository>/mcp-servers/camoufox/bin/camoufox-mcp",
      "args": []
    }
  }
}
```

`mcp.json` is machine-local and is not tracked in this repository. The launcher script resolves its own root relatively, so only the registration in `mcp.json` needs the absolute path.

## Development

Each server owns its dependencies and checks. Install and validate from the server directory:

```bash
cd mcp-servers/camoufox
npm ci --ignore-scripts
npm run doctor
npm test
```

`npm test` runs the unit suite serialized, which keeps the server-spawning tests reliable in constrained runtimes where parallel process launches would otherwise contend. Integration tests that launch a real browser are gated behind `CAMOUFOX_INTEGRATION=1` and run with `npm run test:integration`.
