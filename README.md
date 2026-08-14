<div align="center">

<img src="docs/arcweld-mark.svg" width="96" alt="pi-arcweld logo: a Pi symbol whose crossbar is a titanium weld bead">

# pi-arcweld

**Don't fork it. Weld it.**

An auditable local workspace for the [Pi](https://pi.dev) coding agent:<br>
pinned upstream source, curated extensions, bounded MCP tooling, and a reproducible runtime.

<a href="https://appautomaton.renocrypt.com/pi-arcweld/"><img alt="pi arcweld project site" src="https://img.shields.io/badge/site-pi--arcweld-1d5bd6"></a>
<a href="https://appautomaton.renocrypt.com/"><img alt="appautomaton" src="https://img.shields.io/badge/by-appautomaton-e2894f"></a>
<a href="https://github.com/appautomaton"><img alt="App Automaton on GitHub" src="https://img.shields.io/badge/github-App_Automaton-0f1621?logo=github"></a>
<a href="LICENSE"><img alt="pi-arcweld is MIT licensed" src="https://img.shields.io/badge/license-MIT-b76bd6"></a>
<a href="https://github.com/earendil-works/pi"><img alt="tracks upstream Pi at earendil-works/pi" src="https://img.shields.io/badge/pi-upstream-7b7df2"></a>
<a href="https://github.com/appautomaton/pi-arcweld/actions/workflows/deploy-pages.yml"><img alt="Deploy landing page to GitHub Pages" src="https://github.com/appautomaton/pi-arcweld/actions/workflows/deploy-pages.yml/badge.svg"></a>

</div>

## What is pi-arcweld?

> **pi-arcweld** is an auditable local workspace for the [Pi coding agent](https://github.com/earendil-works/pi). It welds a curated local layer of user extensions, global system guidance, bounded MCP tooling, and a reproducible runtime onto pinned upstream Pi source, along one visible seam. Pi Arcweld is not a fork: upstream stays upstream, and the workspace stays yours.

## Why weld instead of fork?

- **Pinned upstream, no drift.** `pi-mono/` is a submodule locked to a known commit; moving to a newer Pi is an explicit, reviewable fast-forward.
- **One visible seam.** Every local behavior, from extensions and MCP wiring to system guidance, is a plain file in this repository, so changes surface in `git diff`, not in hidden machine state.
- **Reproducible runtime.** `scripts/build-pi-agent.sh` assembles and verifies the runnable Pi agent outside the upstream tree; `pi-mono/` never accumulates build state.
- **Bounded tooling, guarded secrets.** MCP servers run as separate stdio processes, and `scripts/check-secret-boundary.sh` fails any commit that would leak credentials into the repository.

## Curated components

- **[External runtime builder](scripts/build-pi-agent.sh):** assembles and verifies Pi without writing build state into upstream source.
- **[Cache-safe plan mode](extensions/plan-mode/):** appends plan state while preserving the provider prompt-cache prefix.
- **[MCP client](extensions/mcp-extension/):** discovers configured servers behind a fixed, bounded model-facing tool surface.
- **[Questionnaire](extensions/questionnaire.ts):** presents explicit, keyboard-operable clarification flows.
- **[System-instruction append](system-instruction/APPEND_SYSTEM.md):** refines response behavior without replacing Pi's generated system prompt.

## Repository layout

| Path | Contents |
|---|---|
| `pi-mono/` | Pinned upstream Pi source, managed as a Git submodule and kept clean of local build state |
| [`extensions/`](extensions/README.md) | Curated user-level Pi extensions and package-backed extensions |
| [`mcp-servers/`](mcp-servers/README.md) | Canonical source for local MCP servers, deployed as tested versioned releases under `~/.local/mcps/` |
| [`system-instruction/`](system-instruction/README.md) | The global `APPEND_SYSTEM.md` source and capture notes |
| `scripts/` | Runtime build, upstream-update, and validation scripts |
| [`docs/`](docs/index.html) | The pi arcweld landing page, `llms.txt`, and sitemap served by GitHub Pages |
| `build/` | Generated local runtime and package artifacts, intentionally untracked |

## Quickstart

Clone the repository with its pinned upstream submodule:

```bash
git clone --recurse-submodules https://github.com/appautomaton/pi-arcweld.git pi-arcweld
cd pi-arcweld
```

Build and link the local Pi runtime without writing build output into `pi-mono/`:

```bash
scripts/build-pi-agent.sh --link-user-bin
pi --version
```

The build prefers the repository's pinned native `tsgo` compiler when it is runnable and otherwise falls back to the pinned `tsc` compiler, targeting ES2024 because the TUI source uses the RegExp `v` flag. Compiler selection is capability-based and requires no platform-specific source branches.

Validate the repository and machine wiring:

```bash
scripts/check-workspace.sh
scripts/check-user-wiring.sh
```

## Updating Pi

Fast-forward the local `pi-mono` checkout to upstream `main` and rebuild the runtime:

```bash
scripts/update-pi-mono.sh
git diff --submodule=log -- pi-mono
```

The helper never commits or pushes. Review the resulting submodule pointer before committing it in this repository.

## User-level integration

The active Pi configuration uses explicit user-level wiring: extensions point to canonical repository source, while the Camoufox MCP runs from a tested local deployment:

- `~/.pi/agent/extensions/plan-mode` → `extensions/plan-mode/`
- `~/.pi/agent/extensions/questionnaire.ts` → `extensions/questionnaire.ts`
- `~/.pi/agent/extensions/exa-search.ts` → `extensions/exa-search.ts`
- `~/.pi/agent/extensions/codex-web-search.ts` → `extensions/codex-web-search.ts`
- `~/.pi/agent/extensions/claude-web-search` → `extensions/claude-web-search/`
- `~/.pi/agent/extensions/grok-search.ts` → `extensions/grok-search.ts`
- `~/.pi/agent/APPEND_SYSTEM.md` → `system-instruction/APPEND_SYSTEM.md`
- `~/.pi/agent/settings.json` registers `extensions/mcp-extension/` as a local-path package
- `~/.pi/agent/mcp.json` runs the deployed Camoufox MCP at `~/.local/mcps/camoufox/current/bin/camoufox-mcp`
- the user `pi` command resolves to `build/pi-agent/runtime/bin/pi`

### Secret boundary

Machine-local settings, credentials, and unrelated user extensions are not stored in this repository. The Exa API key stays only in `~/.pi/agent/exa-search.json`, and Grok provider credentials stay in Pi's machine-local model/auth configuration. `scripts/check-secret-boundary.sh` fails if commit candidates include Pi credential or config files, obvious literal secrets, or an exact credential value discoverable from the active machine-local Pi configuration.

## Development model

The repository intentionally has no root `package.json` or shared npm workspace. Each local package owns its manifest, lockfile, dependencies, and checks, and upstream Pi retains its own build and release process. The root repository records the upstream URL and pinned Pi commit, not local Pi source changes. See [`AGENTS.md`](AGENTS.md) for workspace, build, and Git hygiene rules.

## Links

- **Project site:** [appautomaton.renocrypt.com/pi-arcweld](https://appautomaton.renocrypt.com/pi-arcweld/)
- **Repository:** [github.com/appautomaton/pi-arcweld](https://github.com/appautomaton/pi-arcweld)
- **Upstream Pi:** [pi.dev](https://pi.dev) · [github.com/earendil-works/pi](https://github.com/earendil-works/pi)
- **Maintainer:** [App Automaton](https://github.com/appautomaton) · [appautomaton.renocrypt.com](https://appautomaton.renocrypt.com/)

---

<p align="center"><sub>
Pi Arcweld is maintained by <a href="https://github.com/appautomaton">App Automaton</a>.
The Pi coding agent is developed upstream by <a href="https://github.com/earendil-works">earendil-works</a>.
</sub></p>
