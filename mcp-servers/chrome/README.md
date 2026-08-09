# Chrome for Playwright MCP

Setup notes for browser automation with real Google Chrome. Unlike `camoufox/`, there is no server code here: the MCP server is the stock `@playwright/mcp` package fetched by `npx`, and this folder only documents how the Chrome binary it drives is installed and updated.

Design decisions (2026-07-26): always current Chrome, no version pinning; binary lives user-locally with no system install and no auto-updater; the downloaded `.deb` is kept next to the extraction so re-extracting never depends on the network.

## Recommended layout on disk

The project scripts use `$HOME/.cache/chrome` as the recommended user-local location. Chrome and the MCP servers do not require this location; if you choose another one, update the scripts and MCP configuration accordingly.

```
$HOME/.cache/chrome/
├── current/opt/google/chrome/chrome        # extracted binary (run directly)
├── google-chrome-stable_current_arm64.deb  # the archive it came from
├── mcp-chrome-profile/                     # Playwright MCP profile
└── cdt-profile/                            # Chrome DevTools MCP profile
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

Two stock MCP servers drive this Chrome binary:

- **Claude Code** uses `@playwright/mcp`, registered in `~/.claude.json`:

```json
"playwright": {
  "command": "npx",
  "args": [
    "-y", "@playwright/mcp@0.0.68",
    "--browser", "chromium",
    "--executable-path", "<absolute-home>/.cache/chrome/current/opt/google/chrome/chrome",
    "--headless", "--no-sandbox",
    "--user-data-dir", "<absolute-home>/.cache/chrome/mcp-chrome-profile"
  ]
}
```

- **Pi** uses `chrome-devtools-mcp`, registered in `~/.pi/agent/mcp.json` with the same flags as the Claude Code `chrome-devtools` entry. The Pi MCP extension requires an absolute `command` path and an explicit `transport`, so `npx` is fully qualified:

```json
"chrome-devtools": {
  "transport": "stdio",
  "command": "<absolute-path-to-npx>",
  "args": [
    "-y", "chrome-devtools-mcp@1.6.0",
    "--executablePath", "<absolute-home>/.cache/chrome/current/opt/google/chrome/chrome",
    "--headless",
    "--userDataDir", "<absolute-home>/.cache/chrome/cdt-profile",
    "--chromeArg=--no-sandbox",
    "--chromeArg=--disable-dev-shm-usage",
    "--chromeArg=--disable-gpu"
  ],
  "env": { "CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS": "1" }
}
```

Replace `<absolute-home>` with the home directory of the environment that runs Chrome, and `<absolute-path-to-npx>` with the output of `command -v npx`. MCP configuration does not perform shell expansion, so do not put `$HOME` or `~` in these JSON argument values. The recommended cache location may be changed as long as the installer, updater, executable path, and profile paths remain consistent.

If multiple MCP clients use the same `cdt-profile` directory, only one can run the browser at a time because Chrome holds a singleton profile lock.

`--no-sandbox` is required under PRoot (no kernel namespaces) and `--headless` is required (no display). A config change takes effect on the next agent session, not the running one.

## Update

```bash
scripts/update.sh
```

Downloads the newest stable .deb, extracts it, and swaps it in; the profile is untouched. Restart the agent sessions afterwards.

## PRoot quirks

- WebGL is software (SwiftShader): screenshots are truthful for layout, FPS numbers are not.
- dbus/udev errors on stderr are harmless; there is no session bus in the container.
- Autoplaying videos can stall the software renderer enough to time out screenshots; pause them via JS first.
