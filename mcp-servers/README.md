# MCP servers

`mcp-servers/` contains the canonical source for locally maintained Model Context Protocol servers. An MCP server is a standalone process that Pi's MCP client launches and talks to over the protocol. These are not Pi extensions and are never loaded into the agent process.

The source checkout and the active runtime are deliberately separate:

```text
source:   <repository>/mcp-servers/<server>/
runtime:  ~/.local/mcps/<server>/current/
config:   ~/.pi/agent/mcp.json
```

Develop and review source here, deploy a tested versioned release, then register the deployed `current` launcher. Pi must not run mutable MCP source directly from the Git checkout.

## Inventory

| Path | Server | Runtime |
| --- | --- | --- |
| `camoufox/` | Bounded Camoufox browser-automation MCP server (stdio) | `~/.local/mcps/camoufox/current/` |
| `chrome/` | Provisioning guidance and update script for the user-local Chrome browser; no MCP server code | Not loaded as an MCP server |

## Camoufox deployment

From the canonical source directory:

```bash
cd <absolute-repository>/mcp-servers/camoufox
npm run deploy:local
```

For first-time browser installation, platform support, Pi registration, and verification, follow [`camoufox/README.md`](camoufox/README.md).

The deployment command creates and tests a new versioned release before atomically changing `current`:

```text
~/.local/mcps/camoufox/
├── releases/<version>-<timestamp>-<source-fingerprint>/
├── current  -> releases/<active-release>/
└── previous -> releases/<previous-release>/
```

Useful commands:

```bash
npm run deploy:status
npm run deploy:rollback
```

The active Pi registration uses an absolute path:

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

`~/.pi/agent/mcp.json` is machine-local and is not tracked in this repository. Restart Pi after first adding the registration. After a later deploy or rollback, run `/mcp reconnect camoufox` or restart Pi so the active server process uses the new `current` release.
