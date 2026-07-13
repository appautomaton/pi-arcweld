# Runtime support

This document is the single source of truth for the support boundary: which systems are verified, which are planned, and which are out of scope. The per-profile manifests under `config/` record only verified pins and hashes; when support changes, update this document and the affected manifest together.

## Verified profiles

This local server is currently supported and verified in two environments. Profile selection is centralized in `scripts/runtime-profile.js`, which the installer and doctor share.

### PRoot ARM64 (`proot-arm64`)

**Status: pending revalidation.** The pins were advanced to Camoufox 150.0.2-beta.25 and `camoufox-js` 0.11.1 on 2026-07-13 (verified on darwin-arm64). On the PRoot machine, run `npm run bootstrap:proot-arm64`, `npm test`, and `npm run test:integration`, then set the manifest's `support.status` back to `verified`. The last fully verified pair on PRoot was Camoufox 135.0.1-beta.24 with `camoufox-js` 0.10.2.

| Component | Pinned value |
|---|---|
| Environment | Debian GNU/Linux 13 (trixie) under PRoot |
| Architecture | AArch64 (`aarch64`) |
| Node | 24.13.0 |
| npm | 11.17.0 |
| Camoufox | 150.0.2-beta.25 Linux ARM64 |
| `camoufox-js` | 0.11.1 |
| `playwright-core` | 1.59.0 |

The machine-readable baseline is `config/proot-arm64-runtime.json`.

### Apple Silicon macOS (`darwin-arm64`)

| Component | Verified value |
|---|---|
| Environment | macOS on Apple Silicon (Darwin 25) |
| Architecture | `arm64` |
| Node | 24.14.0 |
| npm | 11.17.0 |
| Camoufox | 150.0.2-beta.25 macOS ARM64 |
| `camoufox-js` | 0.11.1 |
| `playwright-core` | 1.59.0 |

The machine-readable baseline is `config/darwin-arm64-runtime.json`.

Note on upstream naming: the `v150.0.2-beta.25` GitHub release publishes asset files named `camoufox-150.0.2-alpha.25-*`. The manifests record the actual download filenames; the `release` field follows the release tag.

## Artifact split

The working installation is deliberately split into four parts:

1. Project source, lockfile, bootstraps, tests, and documentation in this directory.
2. npm dependencies restored into `node_modules/` with `npm ci` (install scripts enabled, so `better-sqlite3` obtains its native binding).
3. The pinned Camoufox browser installed into the platform browser cache: `$HOME/.cache/camoufox` on Linux, `$HOME/Library/Caches/camoufox` on macOS. These directories mirror `camoufox-js`'s own cache resolution, so the launcher finds the browser without any extra configuration.
4. Pi's external MCP registration, which points to this checkout's `bin/camoufox-mcp`.

The browser binary, npm dependency tree, and user configuration are runtime state and must not be committed to Git. Nothing is installed system-wide and no system package manager is involved: the browser, its bundled libraries, and its profile state live entirely in the user cache. For repeatable/offline installs, `CAMOUFOX_ARCHIVE=/path/to/the-pinned.zip` may be supplied to the installer; the same size and SHA-256 checks still apply.

## PRoot-specific behavior

`bin/camoufox-mcp` detects PRoot and delegates to `bin/camoufox-mcp-proot`. The PRoot launcher sets:

- `MOZ_FAKE_NO_SANDBOX=1`
- `MOZ_DISABLE_CONTENT_SANDBOX=1`
- `LIBGL_ALWAYS_SOFTWARE=1`
- `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`

The first two settings accommodate the restricted PRoot process environment. Software rendering avoids relying on host GPU integration. `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD` prevents ordinary MCP startup from performing network downloads or changing the browser cache.

These settings are not general recommendations for normal Debian or macOS installations.

## macOS-specific behavior

macOS uses the generic launcher path in `bin/camoufox-mcp` with no environment overrides. In particular:

- Firefox's native content-process sandbox stays fully enabled. The Mozilla sandbox relaxations required under PRoot are neither needed nor applied.
- The browser runs plain headless (`headless: true`); no Xvfb or virtual display is involved.
- The archive ships a standard `Camoufox.app` bundle. The pinned executable is `Camoufox.app/Contents/MacOS/camoufox` inside the cache directory, and `version.json` sits at the cache root exactly as on Linux.
- Fingerprint generation uses `os: ["macos"]` so generated fingerprints match the real platform (`src/browser.js`).

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

- general Debian AArch64.

Outside the current roadmap:

- Windows;
- Debian x86_64;
- Intel macOS;
- containers;
- other Linux distributions.

Upstream Camoufox may support more systems. That does not imply this local MCP setup has been validated on them.
