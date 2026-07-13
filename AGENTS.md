# Local Pi Workspace Rules

This repository wraps the upstream `pi-mono` source as a pinned Git submodule.

## Workspace Layout

- `pi-mono/` is an upstream Git submodule, pinned by the root repository. Keep it free of local build/dependency state and do not add it to a root npm workspace.
- `extensions/` contains locally-maintained Pi extensions (e.g. the cache-safe plan-mode fork), symlinked into `~/.pi/agent/extensions/`.
- `system-instruction/` contains the canonical `APPEND_SYSTEM.md` (symlinked from `~/.pi/agent/APPEND_SYSTEM.md`). Its machine-specific reference captures under `baseline/` are local and ignored. Do not create a project-level `.pi/APPEND_SYSTEM.md`, as it would shadow the global file.
- `scripts/` contains local build and maintenance scripts for this workspace.
- `references/` contains local independent repositories retained for comparison or tooling. It is ignored and is not part of the public repository.
- `build/pi-agent/runtime/` is the runnable local Pi artifact.
- `build/pi-agent/work/` is temporary build state and is deleted by default after a successful build.
- `build/pi-agent/artifacts/` contains local package tarballs used to assemble the runtime.
- `archive/` is for local logs, session exports, and other files that should not clutter the workspace root.

## Build Rules

- Do not run `npm install`, `npm ci`, package build scripts, or release scripts inside `pi-mono` unless the user explicitly asks for an upstream-repo operation.
- Build or refresh the local runnable Pi agent with `scripts/build-pi-agent.sh --link-user-bin` from this directory.
- Use `scripts/build-pi-agent.sh --keep-work` only when debugging the build workspace.
- The external build owns `node_modules`, generated package outputs, package tarballs, and runtime artifacts under `build/pi-agent/`.
- It is OK for `build/pi-agent/work/packages/*/src` to symlink back to `pi-mono/packages/*/src`; source is read from upstream, outputs are written outside upstream.

## User Pi Command

- The user `pi` command should resolve to `build/pi-agent/runtime/bin/pi` and ultimately to `build/pi-agent/runtime/node_modules/@earendil-works/pi-coding-agent/dist/cli.js`.
- `build/pi-agent/bin/pi` may exist as a compatibility shim to `runtime/bin/pi`.
- Before repointing symlinks or deleting build state, verify the external artifact with `pi --version` or `build/pi-agent/runtime/bin/pi --version`.
- After cleanup or relinking, verify `pi --version` again.

## Git Hygiene for pi-mono

- The root repository records only the upstream URL and a pinned `pi-mono` commit. It does not contain Pi source changes.
- We only care about the latest upstream `main`. Keep the checkout lean: no other remote-tracking branches, no tags, no unreachable objects.
- `remote.origin.fetch` must stay `+refs/heads/main:refs/remotes/origin/main` and `remote.origin.tagOpt` must stay `--no-tags`. Do not widen the refspec; if a fetch accidentally pulls in extra branches or tags, delete them and run `git gc --prune=now`.
- Update with `scripts/update-pi-mono.sh`. It fast-forwards the local `local-dev` branch, rebuilds the external runtime, and leaves the root submodule pointer modified for review. It never commits or pushes.
- Do not create packfiles unnecessarily (repeated fetches/gc): this PRoot environment emulates hardlinks with symlinks into `/.l2s`, and interrupted pack writes can corrupt the repo. If the repo corrupts, re-clone with `git clone --branch main --single-branch --no-tags` and recreate `local-dev`.

## Editing Upstream Code

- When modifying files under `pi-mono/`, follow `pi-mono/AGENTS.md`.
- Do not commit, reset, clean, or otherwise mutate `pi-mono` git state unless the user explicitly requests it.
