# Runtime support

This document is the single source of truth for the support boundary: which systems are verified, pending revalidation, planned, or out of scope. The per-profile manifests under `config/` record configured pins, artifact hashes, and verification status; when support changes, update this document and the affected manifest together.

## Runtime profiles

This local server has two profiled environments. Both pin the same Camoufox release and the same launcher. The macOS profile was reverified against those pins on 2026-10-15; the PRoot profile still awaits its own run. Profile selection is centralized in `scripts/runtime-profile.js`, which the installer and doctor share.

### PRoot ARM64 (`proot-arm64`)

**Status: pending revalidation.** The previous verification, on 2026-08-13, covered `152.0.4-beta.28` with `camoufox-js` 0.12.0 and `playwright-core` 1.60.0. It does not cover the pins below. The launcher precondition that this revision establishes — `application.ini` beside the executable — is satisfied by the installer on this profile too, but no run has confirmed it here.

| Component | Pinned value |
|---|---|
| Environment | Debian GNU/Linux 13 (trixie) under PRoot |
| Architecture | AArch64 (`aarch64`) |
| Node | 24.13.0 |
| npm | 11.17.0 |
| Camoufox | 156.0.1-beta.36 Linux ARM64 |
| `camoufox` | 0.5.8 |
| `playwright-core` | 1.62.0 |

The machine-readable baseline is `config/proot-arm64-runtime.json`.

### Apple Silicon macOS (`darwin-arm64`)

**Status: verified.** Revalidated on 2026-10-15 against the pins below by the deployment gates in `scripts/deploy-local.js` — doctor, the unit suite, and the three browser integration tests that launch the pinned browser and browse a real page — followed by a deployment that Pi loads.

| Component | Configured value |
|---|---|
| Environment | macOS on Apple Silicon (Darwin 25) |
| Architecture | `arm64` |
| Node | 24.14.0 |
| npm | 11.17.0 |
| Camoufox | 156.0.1-beta.36 macOS ARM64 |
| `camoufox` | 0.5.8 |
| `playwright-core` | 1.62.0 |

The machine-readable baseline is `config/darwin-arm64-runtime.json`.

## Artifact split

The working installation is deliberately split into five parts:

1. Canonical project source, lockfile, bootstraps, tests, and documentation in this directory.
2. Source-checkout dependencies restored into `node_modules/` with `npm ci` for development and validation.
3. Separate tested MCP releases under `$HOME/.local/mcps/camoufox/releases/`, with a `current` symbolic link that activates exactly one of them. Each release owns the dependencies installed from the lockfile and is treated as read-only operational state after deployment; the release a deploy replaces is deleted.
4. The pinned Camoufox browser installed separately into `$HOME/.local/camoufox`.
5. Pi's external MCP registration, which points to `$HOME/.local/mcps/camoufox/current/bin/camoufox-mcp` and passes the browser through `--executable-path`.

Deploy with `npm run deploy:local`; inspect the active release with `npm run deploy:status`. A source edit does not affect Pi until a tested deployment succeeds and Pi reconnects to the MCP server.

The browser binary, npm dependency trees, deployed releases, and user configuration are runtime state and must not be committed to Git. Nothing is installed system-wide and no system package manager is involved. For repeatable or offline browser installs, `CAMOUFOX_ARCHIVE=/path/to/the-exact-pinned.zip` may be supplied to the installer; the same recorded byte size and SHA-256 checks still apply.

## Browser install directory

The `camoufox` launcher reads the Firefox version from `application.ini` next to the executable given as `executable_path`. It does not consult `CAMOUFOX_INSTALL_DIR`. Linux tarballs keep that file beside the executable already; the macOS bundle holds it under `Contents/Resources/`, so `scripts/install-camoufox-browser.js` stamps a copy beside the binary and `scripts/doctor.js` asserts both its presence and its version. This project still installs the browser under `$HOME/.local/camoufox` and passes that executable on the command line, so the launcher's own cache directory is not the browser install.

## `playwright-core` upper bound

`camoufox` 0.5.8 declares `playwright-core: <1.63` as a peer dependency and tests against 1.62.0. Camoufox is a Firefox fork tied to a specific Playwright/Juggler protocol generation, so a newer `playwright-core` is not the correct choice. Pin 1.62.0, and recheck the peer range whenever `camoufox` is upgraded. `camoufox` 0.5.8 records browser pin `v156.0.1-beta.36`; both profiles use that release. Apify `camoufox-js` capped Firefox 156 and is no longer used.

## PRoot-specific behavior

`bin/camoufox-mcp` detects PRoot and delegates to `bin/camoufox-mcp-proot`. The PRoot launcher sets:

- `MOZ_FAKE_NO_SANDBOX=1`
- `MOZ_DISABLE_CONTENT_SANDBOX=1`
- `LIBGL_ALWAYS_SOFTWARE=1`
- `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`

The first two settings accommodate the restricted PRoot process environment. Software rendering avoids relying on host GPU integration. `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD` prevents dependency helpers from downloading browser, default-addon, or GeoIP artifacts during ordinary MCP startup; this project provisions the browser separately and launches with GeoIP and the default addon disabled.

These settings are not general recommendations for normal Debian or macOS installations.

## macOS-specific behavior

macOS uses the generic launcher path in `bin/camoufox-mcp`. It sets only `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`; it does not apply the PRoot sandbox or software-rendering overrides. In particular:

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
