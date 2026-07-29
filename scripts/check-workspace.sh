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

for package_dir in extensions/plan-mode extensions/pi-arcweld-todos extensions/mcp-extension; do
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
grep -Fq 'name: "grok_search"' extensions/grok-search.ts
if native_anthropic_search="$(git grep -n -F 'web_search_20' -- 'extensions/*.ts')"; then
	printf '%s\n' "$native_anthropic_search" >&2
	echo "Anthropic native web search injection is disabled until Pi preserves server-tool responses" >&2
	exit 1
fi
node --input-type=module <<'NODE'
import assert from "node:assert/strict";
import { getCodexWebSearchRoute, injectCodexWebSearch } from "./extensions/codex-web-search.ts";

const oauthModel = { provider: "openai-codex", api: "openai-codex-responses", id: "gpt-5.6-sol" };
const cpaModel = { provider: "cli-proxy-api", api: "openai-responses", id: "gpt-5.6-sol" };
const otherModel = { provider: "openai", api: "openai-responses", id: "gpt-5.6" };
const functionTool = { type: "function", name: "exa_search" };

assert.equal(getCodexWebSearchRoute(oauthModel), "openai-codex-oauth");
assert.equal(getCodexWebSearchRoute(cpaModel), "cli-proxy-api");
assert.equal(getCodexWebSearchRoute(otherModel), undefined);
assert.deepEqual(injectCodexWebSearch({ model: oauthModel.id }, oauthModel), {
	model: oauthModel.id,
	tools: [{ type: "web_search" }],
});
assert.deepEqual(injectCodexWebSearch({ tools: [functionTool] }, cpaModel), {
	tools: [functionTool, { type: "web_search" }],
});
const duplicate = { tools: [{ type: "web_search" }] };
assert.equal(injectCodexWebSearch(duplicate, cpaModel), duplicate);
const ineligible = { tools: [functionTool] };
assert.equal(injectCodexWebSearch(ineligible, otherModel), ineligible);
NODE
agent_dir="$(mktemp -d)"
trap 'rm -rf "$agent_dir"' EXIT
mkdir -p "$agent_dir/extensions"
for extension in questionnaire.ts exa-search.ts codex-web-search.ts grok-search.ts; do
	ln -s "$ROOT_DIR/extensions/$extension" "$agent_dir/extensions/$extension"
done
PI_CODING_AGENT_DIR="$agent_dir" pi --list-models >/dev/null

echo "==> Workspace checks passed"
