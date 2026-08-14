#!/usr/bin/env bash
set -euo pipefail

# Type-checks and tests a source-only extension package against the live Pi
# runtime instead of npm-installed Pi packages. This keeps the package pinned to
# whatever build/pi-agent/runtime currently provides, so an upstream pi-mono
# update is validated immediately and no per-package version pin can go stale.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PACKAGE="${1:-}"
MODE="${2:-all}"

usage() {
	echo "Usage: $0 <extension-package> [check|test|all]" >&2
	exit 2
}

[[ -n "$PACKAGE" ]] || usage

EXT_DIR="$ROOT_DIR/extensions/$PACKAGE"
RUNTIME_MODULES="${PI_ARCWELD_RUNTIME_NODE_MODULES:-$ROOT_DIR/build/pi-agent/runtime/node_modules}"
TOOLCHAIN_MODULES="$ROOT_DIR/extensions/mcp-extension/node_modules"

if [[ ! -d "$EXT_DIR" ]]; then
	echo "Unknown extension package: $EXT_DIR" >&2
	exit 2
fi
if [[ ! -d "$RUNTIME_MODULES/@earendil-works/pi-coding-agent" ]]; then
	echo "$PACKAGE checks require the built Pi runtime at $RUNTIME_MODULES" >&2
	echo "Build it first with scripts/build-pi-agent.sh --link-user-bin" >&2
	exit 1
fi
if [[ ! -x "$TOOLCHAIN_MODULES/.bin/tsc" || ! -f "$TOOLCHAIN_MODULES/tsx/dist/loader.mjs" ]]; then
	echo "$PACKAGE checks require the shared workspace TypeScript/TSX toolchain" >&2
	echo "Run npm ci --ignore-scripts in extensions/mcp-extension first" >&2
	exit 1
fi

created_link=0
cleanup() {
	if [[ "$created_link" == 1 ]]; then
		rm -f "$EXT_DIR/node_modules"
	fi
}
trap cleanup EXIT

if [[ -e "$EXT_DIR/node_modules" || -L "$EXT_DIR/node_modules" ]]; then
	if [[ "$(readlink -f "$EXT_DIR/node_modules")" != "$(readlink -f "$RUNTIME_MODULES")" ]]; then
		echo "$EXT_DIR/node_modules already exists and is not the host-runtime link" >&2
		exit 1
	fi
else
	ln -s "$RUNTIME_MODULES" "$EXT_DIR/node_modules"
	created_link=1
fi

run_check() {
	"$TOOLCHAIN_MODULES/.bin/tsc" -p "$EXT_DIR/tsconfig.json" --noEmit
}

run_test() {
	node --import "$TOOLCHAIN_MODULES/tsx/dist/loader.mjs" --test "$EXT_DIR"/test/*.test.ts
}

case "$MODE" in
	check) run_check ;;
	test) run_test ;;
	all)
		run_check
		run_test
		;;
	*) usage ;;
esac
