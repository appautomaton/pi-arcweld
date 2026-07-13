#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MONO_DIR="$ROOT_DIR/pi-mono"
UPSTREAM_URL="https://github.com/earendil-works/pi.git"

fail() {
	echo "Error: $*" >&2
	exit 1
}

if ! git -C "$MONO_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
	fail "Missing pi-mono submodule at $MONO_DIR. Run: git submodule update --init pi-mono"
fi

if [[ "$(git -C "$MONO_DIR" remote get-url origin)" != "$UPSTREAM_URL" ]]; then
	fail "pi-mono origin is not $UPSTREAM_URL"
fi

if [[ -n "$(git -C "$MONO_DIR" status --porcelain)" ]]; then
	fail "pi-mono has local changes; refusing to update upstream source"
fi

current_head="$(git -C "$MONO_DIR" rev-parse HEAD)"
current_branch="$(git -C "$MONO_DIR" symbolic-ref --quiet --short HEAD || true)"

if [[ "$current_branch" != "local-dev" ]]; then
	if git -C "$MONO_DIR" show-ref --verify --quiet refs/heads/local-dev; then
		if [[ "$(git -C "$MONO_DIR" rev-parse local-dev)" != "$current_head" ]]; then
			fail "pi-mono is detached from local-dev; resolve the submodule state before updating"
		fi
		git -C "$MONO_DIR" switch local-dev
	else
		git -C "$MONO_DIR" switch -c local-dev "$current_head"
	fi
fi

git -C "$MONO_DIR" config --replace-all remote.origin.fetch "+refs/heads/main:refs/remotes/origin/main"
git -C "$MONO_DIR" config --replace-all remote.origin.tagOpt "--no-tags"
git -C "$MONO_DIR" fetch origin
git -C "$MONO_DIR" merge --ff-only origin/main

"$ROOT_DIR/scripts/build-pi-agent.sh" --link-user-bin

echo "==> pi-mono updated to $(git -C "$MONO_DIR" rev-parse --short HEAD)"
echo "==> Review the root gitlink with: git diff --submodule=log -- pi-mono"
echo "==> Commit the root pointer only when you are ready."
