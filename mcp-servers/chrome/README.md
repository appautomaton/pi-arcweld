# Chrome for Playwright MCP

Setup notes for browser automation with real Google Chrome. Unlike `camoufox/`, there is no server code here: the MCP server is the stock `@playwright/mcp` package fetched by `npx`, and this folder only documents how the Chrome binary it drives is installed and updated.

Design decisions (2026-07-26): always current Chrome, no version pinning; binary lives user-locally with no system install and no auto-updater; the downloaded `.deb` is kept next to the extraction so re-extracting never depends on the network.

## Layout on disk

```
~/.cache/chrome/
├── current/opt/google/chrome/chrome        # extracted binary (run directly)
├── google-chrome-stable_current_arm64.deb  # the archive it came from
└── mcp-chrome-profile/                     # persistent browser profile
```

## Setup

Check first — if this prints a version, Chrome is already installed and you are done:

```bash
~/.cache/chrome/current/opt/google/chrome/chrome --version
```

Otherwise install fresh:

```bash
mkdir -p ~/.cache/chrome && cd ~/.cache/chrome
curl -L -o google-chrome-stable_current_arm64.deb \
  https://dl.google.com/linux/direct/google-chrome-stable_current_arm64.deb
dpkg -x google-chrome-stable_current_arm64.deb current || true   # tar chmod warnings under PRoot are harmless
current/opt/google/chrome/chrome --version
```

Do not `dpkg -i` / `apt install` the .deb: its postinst registers Google's auto-updating apt repository.

## Registration

Used by Claude Code, registered in `~/.claude.json` (not in Pi's `~/.pi/agent/mcp.json`):

```json
"playwright": {
  "command": "npx",
  "args": [
    "-y", "@playwright/mcp@0.0.68",
    "--browser", "chromium",
    "--executable-path", "/home/dev/.cache/chrome/current/opt/google/chrome/chrome",
    "--headless", "--no-sandbox",
    "--user-data-dir", "/home/dev/.cache/chrome/mcp-chrome-profile"
  ]
}
```

`--no-sandbox` is required under PRoot (no kernel namespaces) and `--headless` is required (no display). A config change takes effect on the next Claude Code session, not the running one.

## Update

```bash
scripts/update.sh
```

Downloads the newest stable .deb, extracts it, and swaps it in; the profile is untouched. Restart the Claude Code session afterwards.

## PRoot quirks

- WebGL is software (SwiftShader): screenshots are truthful for layout, FPS numbers are not.
- dbus/udev errors on stderr are harmless; there is no session bus in the container.
- Autoplaying videos can stall the software renderer enough to time out screenshots; pause them via JS first.
