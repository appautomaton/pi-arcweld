#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MONO_DIR="$ROOT_DIR/pi-mono"
BUILD_DIR="$ROOT_DIR/build/pi-agent"
LINK_USER_BIN=false
KEEP_WORK=false
MIN_RELEASE_AGE_EXCLUDE=()

usage() {
	cat <<'USAGE'
Usage: scripts/build-pi-agent.sh [options]

Build Pi outside pi-mono while treating pi-mono as source input only.

Options:
  --link-user-bin      Repoint the current `pi` command to the external runtime after smoke checks.
  --keep-work          Keep the temporary build workspace after a successful build.
  --build-dir <dir>    Build root. Defaults to <repository>/build/pi-agent.
  --min-release-age-exclude <pkg[,pkg...]>
                       Exempt the named packages from the upstream .npmrc
                       min-release-age gate during the runtime install only.
                       Use when upstream pins a package that is newer than the
                       gate; every other package stays gated.
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
		--min-release-age-exclude)
			if [[ $# -lt 2 ]]; then
				echo "--min-release-age-exclude requires a package list" >&2
				exit 1
			fi
			IFS=',' read -r -a _exclude_entries <<< "$2"
			MIN_RELEASE_AGE_EXCLUDE+=("${_exclude_entries[@]}")
			unset _exclude_entries
			shift 2
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
# Packages are derived, not hardcoded. resolve_runtime_packages() asks
# scripts/resolve-runtime-packages.mjs for the dependency closure of
# @earendil-works/pi-coding-agent over pi-mono's own package manifests, in
# topological order, so upstream package additions and removals are picked up
# without editing this script.
PACKAGE_NAMES=()
declare -A PACKAGE_NPM_NAMES=()
TYPESCRIPT_COMPILER=""
TYPESCRIPT_COMPILER_ARGS=()

if [[ ! -f "$MONO_DIR/package.json" ]]; then
	echo "Missing pi-mono checkout at $MONO_DIR" >&2
	exit 1
fi

if [[ "$BUILD_DIR" == "$MONO_DIR" || "$BUILD_DIR" == "$MONO_DIR"/* ]]; then
	echo "Build directory must be outside pi-mono: $BUILD_DIR" >&2
	exit 1
fi

resolve_runtime_packages() {
	local resolved dir npm_name

	if ! resolved="$(node "$ROOT_DIR/scripts/resolve-runtime-packages.mjs" "$MONO_DIR")"; then
		echo "Failed to resolve runtime packages from $MONO_DIR" >&2
		exit 1
	fi

	while IFS=$'\t' read -r dir npm_name; do
		if [[ -z "$dir" || -z "$npm_name" ]]; then
			continue
		fi
		PACKAGE_NAMES+=("$dir")
		PACKAGE_NPM_NAMES["$dir"]="$npm_name"
	done <<< "$resolved"

	if [[ ${#PACKAGE_NAMES[@]} -eq 0 ]]; then
		echo "Resolved an empty runtime package list from $MONO_DIR" >&2
		exit 1
	fi

	echo "==> Runtime packages (dependencies first): ${PACKAGE_NAMES[*]}"
}

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

select_typescript_compiler() {
	local tsgo="$WORK_DIR/node_modules/.bin/tsgo"
	local tsc="$WORK_DIR/node_modules/.bin/tsc"

	if [[ -x "$tsgo" ]] && "$tsgo" --version >/dev/null 2>&1; then
		TYPESCRIPT_COMPILER="$tsgo"
	else
		if [[ ! -x "$tsc" ]]; then
			echo "Neither tsgo nor tsc is runnable" >&2
			exit 1
		fi
		TYPESCRIPT_COMPILER="$tsc"
		# The TUI uses the RegExp v flag, which tsc accepts only with an ES2024 target.
		TYPESCRIPT_COMPILER_ARGS=(--target ES2024)
	fi

	echo "==> Using TypeScript compiler: $TYPESCRIPT_COMPILER"
}

build_typescript_packages() {
	echo "==> Building package dist outputs outside pi-mono"
	for package_name in "${PACKAGE_NAMES[@]}"; do
		echo "==> Building packages/$package_name"
		rm -rf "$WORK_DIR/packages/$package_name/dist"
		if [[ "$package_name" == "ai" ]]; then
			(
				cd "$WORK_DIR/packages/ai"
				PATH="$WORK_DIR/node_modules/.bin:$PATH" node "$MONO_DIR/packages/ai/scripts/generate-models.ts"
			)
		fi
		"$TYPESCRIPT_COMPILER" "${TYPESCRIPT_COMPILER_ARGS[@]}" -p "$WORK_DIR/packages/$package_name/tsconfig.build.json"
		if [[ "$package_name" == "ai" ]]; then
			copy_dir "$WORK_DIR/packages/ai/src/providers/data" "$WORK_DIR/packages/ai/dist/providers/data"
		fi
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
	local deps_json="$1"

	mkdir -p "$NEXT_RUNTIME_DIR"
	copy_file "$MONO_DIR/.npmrc" "$NEXT_RUNTIME_DIR/.npmrc"
	cat > "$NEXT_RUNTIME_DIR/package.json" <<JSON
{
	"private": true,
	"description": "Local Pi runtime built outside pi-mono",
	"dependencies": {
$deps_json
	},
	"overrides": {
$deps_json
	}
}
JSON
}

assemble_runtime() {
	local package_name npm_name tarball spec deps_json
	local -a dep_lines=()

	rm -rf "$NEXT_RUNTIME_DIR"
	for package_name in "${PACKAGE_NAMES[@]}"; do
		npm_name="${PACKAGE_NPM_NAMES[$package_name]}"
		tarball="$(pack_package "$package_name")"
		spec="file:../artifacts/tarballs/$(basename "$tarball")"
		dep_lines+=("$(printf '\t\t"%s": "%s"' "$npm_name" "$spec")")
	done
	deps_json="$(printf '%s,\n' "${dep_lines[@]}" | sed '$ s/,$//')"

	echo "==> Installing production runtime dependencies"
	write_runtime_package_json "$deps_json"

	local -a npm_install_args=(--omit=dev --ignore-scripts --prefix "$NEXT_RUNTIME_DIR")
	local excluded
	for excluded in ${MIN_RELEASE_AGE_EXCLUDE[@]+"${MIN_RELEASE_AGE_EXCLUDE[@]}"}; do
		echo "==> Exempting $excluded from the min-release-age gate"
		npm_install_args+=("--min-release-age-exclude=$excluded")
	done
	npm install "${npm_install_args[@]}"

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

resolve_runtime_packages
prepare_workdir
install_build_dependencies
select_typescript_compiler
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
