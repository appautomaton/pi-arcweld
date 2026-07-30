#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

echo "==> Checking shell scripts"
bash -n scripts/*.sh

echo "==> Checking secret boundary"
scripts/check-secret-boundary.sh

echo "==> Checking repository references"
if stale_references="$(git grep -n -E 'pi-mcp-client-local|/home/dev|href="#workshop"|id="workshop"' -- ':!pi-mono' ':!scripts/check-workspace.sh')"; then
	printf '%s\n' "$stale_references" >&2
	echo "Stale repository references found" >&2
	exit 1
fi

echo "==> Checking package manifests"
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
]) {
	JSON.parse(readFileSync(path, "utf8"));
}
NODE

echo "==> Checking landing-page anchors"
node <<'NODE'
const { readFileSync } = require("node:fs");
const html = readFileSync("docs/index.html", "utf8");
const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]));
const missing = [...html.matchAll(/\bhref="#([^"]+)"/g)]
	.map((match) => match[1])
	.filter((id) => !ids.has(id));
if (missing.length > 0) {
	throw new Error(`Missing landing-page anchors: ${[...new Set(missing)].join(", ")}`);
}
NODE

for package_dir in extensions/plan-mode extensions/pi-arcweld-todos extensions/mcp-extension extensions/claude-web-search; do
	echo "==> Checking $package_dir"
	(
		cd "$package_dir"
		npm run check
		npm test
		npm run pack:check
	)
done

echo "==> Checking self-contained extensions through their user-level loading shape"
grep -Fq 'promptSnippet: "Ask focused clarification questions when material decisions require user input"' extensions/questionnaire.ts
grep -Fq 'Use questionnaire only when missing input would materially change the result' extensions/questionnaire.ts
grep -Fq 'name: "exa_search"' extensions/exa-search.ts
grep -Fq 'When provider-side web_search is available, prefer web_search.' extensions/exa-search.ts
grep -Fq 'tools: [...tools, { type: "web_search" }]' extensions/codex-web-search.ts
grep -Fq 'name: WEB_RUN_TOOL_NAME' extensions/codex-web-search.ts
grep -Fq 'pi.registerProvider(provider' extensions/claude-web-search/index.ts
grep -Fq 'createReplaySafeFetch' extensions/claude-web-search/provider.ts
grep -Fq 'web_search_tool_result' extensions/claude-web-search/protocol.ts
grep -Fq 'name: "grok_search"' extensions/grok-search.ts
node --test extensions/test/codex-web-search.test.mts
agent_dir="$(mktemp -d)"
trap 'rm -rf "$agent_dir"' EXIT
mkdir -p "$agent_dir/extensions"
for extension in questionnaire.ts exa-search.ts codex-web-search.ts grok-search.ts; do
	ln -s "$ROOT_DIR/extensions/$extension" "$agent_dir/extensions/$extension"
done
ln -s "$ROOT_DIR/extensions/claude-web-search" "$agent_dir/extensions/claude-web-search"
PI_CODING_AGENT_DIR="$agent_dir" pi --list-models >/dev/null

echo "==> Workspace checks passed"
