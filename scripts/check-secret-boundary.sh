#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
cd "$ROOT_DIR"

node - "$AGENT_DIR" <<'NODE'
const { existsSync, readFileSync } = require("node:fs");
const { execFileSync } = require("node:child_process");
const { basename, join } = require("node:path");

const agentDir = process.argv[2];
const forbiddenConfigNames = new Set([
	"auth.json",
	"credentials.json",
	"mcp.json",
	"models.json",
	"settings.json",
	"web-search.json",
]);

const candidates = execFileSync(
	"git",
	["ls-files", "--cached", "--others", "--exclude-standard", "--", ":!pi-mono"],
	{ encoding: "utf8" },
)
	.split("\n")
	.filter(Boolean);

const forbiddenPaths = candidates.filter((path) => forbiddenConfigNames.has(basename(path)));
if (forbiddenPaths.length > 0) {
	console.error("Machine-local Pi configuration must not be committed:");
	for (const path of forbiddenPaths) console.error(`  ${path}`);
	process.exitCode = 1;
}

const readableFiles = [];
for (const path of candidates) {
	try {
		readableFiles.push({ path, content: readFileSync(path, "utf8") });
	} catch {
		// Ignore non-text or concurrently removed files.
	}
}

const unsafeLiteralPatterns = [
	/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
	/\b(?:EXA|XAI)_API_KEY\s*=\s*["']?[^\s"'$<{][^\s"']{11,}/,
	/["'](?:exaApiKey|apiKey|accessToken|refreshToken|clientSecret)["']\s*:\s*["'][^$<{][^"']{11,}["']/,
];
const literalMatches = readableFiles
	.filter(({ content }) => unsafeLiteralPatterns.some((pattern) => pattern.test(content)))
	.map(({ path }) => path);
if (literalMatches.length > 0) {
	console.error("Potential literal credentials found in repository commit candidates:");
	for (const path of literalMatches) console.error(`  ${path}`);
	process.exitCode = 1;
}

const localSecrets = new Set();
function collectSecrets(value, key = "") {
	if (typeof value === "string") {
		const normalized = value.trim();
		if (
			normalized.length >= 16 &&
			/key|token|secret|access|refresh|password/i.test(key) &&
			!normalized.startsWith("$") &&
			!normalized.startsWith("!")
		) {
			localSecrets.add(normalized);
		}
		return;
	}
	if (!value || typeof value !== "object") return;
	for (const [childKey, childValue] of Object.entries(value)) collectSecrets(childValue, childKey);
}

for (const name of ["web-search.json", "auth.json", "models.json", "settings.json", "mcp.json"]) {
	const path = join(agentDir, name);
	if (!existsSync(path)) continue;
	try {
		collectSecrets(JSON.parse(readFileSync(path, "utf8")));
	} catch {
		// Malformed or non-JSON machine-local files are outside repository validation.
	}
}

const exactMatches = readableFiles
	.filter(({ content }) => [...localSecrets].some((secret) => content.includes(secret)))
	.map(({ path }) => path);
if (exactMatches.length > 0) {
	console.error("A machine-local credential value appears in repository commit candidates:");
	for (const path of exactMatches) console.error(`  ${path}`);
	process.exitCode = 1;
}

if (process.exitCode) process.exit(process.exitCode);
console.log(
	`Secret boundary passed: ${candidates.length} commit candidate file(s) checked against ${localSecrets.size} machine-local credential value(s).`,
);
NODE
