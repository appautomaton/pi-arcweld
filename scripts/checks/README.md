# Extension check tools

This package owns the pinned TypeScript and TSX tools used by the local extension checks. Pi host packages come from `build/pi-agent/runtime`; they are never installed here.

Restore the check tools from the repository root:

```sh
npm ci --ignore-scripts --prefix scripts/checks
scripts/check-workspace.sh
```

The native MCP regression uses Pi's in-memory transport and a simulated model. It checks real tool dispatch, stable request prefixes after discovery and catalog changes, and resumed sessions without contacting a model service or starting browsers.
