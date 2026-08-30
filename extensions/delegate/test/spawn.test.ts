import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createChildSession, type SpawnEnv } from "../spawn.ts";
import { childToolNames } from "../types.ts";

async function withDirs(run: (cwd: string, agentDir: string) => Promise<void>): Promise<void> {
	const cwd = await mkdtemp(join(tmpdir(), "pi-arcweld-delegate-cwd-"));
	const agentDir = await mkdtemp(join(tmpdir(), "pi-arcweld-delegate-agent-"));
	try {
		await run(cwd, agentDir);
	} finally {
		await rm(cwd, { recursive: true, force: true });
		await rm(agentDir, { recursive: true, force: true });
	}
}

async function isolatedRuntime(agentDir: string): Promise<ModelRuntime> {
	return ModelRuntime.create({
		refreshOnCreate: false,
		modelsPath: null,
		authPath: join(agentDir, "auth.json"),
	});
}

const params = { to: "flash", task: "scan auth", scope: "src/", done_when: "report" };

function env(cwd: string, agentDir: string, projectTrusted = true): SpawnEnv {
	return { cwd, agentDir, projectTrusted, hasUI: false };
}

test("childToolNames keeps delegate_result even when the caller asked for read only", () => {
	assert.ok(childToolNames(["read"], 1).includes("delegate_result"));
});

test("createChildSession allowlist includes delegate_result and gates nested delegate", async () => {
	await withDirs(async (cwd, agentDir) => {
		const runtime = await isolatedRuntime(agentDir);
		const shallow = await createChildSession({
			env: env(cwd, agentDir),
			params,
			depth: 1,
			workTools: ["read"],
			modelRuntime: runtime,
			onResult: () => {},
		});
		try {
			const names = shallow.getActiveToolNames();
			assert.ok(names.includes("delegate_result"), `missing delegate_result: ${names.join(",")}`);
			assert.ok(names.includes("delegate"), `missing nested delegate: ${names.join(",")}`);
			assert.ok(names.includes("read"));
			assert.equal(names.includes("bash"), false);
			assert.equal(names.includes("update_todos"), false);
		} finally {
			shallow.dispose();
		}

		const deep = await createChildSession({
			env: env(cwd, agentDir),
			params,
			depth: 2,
			workTools: ["read"],
			modelRuntime: runtime,
			onResult: () => {},
		});
		try {
			const names = deep.getActiveToolNames();
			assert.ok(names.includes("delegate_result"));
			assert.equal(names.includes("delegate"), false);
		} finally {
			deep.dispose();
		}
	});
});

test("child system prompt keeps discovered APPEND_SYSTEM.md and appends the spawn addendum", async () => {
	await withDirs(async (cwd, agentDir) => {
		await writeFile(join(agentDir, "APPEND_SYSTEM.md"), "ARCWELD-GUIDANCE-MARKER\n");
		const runtime = await isolatedRuntime(agentDir);
		const session = await createChildSession({
			env: env(cwd, agentDir),
			params,
			depth: 1,
			workTools: ["read"],
			modelRuntime: runtime,
			onResult: () => {},
		});
		try {
			assert.match(session.systemPrompt, /ARCWELD-GUIDANCE-MARKER/);
			assert.match(session.systemPrompt, /delegated worker \(depth 1 of 2\)/);
			assert.match(session.systemPrompt, /Allowed work tools: read/);
		} finally {
			session.dispose();
		}
	});
});

test("untrusted projects do not load project APPEND_SYSTEM.md", async () => {
	await withDirs(async (cwd, agentDir) => {
		await mkdir(join(cwd, ".pi"), { recursive: true });
		await writeFile(join(cwd, ".pi", "APPEND_SYSTEM.md"), "PROJECT-APPEND-MARKER\n");
		await writeFile(join(agentDir, "APPEND_SYSTEM.md"), "GLOBAL-APPEND-MARKER\n");
		const runtime = await isolatedRuntime(agentDir);
		const session = await createChildSession({
			env: env(cwd, agentDir, false),
			params,
			depth: 1,
			workTools: ["read"],
			modelRuntime: runtime,
			onResult: () => {},
		});
		try {
			assert.match(session.systemPrompt, /GLOBAL-APPEND-MARKER/);
			assert.doesNotMatch(session.systemPrompt, /PROJECT-APPEND-MARKER/);
		} finally {
			session.dispose();
		}
	});
});

test("child sessions are in-memory", async () => {
	await withDirs(async (cwd, agentDir) => {
		const runtime = await isolatedRuntime(agentDir);
		const session = await createChildSession({
			env: env(cwd, agentDir),
			params,
			depth: 1,
			workTools: ["read"],
			modelRuntime: runtime,
			onResult: () => {},
		});
		try {
			assert.equal(session.sessionFile, undefined);
		} finally {
			session.dispose();
		}
	});
});
