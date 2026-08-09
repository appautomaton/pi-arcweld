import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const piCli = resolve(
	packageRoot,
	"../../build/pi-agent/runtime/node_modules/@earendil-works/pi-coding-agent/dist/cli.js",
);

interface ProcessResult {
	code: number | null;
	signal: NodeJS.Signals | null;
	stdout: string;
	stderr: string;
}

function runPi(extensionPath: string): Promise<ProcessResult> {
	return new Promise((resolveResult, reject) => {
		const child = spawn(
			process.execPath,
			[piCli, "--no-extensions", "-e", extensionPath, "--mode", "rpc", "--no-session"],
			{
				cwd: packageRoot,
				env: process.env,
				stdio: ["pipe", "pipe", "pipe"],
			},
		);
		let stdout = "";
		let stderr = "";
		const timeout = setTimeout(() => child.kill("SIGKILL"), 20_000);
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => (stdout += chunk));
		child.stderr.on("data", (chunk: string) => (stderr += chunk));
		child.on("error", reject);
		child.on("close", (code, signal) => {
			clearTimeout(timeout);
			resolveResult({ code, signal, stdout, stderr });
		});
		child.stdin.end('{"type":"get_state"}\n');
	});
}

test("loads through a directory symlink with Pi's extension aliases", async () => {
	const temporaryDirectory = await mkdtemp(join(tmpdir(), "pi-claude-web-search-load-"));
	const extensionPath = join(temporaryDirectory, "claude-web-search");
	try {
		await symlink(packageRoot, extensionPath, "dir");
		const result = await runPi(extensionPath);
		assert.equal(result.signal, null, result.stderr);
		assert.equal(result.code, 0, result.stderr);
		assert.doesNotMatch(result.stderr, /Failed to load extension|Cannot find module/);
		assert.match(result.stdout, /"command":"get_state"/);
	} finally {
		await rm(temporaryDirectory, { recursive: true, force: true });
	}
});
