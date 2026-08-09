# Chrome for Chrome DevTools MCP

This directory documents a user-local Google Chrome installation for `chrome-devtools-mcp`. It contains no MCP server code.

The browser stays outside the system package manager and uses no Google auto-updater. The downloaded `.deb` is retained beside the extracted browser for repeatable installation.

## Recommended layout

```text
$HOME/.local/chrome/
├── current/opt/google/chrome/chrome
├── google-chrome-stable_current_arm64.deb
└── cdt-profile/
```

This location is a project convention, not a Chrome requirement. The MCP configuration passes the browser executable as an absolute runtime path.

## Install

Check for an existing browser first:

```bash
$HOME/.local/chrome/current/opt/google/chrome/chrome --version
```

Install the current stable Linux ARM64 package when needed:

```bash
mkdir -p "$HOME/.local/chrome"
cd "$HOME/.local/chrome"
curl -fL -o google-chrome-stable_current_arm64.deb \
  https://dl.google.com/linux/direct/google-chrome-stable_current_arm64.deb
dpkg -x google-chrome-stable_current_arm64.deb current || true
current/opt/google/chrome/chrome --version
```

Do not use `dpkg -i` or `apt install`; the package post-install script registers Google's update repository.

## Pi configuration

Register the stock Chrome DevTools MCP server in `~/.pi/agent/mcp.json`:

```json
{
  "servers": {
    "chrome-devtools": {
      "transport": "stdio",
      "command": "<absolute-path-to-npx>",
      "args": [
        "-y",
        "chrome-devtools-mcp@1.6.0",
        "--executable-path",
        "<absolute-home>/.local/chrome/current/opt/google/chrome/chrome",
        "--headless",
        "--user-data-dir",
        "<absolute-home>/.local/chrome/cdt-profile",
        "--chrome-arg=--no-sandbox",
        "--chrome-arg=--disable-dev-shm-usage",
        "--chrome-arg=--disable-gpu",
        "--no-usage-statistics"
      ],
      "enabled": false
    }
  }
}
```

Replace the placeholders with absolute paths. MCP configuration does not expand `$HOME` or `~`. Find `npx` with `command -v npx`.

A Chrome profile can be opened by only one process at a time. Use a separate profile path for each concurrent MCP server.

## Update

```bash
scripts/update.sh
```

The script downloads the current stable package, verifies that the extracted browser runs, swaps it into `current/`, and leaves the profile untouched. Restart or reload the MCP client afterward.

## Runtime notes

- Headless mode is required when no display server is available.
- `--no-sandbox` is required when the runtime cannot provide Chrome's namespace sandbox.
- Software rendering is suitable for screenshots and layout checks, not graphics-performance measurements.
