# pi-arcweld

A local workspace for a curated [Pi](https://github.com/earendil-works/pi) agent environment. It keeps the pinned upstream source, user-level extensions, system-instruction append file, and reproducible runtime tooling in one auditable repository.

Pi remains upstream. Local behavior and build state stay outside the `pi-mono/` checkout.

## Repository layout

- `pi-mono/` — pinned upstream Pi source managed as a Git submodule.
- [`extensions/`](extensions/README.md) — curated user-level Pi extensions and package-backed extensions.
- [`system-instruction/`](system-instruction/README.md) — the global `APPEND_SYSTEM.md` source and capture notes.
- `scripts/` — local runtime build and upstream-update scripts.
- `docs/` — the static GitHub Pages site.
- `build/` — generated local runtime and package artifacts; intentionally untracked.

## User-level integration

The active Pi configuration points back to this repository rather than copying curated files:

- `~/.pi/agent/extensions/plan-mode` → `extensions/plan-mode/`
- `~/.pi/agent/extensions/questionnaire.ts` → `extensions/questionnaire.ts`
- `~/.pi/agent/APPEND_SYSTEM.md` → `system-instruction/APPEND_SYSTEM.md`
- `~/.pi/agent/settings.json` registers `extensions/mcp-extension/` as a local-path package
- the user `pi` command resolves to `build/pi-agent/runtime/bin/pi`

Machine-local settings, credentials, and unrelated user extensions are not stored in this repository.

## Getting started

Clone the repository with its upstream submodule:

```bash
git clone --recurse-submodules https://github.com/appautomaton/pi-arcweld.git pi-arcweld
cd pi-arcweld
```

Build and link the local Pi runtime without writing build output into `pi-mono/`:

```bash
scripts/build-pi-agent.sh --link-user-bin
pi --version
```

See [`extensions/README.md`](extensions/README.md) for extension loading and validation. Run the repository and machine-specific checks with:

```bash
scripts/check-workspace.sh
scripts/check-user-wiring.sh
```

## Updating Pi

Use the update helper to fast-forward the local `pi-mono` checkout to upstream `main` and rebuild the runtime:

```bash
scripts/update-pi-mono.sh
git diff --submodule=log -- pi-mono
```

The helper does not commit or push. Review the resulting submodule pointer before committing it in this repository.

## Development model

The repository intentionally has no root `package.json` or shared npm workspace. Each local package owns its manifest, lockfile, dependencies, and checks. Upstream Pi retains its own build and release process.

The root repository records the upstream URL and pinned Pi commit, not local Pi source changes. See [`AGENTS.md`](AGENTS.md) for workspace, build, and Git hygiene rules.
