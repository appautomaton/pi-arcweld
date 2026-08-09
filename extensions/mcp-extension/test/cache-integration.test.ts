import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	InMemoryCredentialStore,
	type Context,
} from "@earendil-works/pi-ai";
import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixturePath = resolve(packageRoot, "test/fixture-server.ts");

interface RequestSnapshot {
	systemHash: string;
	toolsHash: string;
	toolNames: string[];
	messages: string;
	systemPrompt: string;
}

test("loads as a real Pi package and preserves request prefixes across MCP continuations", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-mcp-cache-integration-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	await writeFile(join(agentDir, "mcp.json"), JSON.stringify({
		servers: {
			fixture: {
				transport: "stdio",
				command: process.execPath,
				args: ["--import", "tsx", fixturePath],
			},
		},
	}));

	const faux = fauxProvider({
		provider: "mcp-cache-probe",
		api: "faux:mcp-cache-probe",
		models: [{ id: "mcp-cache-probe", reasoning: false }],
	});
	const snapshots: RequestSnapshot[] = [];
	const capture = (context: Context) => {
		const systemPrompt = context.systemPrompt ?? "";
		const tools = (context.tools ?? []).map((tool) => ({
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters,
		}));
		snapshots.push({
			systemHash: hash(systemPrompt),
			toolsHash: hash(JSON.stringify(tools)),
			toolNames: tools.map((tool) => tool.name),
			messages: JSON.stringify(context.messages),
			systemPrompt,
		});
	};
	faux.setResponses([
		(context) => {
			capture(context);
			return fauxAssistantMessage(
				fauxToolCall("call_mcp_tool", { server: "fixture", tool: "add_tool", arguments: {} }, { id: "call-add-tool" }),
				{ stopReason: "toolUse" },
			);
		},
		(context) => {
			capture(context);
			return fauxAssistantMessage("catalog changed");
		},
		(context) => {
			capture(context);
			return fauxAssistantMessage(
				fauxToolCall("mcp", { action: "search", query: "echo" }, { id: "search-tools" }),
				{ stopReason: "toolUse" },
			);
		},
		(context) => {
			capture(context);
			return fauxAssistantMessage("search complete");
		},
	]);

	const credentials = new InMemoryCredentialStore();
	await credentials.modify(faux.provider.id, async () => ({ type: "api_key", key: "faux-key" }));
	const modelRuntime = await ModelRuntime.create({ credentials, modelsPath: null, refreshOnCreate: false });
	modelRuntime.registerNativeProvider(faux.provider);
	const settingsManager = SettingsManager.inMemory({
		compaction: { enabled: false },
		retry: { enabled: false },
	});
	const loader = new DefaultResourceLoader({
		cwd: agentDir,
		agentDir,
		settingsManager,
		additionalExtensionPaths: [packageRoot],
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		systemPrompt: "CACHE_PROBE_SYSTEM",
	});
	await loader.reload();
	assert.deepEqual(loader.getExtensions().errors, []);

	const { session } = await createAgentSession({
		cwd: agentDir,
		agentDir,
		model: faux.getModel(),
		thinkingLevel: "off",
		modelRuntime,
		resourceLoader: loader,
		noTools: "builtin",
		sessionManager: SessionManager.inMemory(agentDir),
		settingsManager,
	});
	await session.bindExtensions({
		mode: "rpc",
		uiContext: {
			theme: { fg: (_color: string, text: string) => text },
			setStatus() {},
			notify() {},
			confirm: async () => false,
			custom: async () => undefined,
		} as never,
	});

	try {
		const statusTool = session.agent.state.tools.find((tool) => tool.name === "mcp");
		assert.ok(statusTool);
		const statusResult = await statusTool.execute("status-probe", { action: "status" }, undefined, undefined);
		assert.match(JSON.stringify(statusResult), /fixture/);
		await session.prompt("Change the fixture catalog through MCP.");
		await new Promise((resolve) => setTimeout(resolve, 700));
		await session.prompt("Search the current MCP catalog for echo tools.");

		assert.equal(snapshots.length, 4);
		assert.deepEqual([...new Set(snapshots.map((snapshot) => snapshot.systemHash))].length, 1, "system prompt hash changed");
		assert.deepEqual([...new Set(snapshots.map((snapshot) => snapshot.toolsHash))].length, 1, "tool schema hash changed");
		for (const snapshot of snapshots) {
			assert.deepEqual(snapshot.toolNames, ["mcp", "call_mcp_tool"]);
			assert.match(snapshot.systemPrompt, /^CACHE_PROBE_SYSTEM/);
			assert.doesNotMatch(snapshot.systemPrompt, /MCP routing|MCP capabilities/);
		}
		assert.match(snapshots[0]?.messages ?? "", /mcp-capability-snapshot|fixture: 8 tools/);
		assert.match(snapshots[1]?.messages ?? "", /call_mcp_tool/);
		assert.match(snapshots[2]?.messages ?? "", /fixture's catalog changed; 9 tools/);
		assert.match(snapshots[3]?.messages ?? "", /search_tools|matching tools/);
	} finally {
		await session.prompt("/mcp disable fixture").catch(() => {});
		session.dispose();
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		await rm(agentDir, { recursive: true, force: true });
	}
});

function hash(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}
