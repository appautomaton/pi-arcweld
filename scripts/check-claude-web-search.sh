#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXT_DIR="$ROOT_DIR/extensions/claude-web-search"
RUNTIME_MODULES="$ROOT_DIR/build/pi-agent/runtime/node_modules"
TOOLCHAIN_MODULES="$ROOT_DIR/extensions/mcp-extension/node_modules"
MODE="${1:-all}"

if [[ ! -d "$RUNTIME_MODULES/@earendil-works/pi-ai" || ! -d "$RUNTIME_MODULES/@earendil-works/pi-coding-agent" ]]; then
	echo "Claude web-search check requires the built Pi runtime" >&2
	exit 1
fi
if [[ ! -x "$TOOLCHAIN_MODULES/.bin/tsc" || ! -f "$TOOLCHAIN_MODULES/tsx/dist/loader.mjs" ]]; then
	echo "Claude web-search check requires the shared workspace TypeScript/TSX toolchain" >&2
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
	*)
		echo "Usage: $0 [check|test|all]" >&2
		exit 2
		;;
esac
