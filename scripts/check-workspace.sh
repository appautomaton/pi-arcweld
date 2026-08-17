#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

tmp_dir="$(mktemp -d)"
agent_dir="$(mktemp -d)"
cleanup() {
	rm -rf "$tmp_dir" "$agent_dir"
}
trap cleanup EXIT

echo "==> [1/3] Checking static syntax, secrets, manifests, and rules"
bash -n scripts/*.sh
scripts/check-secret-boundary.sh

if stale_references="$(git grep -n -E 'pi-mcp-client-local|/home/dev|href="#workshop"|id="workshop"' -- ':!pi-mono' ':!scripts/check-workspace.sh')"; then
	printf '%s\n' "$stale_references" >&2
	echo "Stale repository references found" >&2
	exit 1
fi

node <<'NODE'
const { readFileSync } = require("node:fs");
for (const path of [
	"extensions/mcp-extension/package.json",
	"extensions/mcp-extension/tsconfig.json",
	"extensions/claude-web-search/package.json",
	"extensions/claude-web-search/tsconfig.json",
	"extensions/plan-mode/package.json",
	"extensions/plan-mode/tsconfig.json",
	"extensions/pi-arcweld-todos/package.json",
	"extensions/pi-arcweld-todos/tsconfig.json",
	"mcp-servers/camoufox/package.json",
	"mcp-servers/camoufox/config/proot-arm64-runtime.json",
	"mcp-servers/camoufox/config/darwin-arm64-runtime.json",
]) {
	JSON.parse(readFileSync(path, "utf8"));
}

// Pi host packages are supplied by the locally built runtime under
// build/pi-agent/runtime, not by npm. A pinned version would resolve a
// different artifact than the one actually loaded, and would silently go stale
// on every pi-mono update, so they must stay wildcard peer dependencies.
const HOST_PACKAGES = [
	"@earendil-works/pi-agent-core",
	"@earendil-works/pi-ai",
	"@earendil-works/pi-client",
	"@earendil-works/pi-coding-agent",
	"@earendil-works/pi-protocol",
	"@earendil-works/pi-telemetry",
	"@earendil-works/pi-tui",
	"typebox",
];
const problems = [];
for (const path of [
	"extensions/mcp-extension/package.json",
	"extensions/claude-web-search/package.json",
	"extensions/plan-mode/package.json",
	"extensions/pi-arcweld-todos/package.json",
]) {
	const manifest = JSON.parse(readFileSync(path, "utf8"));
	for (const name of HOST_PACKAGES) {
		for (const field of ["dependencies", "devDependencies"]) {
			if (manifest[field]?.[name] !== undefined) {
				problems.push(`${path}: ${name} must be a host-provided peer, not a pinned ${field} entry`);
			}
		}
		const range = manifest.peerDependencies?.[name];
		if (range !== undefined && range !== "*") {
			problems.push(`${path}: peerDependencies["${name}"] must be "*", found "${range}"`);
		}
	}
}
if (problems.length > 0) {
	throw new Error(`Pi host package boundary violations:\n  ${problems.join("\n  ")}`);
}

const html = readFileSync("docs/index.html", "utf8");
const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]));
const missing = [...html.matchAll(/\bhref="#([^"]+)"/g)]
	.map((match) => match[1])
	.filter((id) => !ids.has(id));
if (missing.length > 0) {
	throw new Error(`Missing landing-page anchors: ${[...new Set(missing)].join(", ")}`);
}
NODE

node --check mcp-servers/camoufox/scripts/deploy-local.js

# Self-contained extensions static rule assertions
grep -Fq 'promptSnippet: "Ask focused clarification questions when material decisions require user input"' extensions/questionnaire.ts
grep -Fq 'Use questionnaire only when missing input would materially change the result' extensions/questionnaire.ts
grep -Fq 'name: "exa_search"' extensions/exa-search.ts
grep -Fq 'When provider-side web_search is available, prefer web_search.' extensions/exa-search.ts
grep -Fq 'tools: [...tools, { type: "web_search" }]' extensions/codex-web-search.ts
grep -Fq 'name: WEB_RUN_TOOL_NAME' extensions/codex-web-search.ts
grep -Fq 'const WEB_SEARCH_TOOL_NAME = "WebSearch"' extensions/claude-web-search/index.ts
grep -Fq 'name: WEB_SEARCH_TOOL_NAME' extensions/claude-web-search/index.ts
grep -Fq 'runHostedWebSearch' extensions/claude-web-search/index.ts
grep -Fq 'HOSTED_WEB_SEARCH_TOOL_TYPE' extensions/claude-web-search/payload.ts
if grep -Fq 'before_provider_request' extensions/claude-web-search/index.ts; then
	echo "Claude WebSearch must not rewrite main provider payloads" >&2
	exit 1
fi
if grep -Fq 'registerProvider' extensions/claude-web-search/index.ts; then
	echo "Claude WebSearch must not override providers" >&2
	exit 1
fi
grep -Fq 'name: "grok_search"' extensions/grok-search.ts
if [[ -f extensions/gemini-web-search.ts ]]; then
	grep -Fq 'name: GOOGLE_SEARCH_TOOL_NAME' extensions/gemini-web-search.ts
fi

echo "==> [2/3] Checking packages and test suites in parallel"
pids=()

# 1. plan-mode
(
	cd "$ROOT_DIR/extensions/plan-mode"
	"$ROOT_DIR/scripts/check-extension-package.sh" plan-mode all
	npm pack --dry-run
) > "$tmp_dir/plan-mode.log" 2>&1 &
pids+=($!)

# 2. pi-arcweld-todos
(
	cd "$ROOT_DIR/extensions/pi-arcweld-todos"
	"$ROOT_DIR/scripts/check-extension-package.sh" pi-arcweld-todos all
	npm pack --dry-run
) > "$tmp_dir/todos.log" 2>&1 &
pids+=($!)

# 3. mcp-extension
(
	cd "$ROOT_DIR/extensions/mcp-extension"
	"$ROOT_DIR/scripts/check-mcp-extension.sh" all
	npm pack --dry-run
) > "$tmp_dir/mcp.log" 2>&1 &
pids+=($!)

# 4. claude-web-search
(
	cd "$ROOT_DIR/extensions/claude-web-search"
	"$ROOT_DIR/scripts/check-claude-web-search.sh" all
	npm pack --dry-run
) > "$tmp_dir/claude.log" 2>&1 &
pids+=($!)

# 5. camoufox
(
	if [[ ! -d "$ROOT_DIR/mcp-servers/camoufox/node_modules" ]]; then
		echo "mcp-servers/camoufox checks require its dependencies" >&2
		echo "Run npm ci --ignore-scripts in mcp-servers/camoufox first" >&2
		exit 1
	fi
	cd "$ROOT_DIR/mcp-servers/camoufox"
	npm test
) > "$tmp_dir/camoufox.log" 2>&1 &
pids+=($!)

# 6. Standalone extension test suites
(
	cd "$ROOT_DIR"
	standalone_tests=(extensions/test/codex-web-search.test.mts)
	if [[ -f extensions/test/gemini-web-search.test.mts ]]; then
		standalone_tests+=(extensions/test/gemini-web-search.test.mts)
	fi
	node --test "${standalone_tests[@]}"
) > "$tmp_dir/standalone-tests.log" 2>&1 &
pids+=($!)

failed=0
for pid in "${pids[@]}"; do
	if ! wait "$pid"; then
		failed=1
	fi
done

if [[ "$failed" -ne 0 ]]; then
	echo "Parallel check failed. Error logs below:" >&2
	for log in "$tmp_dir"/*.log; do
		if [[ -s "$log" ]]; then
			echo "----------------------------------------" >&2
			echo "Log: $(basename "$log")" >&2
			echo "----------------------------------------" >&2
			cat "$log" >&2
		fi
	done
	exit 1
fi

echo "==> [3/3] Checking self-contained extensions through Pi runtime loading shape"
mkdir -p "$agent_dir/extensions"
for extension in questionnaire.ts exa-search.ts codex-web-search.ts grok-search.ts; do
	ln -s "$ROOT_DIR/extensions/$extension" "$agent_dir/extensions/$extension"
done
if [[ -f "$ROOT_DIR/extensions/gemini-web-search.ts" ]]; then
	ln -s "$ROOT_DIR/extensions/gemini-web-search.ts" "$agent_dir/extensions/gemini-web-search.ts"
fi
ln -s "$ROOT_DIR/extensions/claude-web-search" "$agent_dir/extensions/claude-web-search"
PI_CODING_AGENT_DIR="$agent_dir" pi --list-models >/dev/null

echo "==> All workspace checks passed in parallel!"
