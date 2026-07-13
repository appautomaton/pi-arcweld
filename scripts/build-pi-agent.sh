#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MONO_DIR="$ROOT_DIR/pi-mono"
BUILD_DIR="$ROOT_DIR/build/pi-agent"
LINK_USER_BIN=false
KEEP_WORK=false

usage() {
	cat <<'USAGE'
Usage: scripts/build-pi-agent.sh [options]

Build Pi outside pi-mono while treating pi-mono as source input only.

Options:
  --link-user-bin      Repoint the current `pi` command to the external runtime after smoke checks.
  --keep-work          Keep the temporary build workspace after a successful build.
  --build-dir <dir>    Build root. Defaults to <repository>/build/pi-agent.
  --help               Show this help.
USAGE
}

while [[ $# -gt 0 ]]; do
	case "$1" in
		--link-user-bin)
			LINK_USER_BIN=true
			shift
			;;
		--keep-work)
			KEEP_WORK=true
			shift
			;;
		--build-dir)
			if [[ $# -lt 2 ]]; then
				echo "--build-dir requires a directory" >&2
				exit 1
			fi
			BUILD_DIR="$(mkdir -p "$(dirname "$2")" && cd "$(dirname "$2")" && pwd)/$(basename "$2")"
			shift 2
			;;
		--help)
			usage
			exit 0
			;;
		*)
			echo "Unknown option: $1" >&2
			usage >&2
			exit 1
			;;
	esac
done

WORK_DIR="$BUILD_DIR/work"
RUNTIME_DIR="$BUILD_DIR/runtime"
NEXT_RUNTIME_DIR="$BUILD_DIR/runtime.next"
TARBALL_DIR="$BUILD_DIR/artifacts/tarballs"
PACKAGE_NAMES=(tui ai agent coding-agent)

if [[ ! -f "$MONO_DIR/package.json" ]]; then
	echo "Missing pi-mono checkout at $MONO_DIR" >&2
	exit 1
fi

if [[ "$BUILD_DIR" == "$MONO_DIR" || "$BUILD_DIR" == "$MONO_DIR"/* ]]; then
	echo "Build directory must be outside pi-mono: $BUILD_DIR" >&2
	exit 1
fi

copy_file() {
	local source="$1"
	local target="$2"
	mkdir -p "$(dirname "$target")"
	cp "$source" "$target"
}

copy_dir() {
	local source="$1"
	local target="$2"
	rm -rf "$target"
	mkdir -p "$(dirname "$target")"
	cp -R "$source" "$target"
}

link_source_dir() {
	local source="$1"
	local target="$2"
	rm -rf "$target"
	ln -s "$source" "$target"
}

prepare_workdir() {
	echo "==> Preparing external build workspace: $WORK_DIR"
	rm -rf "$WORK_DIR" "$NEXT_RUNTIME_DIR" "$TARBALL_DIR"
	mkdir -p "$WORK_DIR/packages" "$TARBALL_DIR"

	copy_file "$MONO_DIR/package.json" "$WORK_DIR/package.json"
	copy_file "$MONO_DIR/package-lock.json" "$WORK_DIR/package-lock.json"
	copy_file "$MONO_DIR/tsconfig.base.json" "$WORK_DIR/tsconfig.base.json"
	copy_file "$MONO_DIR/.npmrc" "$WORK_DIR/.npmrc"

	for package_name in "${PACKAGE_NAMES[@]}"; do
		local source_package="$MONO_DIR/packages/$package_name"
		local build_package="$WORK_DIR/packages/$package_name"

		mkdir -p "$build_package"
		copy_file "$source_package/package.json" "$build_package/package.json"
		copy_file "$source_package/tsconfig.build.json" "$build_package/tsconfig.build.json"
		link_source_dir "$source_package/src" "$build_package/src"

		if [[ -f "$source_package/README.md" ]]; then
			copy_file "$source_package/README.md" "$build_package/README.md"
		fi
		if [[ -f "$source_package/CHANGELOG.md" ]]; then
			copy_file "$source_package/CHANGELOG.md" "$build_package/CHANGELOG.md"
		fi
		if [[ "$package_name" == "coding-agent" ]]; then
			copy_dir "$source_package/docs" "$build_package/docs"
			copy_dir "$source_package/examples" "$build_package/examples"
			if [[ -f "$source_package/npm-shrinkwrap.json" ]]; then
				copy_file "$source_package/npm-shrinkwrap.json" "$build_package/npm-shrinkwrap.json"
			fi
		fi
	done
}

install_build_dependencies() {
	echo "==> Installing build dependencies outside pi-mono"
	npm ci --ignore-scripts --prefix "$WORK_DIR"
}

build_typescript_packages() {
	echo "==> Building package dist outputs outside pi-mono"
	for package_name in "${PACKAGE_NAMES[@]}"; do
		echo "==> Building packages/$package_name"
		rm -rf "$WORK_DIR/packages/$package_name/dist"
		"$WORK_DIR/node_modules/.bin/tsgo" -p "$WORK_DIR/packages/$package_name/tsconfig.build.json"
	done
}

copy_coding_agent_assets() {
	local source_dir="$MONO_DIR/packages/coding-agent/src"
	local dist_dir="$WORK_DIR/packages/coding-agent/dist"

	echo "==> Copying coding-agent runtime assets"
	chmod +x "$dist_dir/cli.js" "$dist_dir/rpc-entry.js"
	mkdir -p "$dist_dir/modes/interactive/theme"
	cp "$source_dir"/modes/interactive/theme/*.json "$dist_dir/modes/interactive/theme/"
	mkdir -p "$dist_dir/modes/interactive/assets"
	cp "$source_dir"/modes/interactive/assets/*.png "$dist_dir/modes/interactive/assets/"
	mkdir -p "$dist_dir/core/export-html/vendor"
	cp "$source_dir/core/export-html/template.html" "$dist_dir/core/export-html/"
	cp "$source_dir/core/export-html/template.css" "$dist_dir/core/export-html/"
	cp "$source_dir/core/export-html/template.js" "$dist_dir/core/export-html/"
	cp "$source_dir/core/export-html/vendor/"*.js "$dist_dir/core/export-html/vendor/"
}

pack_package() {
	local package_name="$1"
	local package_dir="$WORK_DIR/packages/$package_name"
	local output filename

	echo "==> Packing packages/$package_name" >&2
	output="$(cd "$package_dir" && npm pack --json --pack-destination "$TARBALL_DIR")"
	filename="$(printf '%s' "$output" | node -e 'let input = ""; process.stdin.on("data", d => input += d); process.stdin.on("end", () => console.log(JSON.parse(input)[0].filename));')"
	echo "$TARBALL_DIR/$filename"
}

write_runtime_package_json() {
	local ai_tarball="$1"
	local tui_tarball="$2"
	local agent_tarball="$3"
	local coding_agent_tarball="$4"
	local ai_spec="file:../artifacts/tarballs/$(basename "$ai_tarball")"
	local tui_spec="file:../artifacts/tarballs/$(basename "$tui_tarball")"
	local agent_spec="file:../artifacts/tarballs/$(basename "$agent_tarball")"
	local coding_agent_spec="file:../artifacts/tarballs/$(basename "$coding_agent_tarball")"

	mkdir -p "$NEXT_RUNTIME_DIR"
	copy_file "$MONO_DIR/.npmrc" "$NEXT_RUNTIME_DIR/.npmrc"
	cat > "$NEXT_RUNTIME_DIR/package.json" <<JSON
{
	"private": true,
	"description": "Local Pi runtime built outside pi-mono",
	"dependencies": {
		"@earendil-works/pi-ai": "$ai_spec",
		"@earendil-works/pi-tui": "$tui_spec",
		"@earendil-works/pi-agent-core": "$agent_spec",
		"@earendil-works/pi-coding-agent": "$coding_agent_spec"
	},
	"overrides": {
		"@earendil-works/pi-ai": "$ai_spec",
		"@earendil-works/pi-tui": "$tui_spec",
		"@earendil-works/pi-agent-core": "$agent_spec",
		"@earendil-works/pi-coding-agent": "$coding_agent_spec"
	}
}
JSON
}

assemble_runtime() {
	local ai_tarball tui_tarball agent_tarball coding_agent_tarball

	rm -rf "$NEXT_RUNTIME_DIR"
	ai_tarball="$(pack_package ai)"
	tui_tarball="$(pack_package tui)"
	agent_tarball="$(pack_package agent)"
	coding_agent_tarball="$(pack_package coding-agent)"

	echo "==> Installing production runtime dependencies"
	write_runtime_package_json "$ai_tarball" "$tui_tarball" "$agent_tarball" "$coding_agent_tarball"
	npm install --omit=dev --ignore-scripts --prefix "$NEXT_RUNTIME_DIR"

	mkdir -p "$NEXT_RUNTIME_DIR/bin"
	ln -sfn ../node_modules/.bin/pi "$NEXT_RUNTIME_DIR/bin/pi"
}

smoke_check_runtime() {
	local pi_bin="$NEXT_RUNTIME_DIR/bin/pi"

	echo "==> Smoke checking external runtime"
	test -x "$NEXT_RUNTIME_DIR/node_modules/@earendil-works/pi-coding-agent/dist/cli.js"
	test -L "$pi_bin"
	"$pi_bin" --version >/dev/null
	"$pi_bin" --help >/dev/null
	if find "$NEXT_RUNTIME_DIR" -type l -lname "$MONO_DIR/*" | grep -q .; then
		echo "Runtime contains symlinks back into pi-mono" >&2
		find "$NEXT_RUNTIME_DIR" -type l -lname "$MONO_DIR/*" -print >&2
		exit 1
	fi
}

promote_runtime() {
	echo "==> Promoting runtime"
	rm -rf "$RUNTIME_DIR"
	mv "$NEXT_RUNTIME_DIR" "$RUNTIME_DIR"
	mkdir -p "$BUILD_DIR/bin"
	ln -sfn ../runtime/bin/pi "$BUILD_DIR/bin/pi"
}

link_user_bin() {
	local user_pi_bin node_prefix global_package_link
	user_pi_bin="$(command -v pi || true)"
	if [[ -z "$user_pi_bin" ]]; then
		echo "Cannot link user pi bin: pi is not currently on PATH." >&2
		exit 1
	fi
	if [[ -e "$user_pi_bin" && ! -L "$user_pi_bin" ]]; then
		echo "Refusing to replace non-symlink pi command: $user_pi_bin" >&2
		exit 1
	fi
	ln -sfn "$RUNTIME_DIR/bin/pi" "$user_pi_bin"
	echo "==> Linked $user_pi_bin -> $RUNTIME_DIR/bin/pi"

	node_prefix="$(cd "$(dirname "$user_pi_bin")/.." && pwd)"
	global_package_link="$node_prefix/lib/node_modules/@mariozechner/pi-coding-agent"
	if [[ -L "$global_package_link" || ! -e "$global_package_link" ]]; then
		mkdir -p "$(dirname "$global_package_link")"
		ln -sfn "$RUNTIME_DIR/node_modules/@earendil-works/pi-coding-agent" "$global_package_link"
		echo "==> Linked $global_package_link -> $RUNTIME_DIR/node_modules/@earendil-works/pi-coding-agent"
	else
		echo "Skipping non-symlink global package path: $global_package_link" >&2
	fi
}

cleanup_stale_layout() {
	echo "==> Cleaning stale mixed build layout"
	rm -rf "$BUILD_DIR/node_modules" "$BUILD_DIR/packages" "$BUILD_DIR/package.json" "$BUILD_DIR/package-lock.json" "$BUILD_DIR/.npmrc" "$BUILD_DIR/tsconfig.base.json"
	mkdir -p "$BUILD_DIR/bin"
	ln -sfn ../runtime/bin/pi "$BUILD_DIR/bin/pi"
	if [[ "$KEEP_WORK" == "false" ]]; then
		rm -rf "$WORK_DIR"
	fi
}

prepare_workdir
install_build_dependencies
build_typescript_packages
copy_coding_agent_assets
assemble_runtime
smoke_check_runtime
promote_runtime

if [[ "$LINK_USER_BIN" == "true" ]]; then
	link_user_bin
fi

cleanup_stale_layout

echo "==> Done"
echo "External pi: $RUNTIME_DIR/bin/pi"
echo "Runtime:     $RUNTIME_DIR"
echo "Artifacts:   $BUILD_DIR/artifacts"
if [[ "$KEEP_WORK" == "true" ]]; then
	echo "Work:        $WORK_DIR"
fi
