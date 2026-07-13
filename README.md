# pi-arcweld

A local-first workshop for shaping [Pi](https://github.com/earendil-works/pi): extensions, MCP tooling, system-instruction material, and a reproducible local runtime.

Pi itself remains upstream. This repository pins the upstream source as a Git submodule and keeps local customizations separate.

## Layout

- `pi-mono/` — pinned upstream Pi source; never a local fork.
- `extensions/` — locally maintained Pi extensions.
- `mcp-extension/` — the local MCP client Pi package.
- `system-instruction/` — the canonical global system-prompt append material.
- `scripts/` — runtime build and upstream-maintenance tools.
- `build/` — generated local runtime; intentionally untracked.

## Getting started

Clone with the upstream source:

```bash
git clone --recurse-submodules https://github.com/appautomaton/pi-arcweld.git pi-arcweld
cd pi-arcweld
```

Build the local Pi runtime outside the upstream checkout:

```bash
scripts/build-pi-agent.sh --link-user-bin
pi --version
```

## Updating Pi

Use the update helper to fast-forward the local `pi-mono` checkout to upstream `main` and rebuild the runtime:

```bash
scripts/update-pi-mono.sh
git diff --submodule=log -- pi-mono
```

The helper never commits or pushes. Review the resulting submodule pointer before committing it in this repository.

## Development model

`pi-arcweld` intentionally has no root `package.json` or shared npm workspace. Local packages manage their own dependencies; the upstream Pi source retains its own build and release process.

The root repository tracks only the upstream URL and pinned Pi commit, not Pi source changes. See [AGENTS.md](AGENTS.md) for workspace and Git hygiene rules.
