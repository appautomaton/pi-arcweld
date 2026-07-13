#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)

fail() {
  printf 'FAIL %s\n' "$*" >&2
  exit 1
}

[ "$(uname -s)" = Linux ] || fail "this bootstrap supports Linux only"
[ "$(uname -m)" = aarch64 ] || fail "this bootstrap supports aarch64 only"
[ -r /etc/os-release ] || fail "/etc/os-release is missing"
. /etc/os-release
[ "${ID:-}" = debian ] || fail "this bootstrap is verified only on Debian"
{ grep -qi 'PRoot' /proc/version 2>/dev/null || uname -a | grep -qi 'PRoot'; } || fail "this bootstrap is verified only inside PRoot"

for command in node npm curl sha256sum unzip Xvfb; do
  command -v "$command" >/dev/null 2>&1 || fail "required command not found: $command"
done

node_major=$(node -p 'process.versions.node.split(".")[0]')
[ "$node_major" -ge 24 ] || fail "Node 24 or newer is required; found $(node --version)"

printf 'bootstrap root: %s\n' "$ROOT"
printf 'runtime: %s %s, Node %s, npm %s\n' "${PRETTY_NAME:-Debian}" "$(uname -m)" "$(node --version)" "$(npm --version)"

cd "$ROOT"
npm ci
node scripts/install-camoufox-browser.js
npm run doctor

printf '%s\n' 'ok PRoot ARM64 bootstrap complete'
