---
name: verify
summary: Drive the MCP extension through the real Pi TUI and capture provider-prefix behavior.
---

# Verify MCP extension

1. Create a throwaway `PI_CODING_AGENT_DIR` with `mcp.json` containing the stdio fixture (`test/fixture-server.ts`), a disabled server, and a broken server.
2. Launch in an isolated tmux socket from this package directory so `--import tsx` resolves:
   `tmux -L mcpverify new-session -d -s pi 'PI_CODING_AGENT_DIR=<dir> pi -e /home/dev/agents/pi/mcp-extension'`
3. Type `/mcp`; capture with `tmux -L mcpverify capture-pane -pt pi`. Exercise Enter/Space, `r`, `d`, `y`/`n`, Esc, and resize with `tmux resize-window`.
4. Verify persistence by inspecting raw `mcp.json`: only `enabled` changes, `${TOKEN}` remains literal, and the current panel session state stays independent.
5. Restart Pi against the same directory and confirm the persisted default controls startup.
6. For cache evidence, configure `models.json` with a localhost `openai-completions` provider whose server records request JSON and returns a minimal SSE completion. Send one prompt, run `/mcp disable <server>`, then send another. Compare captured requests: `messages[0].content` and `tools` must be byte-identical; the MCP runtime update must appear only as a later message.

Use only throwaway config and localhost endpoints. Never exercise the user's real remote MCP servers or credentials during verification.
