#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXT_DIR="$ROOT_DIR/extensions/mcp-extension"
MODE="${1:-all}"
RUNTIME_MODULES="${PI_ARCWELD_RUNTIME_NODE_MODULES:-$ROOT_DIR/build/pi-agent/runtime/node_modules}"

if [[ ! -d "$RUNTIME_MODULES/@earendil-works/pi-coding-agent" ]]; then
	pi_bin="$(command -v pi || true)"
	if [[ -n "$pi_bin" ]]; then
		resolved_pi="$(readlink -f "$pi_bin")"
		case "$resolved_pi" in
			*/node_modules/@earendil-works/pi-coding-agent/*)
				candidate="${resolved_pi%%/node_modules/@earendil-works/pi-coding-agent/*}/node_modules"
				if [[ -d "$candidate/@earendil-works/pi-coding-agent" ]]; then
					RUNTIME_MODULES="$candidate"
				fi
				;;
		esac
	fi
fi

if [[ ! -d "$RUNTIME_MODULES/@earendil-works/pi-ai" || ! -d "$RUNTIME_MODULES/@earendil-works/pi-coding-agent" || ! -d "$RUNTIME_MODULES/@earendil-works/pi-tui" || ! -d "$RUNTIME_MODULES/typebox" ]]; then
	echo "MCP extension checks require the active Pi runtime packages" >&2
	exit 1
fi
if [[ ! -x "$EXT_DIR/node_modules/.bin/tsc" || ! -f "$EXT_DIR/node_modules/tsx/dist/loader.mjs" || ! -d "$EXT_DIR/node_modules/@modelcontextprotocol/sdk" || ! -d "$EXT_DIR/node_modules/zod" ]]; then
	echo "Run npm ci --ignore-scripts in extensions/mcp-extension first" >&2
	exit 1
fi

created_links=()
cleanup() {
	for ((index=${#created_links[@]} - 1; index >= 0; index--)); do
		rm -f "${created_links[index]}"
	done
	rmdir "$EXT_DIR/node_modules/@earendil-works" 2>/dev/null || true
}
trap cleanup EXIT

link_peer() {
	local relative="$1"
	local source="$RUNTIME_MODULES/$relative"
	local target="$EXT_DIR/node_modules/$relative"
	mkdir -p "$(dirname "$target")"
	if [[ -e "$target" || -L "$target" ]]; then
		if [[ ! -L "$target" || "$(readlink -f "$target")" != "$(readlink -f "$source")" ]]; then
			echo "$target exists and is not the active Pi runtime peer" >&2
			exit 1
		fi
		return
	fi
	ln -s "$source" "$target"
	created_links+=("$target")
}

link_peer "@earendil-works/pi-ai"
link_peer "@earendil-works/pi-coding-agent"
link_peer "@earendil-works/pi-tui"
link_peer "typebox"

check_host_boundary() {
	if grep -Eq 'node_modules/@earendil-works|node_modules/typebox' "$EXT_DIR/package-lock.json"; then
		echo "Pi host packages must not be installed or versioned in the MCP lockfile" >&2
		exit 1
	fi
	node -e '
		const manifest = require(process.argv[1]);
		const forbidden = ["@earendil-works/pi-ai", "@earendil-works/pi-coding-agent", "@earendil-works/pi-tui", "typebox"];
		for (const name of forbidden) {
			if (manifest.devDependencies?.[name] !== undefined || manifest.dependencies?.[name] !== undefined) {
				throw new Error(`${name} must remain a host-provided peer`);
			}
			if (manifest.peerDependencies?.[name] !== "*" || manifest.peerDependenciesMeta?.[name]?.optional !== true) {
				throw new Error(`${name} must be an optional wildcard peer`);
			}
		}
	' "$EXT_DIR/package.json"
}

run_check() {
	check_host_boundary
	"$EXT_DIR/node_modules/.bin/tsc" -p "$EXT_DIR/tsconfig.json" --noEmit
}

run_test() {
	check_host_boundary
	node --import "$EXT_DIR/node_modules/tsx/dist/loader.mjs" --test "$EXT_DIR"/test/*.test.ts
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
