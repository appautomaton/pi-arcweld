#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

echo "==> Checking shell scripts"
bash -n scripts/*.sh

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

for package_dir in extensions/plan-mode extensions/mcp-extension; do
	echo "==> Checking $package_dir"
	(
		cd "$package_dir"
		npm run check
		npm test
		npm run pack:check
	)
done

echo "==> Checking questionnaire through its user-level loading shape"
grep -Fq 'promptSnippet: "Ask focused clarification questions when material decisions require user input"' extensions/questionnaire.ts
grep -Fq 'Use questionnaire only when missing input would materially change the result' extensions/questionnaire.ts
agent_dir="$(mktemp -d)"
trap 'rm -rf "$agent_dir"' EXIT
mkdir -p "$agent_dir/extensions"
ln -s "$ROOT_DIR/extensions/questionnaire.ts" "$agent_dir/extensions/questionnaire.ts"
PI_CODING_AGENT_DIR="$agent_dir" pi --list-models >/dev/null

echo "==> Workspace checks passed"
