#!/usr/bin/env node
// Resolve which pi-mono workspace packages the local Pi runtime must build, and
// in what order, by reading upstream package manifests instead of duplicating
// upstream's hardcoded build chain.
//
// The result is the dependency closure of the root package over workspace-local
// dependencies: start at the root, follow every @earendil-works/* dependency
// edge, and stop when no new package appears. Packages outside that closure
// (server, evals, session-backends/*) are excluded automatically, so this script
// needs no skip list.
//
// Output is a topological order produced by depth-first post-order traversal:
// every package is printed after all packages it depends on, which is the order
// tsgo needs because each build type-checks against its dependencies' emitted
// declarations.
//
// Usage:   node scripts/resolve-runtime-packages.mjs <pi-mono-dir> [rootPackage]
// Output:  one "<dir>\t<npmName>" line per package, dependencies first.
//          <dir> is relative to <pi-mono-dir>/packages.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const DEFAULT_ROOT_PACKAGE = "@earendil-works/pi-coding-agent";
const WORKSPACE_SCOPE = "@earendil-works/";

// devDependencies are deliberately excluded: a build compiles only src/** via
// tsconfig.build.json, so test-only workspace edges (evals -> coding-agent)
// must not pull extra packages into the runtime.
const DEPENDENCY_FIELDS = ["dependencies", "peerDependencies", "optionalDependencies"];

// packages/* plus one nested level for packages/session-backends/*. Example
// extension workspaces live deeper and are not runtime packages.
const MAX_SCAN_DEPTH = 2;

function fail(message) {
	process.stderr.write(`resolve-runtime-packages: ${message}\n`);
	process.exit(1);
}

function readJson(path) {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		fail(`cannot read ${path}: ${error.message}`);
	}
}

/** Collect every workspace package under packages/, keyed by npm name. */
function discoverPackages(packagesDir) {
	const found = new Map();

	const scan = (absoluteDir, relativeDir, depth) => {
		let entries;
		try {
			entries = readdirSync(absoluteDir, { withFileTypes: true });
		} catch (error) {
			fail(`cannot list ${absoluteDir}: ${error.message}`);
		}

		for (const entry of entries) {
			if (!entry.isDirectory() || entry.name === "node_modules" || entry.name.startsWith(".")) {
				continue;
			}

			const childAbsolute = join(absoluteDir, entry.name);
			const childRelative = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
			const manifestPath = join(childAbsolute, "package.json");

			let hasManifest = false;
			try {
				hasManifest = statSync(manifestPath).isFile();
			} catch {
				hasManifest = false;
			}

			if (hasManifest) {
				const manifest = readJson(manifestPath);
				if (typeof manifest.name !== "string" || manifest.name.length === 0) {
					fail(`package at packages/${childRelative} has no name`);
				}
				if (found.has(manifest.name)) {
					fail(`duplicate package name ${manifest.name} under packages/`);
				}

				const dependencies = new Set();
				for (const field of DEPENDENCY_FIELDS) {
					for (const name of Object.keys(manifest[field] ?? {})) {
						if (name.startsWith(WORKSPACE_SCOPE)) {
							dependencies.add(name);
						}
					}
				}

				found.set(manifest.name, {
					dir: childRelative,
					dependencies: [...dependencies].sort(),
				});
				continue;
			}

			if (depth < MAX_SCAN_DEPTH) {
				scan(childAbsolute, childRelative, depth + 1);
			}
		}
	};

	scan(packagesDir, "", 1);
	return found;
}

/** Depth-first post-order over the closure; throws on cycles. */
function resolveBuildOrder(packages, rootName) {
	const order = [];
	const state = new Map();

	const visit = (name, trail) => {
		if (state.get(name) === "done") return;
		if (state.get(name) === "visiting") {
			fail(`dependency cycle: ${[...trail, name].join(" -> ")}`);
		}

		const entry = packages.get(name);
		if (!entry) {
			fail(
				`${name} is required by ${trail.at(-1) ?? "the command line"} ` +
					`but no package under packages/ declares that name`,
			);
		}

		state.set(name, "visiting");
		for (const dependency of entry.dependencies) {
			visit(dependency, [...trail, name]);
		}
		state.set(name, "done");
		order.push(name);
	};

	visit(rootName, []);
	return order;
}

const monoDir = process.argv[2];
const rootPackageName = process.argv[3] ?? DEFAULT_ROOT_PACKAGE;

if (!monoDir) {
	fail("usage: resolve-runtime-packages.mjs <pi-mono-dir> [rootPackage]");
}

const packages = discoverPackages(join(monoDir, "packages"));
const buildOrder = resolveBuildOrder(packages, rootPackageName);

process.stdout.write(
	`${buildOrder.map((name) => `${packages.get(name).dir}\t${name}`).join("\n")}\n`,
);
