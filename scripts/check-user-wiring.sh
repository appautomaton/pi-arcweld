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

check_absent() {
	local path="$1"
	if [[ -e "$path" || -L "$path" ]]; then
		echo "Obsolete user-level path still exists: $path" >&2
		exit 1
	fi
}

echo "==> Checking user-level symlinks"
check_link "$AGENT_DIR/extensions/plan-mode" "$ROOT_DIR/extensions/plan-mode"
check_link "$AGENT_DIR/extensions/pi-arcweld-todos" "$ROOT_DIR/extensions/pi-arcweld-todos"
check_link "$AGENT_DIR/extensions/questionnaire.ts" "$ROOT_DIR/extensions/questionnaire.ts"
check_link "$AGENT_DIR/extensions/exa-search.ts" "$ROOT_DIR/extensions/exa-search.ts"
check_link "$AGENT_DIR/extensions/codex-web-search.ts" "$ROOT_DIR/extensions/codex-web-search.ts"
check_link "$AGENT_DIR/extensions/claude-web-search" "$ROOT_DIR/extensions/claude-web-search"
check_absent "$AGENT_DIR/extensions/claude-web-search.ts"
check_absent "$AGENT_DIR/extensions/native-web-search.ts"
check_absent "$AGENT_DIR/extensions/web-search.ts"
check_link "$AGENT_DIR/extensions/grok-search.ts" "$ROOT_DIR/extensions/grok-search.ts"
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

echo "==> Checking deployed Camoufox MCP registration"
camoufox_deploy="$HOME/.local/mcps/camoufox"
camoufox_launcher="$camoufox_deploy/current/bin/camoufox-mcp"
case "$(uname -s)" in
	Darwin) camoufox_browser="$HOME/.local/camoufox/Camoufox.app/Contents/MacOS/camoufox" ;;
	*) camoufox_browser="$HOME/.local/camoufox/camoufox-bin" ;;
esac
if [[ ! -L "$camoufox_deploy/current" ]]; then
	echo "Expected deployed Camoufox current symlink: $camoufox_deploy/current" >&2
	exit 1
fi
if [[ ! -x "$camoufox_launcher" ]]; then
	echo "Expected executable deployed Camoufox launcher: $camoufox_launcher" >&2
	exit 1
fi
node - "$AGENT_DIR/mcp.json" "$camoufox_launcher" "$camoufox_browser" <<'NODE'
const { readFileSync } = require("node:fs");
const [configPath, expectedCommand, expectedBrowser] = process.argv.slice(2);
const config = JSON.parse(readFileSync(configPath, "utf8"));
const server = config.servers?.camoufox;
if (!server) throw new Error("Missing servers.camoufox registration");
if (server.transport !== "stdio") throw new Error(`Unexpected Camoufox transport: ${server.transport}`);
if (server.command !== expectedCommand) {
	throw new Error(`Unexpected Camoufox command; expected ${expectedCommand}, found ${server.command}`);
}
const args = Array.isArray(server.args) ? server.args : [];
const executableIndex = args.indexOf("--executable-path");
if (executableIndex < 0 || args[executableIndex + 1] !== expectedBrowser) {
	throw new Error(`Camoufox browser path must be ${expectedBrowser}`);
}
if (server.enabled === false) throw new Error("Camoufox MCP is disabled");
NODE

(
	cd "$camoufox_deploy/current"
	npm run doctor
)

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
