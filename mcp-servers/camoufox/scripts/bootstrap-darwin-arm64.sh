#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)

fail() {
  printf 'FAIL %s\n' "$*" >&2
  exit 1
}

[ "$(uname -s)" = Darwin ] || fail "this bootstrap supports macOS only"
[ "$(uname -m)" = arm64 ] || fail "this bootstrap supports Apple Silicon (arm64) only"

for command in node npm curl unzip; do
  command -v "$command" >/dev/null 2>&1 || fail "required command not found: $command"
done

node_major=$(node -p 'process.versions.node.split(".")[0]')
[ "$node_major" -ge 24 ] || fail "Node 24 or newer is required; found $(node --version)"

printf 'bootstrap root: %s\n' "$ROOT"
printf 'runtime: macOS %s %s, Node %s, npm %s\n' "$(sw_vers -productVersion)" "$(uname -m)" "$(node --version)" "$(npm --version)"

cd "$ROOT"
npm ci
node scripts/install-camoufox-browser.js
npm run doctor

printf '%s\n' 'ok Darwin ARM64 bootstrap complete'
