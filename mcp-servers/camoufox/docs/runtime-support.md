# Runtime support

## Verified profile

This local server is currently supported and verified in one environment:

| Component | Verified value |
|---|---|
| Environment | Debian GNU/Linux 13 (trixie) under PRoot |
| Architecture | AArch64 (`aarch64`) |
| Node | 24.13.0 |
| npm | 11.17.0 |
| Camoufox | 135.0.1-beta.24 Linux ARM64 |
| `camoufox-js` | 0.10.2 |
| `playwright-core` | 1.59.0 |

The machine-readable baseline is `config/proot-arm64-runtime.json`.

## Artifact split

The working installation is deliberately split into four parts:

1. Project source, lockfile, bootstrap, tests, and documentation in this directory.
2. npm dependencies restored into `node_modules/` with `npm ci`.
3. The pinned Camoufox browser installed into `$HOME/.cache/camoufox/`.
4. Pi's external MCP registration, which points to this checkout's `bin/camoufox-mcp`.

The browser binary, npm dependency tree, and user configuration are runtime state and must not be committed to Git. For repeatable/offline testing, `CAMOUFOX_ARCHIVE=/path/to/the-pinned.zip` may be supplied to the installer; the same size and SHA-256 checks still apply.

## PRoot-specific behavior

`bin/camoufox-mcp` detects PRoot and delegates to `bin/camoufox-mcp-proot`. The PRoot launcher sets:

- `MOZ_FAKE_NO_SANDBOX=1`
- `MOZ_DISABLE_CONTENT_SANDBOX=1`
- `LIBGL_ALWAYS_SOFTWARE=1`
- `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`

The first two settings accommodate the restricted PRoot process environment. Software rendering avoids relying on host GPU integration. `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD` prevents ordinary MCP startup from performing network downloads or changing the browser cache.

These settings are not general recommendations for normal Debian or macOS installations.

## Legacy native-library bundle

The original working launcher added this directory to `LD_LIBRARY_PATH`:

```text
$HOME/.local/lib/camoufox-system/usr/lib/aarch64-linux-gnu
```

It contains files extracted from:

| Package | Tested package version |
|---|---|
| `libdbus-glib-1-2` | `0.114-1` |
| `libpci3` | `1:3.13.0-2` |
| `pci.ids` | `0.0~2025.06.09-1` |

Investigation showed that this bundle is not required by the tested Camoufox workflow:

- the browser launched without the directory in `LD_LIBRARY_PATH`;
- the Example Domain real-browser integration suite passed without it;
- dynamic-loader tracing did not show `libdbus-glib-1` or `libpci.so` being opened.

The reproducible baseline therefore does not download or extract those packages. The existing directory may remain as harmless legacy local state, but the launcher and doctor no longer depend on it.

## Planned and excluded platforms

Planned follow-up targets, each requiring independent clean-system validation:

- general Debian AArch64;
- Apple Silicon macOS.

Outside the current roadmap:

- Windows;
- Debian x86_64;
- Intel macOS;
- containers;
- other Linux distributions.

Upstream Camoufox may support more systems. That does not imply this local MCP setup has been validated on them.
