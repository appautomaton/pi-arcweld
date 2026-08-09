#!/bin/sh
# Update ~/.local/chrome to the newest stable Chrome (Linux ARM64).
# Keeps the .deb, swaps the extraction only after it verifies, leaves the profile untouched.
set -eu

CHROME_DIR="$HOME/.local/chrome"
DEB="google-chrome-stable_current_arm64.deb"
URL="https://dl.google.com/linux/direct/$DEB"

mkdir -p "$CHROME_DIR"
cd "$CHROME_DIR"

echo "current: $(current/opt/google/chrome/chrome --version 2>/dev/null || echo 'none')"

curl -fL -o "$DEB.new" "$URL"
mv "$DEB.new" "$DEB"

rm -rf next
dpkg -x "$DEB" next || true   # tar chmod warnings under PRoot; files still extract

NEW_BIN="next/opt/google/chrome/chrome"
if ! "$NEW_BIN" --version >/dev/null 2>&1; then
  echo "error: extracted chrome does not run; keeping existing install" >&2
  rm -rf next
  exit 1
fi

echo "new:     $("$NEW_BIN" --version)"
rm -rf previous
[ -d current ] && mv current previous
mv next current
rm -rf previous

echo "done — restart or reload the MCP client to pick it up"
