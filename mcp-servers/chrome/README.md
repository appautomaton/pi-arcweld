# Google Chrome browser notes

This directory documents and updates a user-local Google Chrome browser. It does not contain or maintain an MCP server. `pi-arcweld` does not select, install, version, launch, or register Chrome DevTools MCP.

## Recommended layout

```text
$HOME/.local/chrome/
├── current/opt/google/chrome/chrome
├── google-chrome-stable_current_arm64.deb
└── cdt-profile/
```

This location is a project convention, not a Chrome requirement.

## Install and update

Run the helper in a compatible Linux environment:

```bash
scripts/update.sh
```

The script downloads the current stable Linux ARM64 package, extracts it under `$HOME/.local/chrome`, verifies that the browser runs, and swaps it into `current/`. It leaves the browser profile untouched.

Do not use `dpkg -i` or `apt install`; those commands perform a system installation and may register Google's package repository.

The browser executable is:

```text
$HOME/.local/chrome/current/opt/google/chrome/chrome
```

## External MCP configuration

Choose, install, and update any Chrome MCP server independently by following its upstream documentation. This repository does not select or pin one.

When the chosen server supports a custom browser executable, pass the actual absolute path at runtime. For Chrome DevTools MCP, the relevant option is:

```text
--executable-path <absolute-home>/.local/chrome/current/opt/google/chrome/chrome
```

Use a separate browser profile for each concurrent server process. MCP configuration should contain absolute paths because `$HOME` and `~` may not be expanded.
