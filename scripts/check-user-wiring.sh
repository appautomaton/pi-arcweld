#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"

check_link() {
	local link_path="$1"
	local expected_target="$2"
	local actual_target

	if [[ ! -L "$link_path" ]]; then
		echo "Expected symlink: $link_path" >&2
		exit 1
	fi
	actual_target="$(readlink -f "$link_path")"
	if [[ "$actual_target" != "$expected_target" ]]; then
		echo "Unexpected target for $link_path" >&2
		echo "  expected: $expected_target" >&2
		echo "  actual:   $actual_target" >&2
		exit 1
	fi
}

echo "==> Checking user-level symlinks"
check_link "$AGENT_DIR/extensions/plan-mode" "$ROOT_DIR/extensions/plan-mode"
check_link "$AGENT_DIR/extensions/questionnaire.ts" "$ROOT_DIR/extensions/questionnaire.ts"
check_link "$AGENT_DIR/APPEND_SYSTEM.md" "$ROOT_DIR/system-instruction/APPEND_SYSTEM.md"

echo "==> Checking MCP package registration"
node - "$AGENT_DIR/settings.json" "$ROOT_DIR/extensions/mcp-extension" <<'NODE'
const { readFileSync } = require("node:fs");
const { dirname, resolve } = require("node:path");
const [settingsPath, expectedPath] = process.argv.slice(2);
const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
const packages = (settings.packages ?? [])
	.filter((entry) => typeof entry === "string")
	.map((entry) => resolve(dirname(settingsPath), entry));
if (!packages.includes(expectedPath)) {
	throw new Error(`Missing local MCP package registration for ${expectedPath}`);
}
NODE

echo "==> Checking Pi command"
expected_pi="$ROOT_DIR/build/pi-agent/runtime/node_modules/@earendil-works/pi-coding-agent/dist/cli.js"
actual_pi="$(readlink -f "$(command -v pi)")"
if [[ "$actual_pi" != "$expected_pi" ]]; then
	echo "Unexpected pi command target" >&2
	echo "  expected: $expected_pi" >&2
	echo "  actual:   $actual_pi" >&2
	exit 1
fi
pi --version
pi list

echo "==> Loading the real user-level Pi configuration"
pi --list-models >/dev/null

echo "==> User-level wiring is consistent"
