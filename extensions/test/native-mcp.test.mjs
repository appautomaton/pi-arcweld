import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	collapseSystemMessages,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	getCurrentSystemPrompt,
	getCurrentTools,
	InMemoryCredentialStore,
} from "../../build/pi-agent/runtime/node_modules/@earendil-works/pi-ai/dist/index.js";
import {
	createAgentSession,
	createCodemodeExtension,
	createMcpExtension,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "../../build/pi-agent/runtime/node_modules/@earendil-works/pi-coding-agent/dist/index.js";
import { LATEST_PROTOCOL_VERSION } from "../../build/pi-agent/runtime/node_modules/@earendil-works/pi-mcp/dist/index.js";
import { createInMemoryTransportPair } from "../../build/pi-agent/runtime/node_modules/@earendil-works/pi-mcp/dist/testing/index.js";

function fixtureTransport(transports) {
	const pair = createInMemoryTransportPair();
	transports.push(pair.server);
	const schema = { type: "object", properties: {}, required: [] };
	const tools = [
		{
			name: "echo",
			description: "Echo text",
			inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
		},
		{ name: "add_tool", description: "Add a tool to the catalog", inputSchema: schema },
	];
	pair.server.onMessage(async (message) => {
		if (!("id" in message) || !("method" in message)) return;
		let result = {};
		if (message.method === "initialize") {
			result = {
				protocolVersion: LATEST_PROTOCOL_VERSION,
				capabilities: { tools: { listChanged: true } },
				serverInfo: { name: "fixture", version: "1" },
				instructions: "Runtime-discovered server instructions.",
			};
		}
		if (message.method === "tools/list") result = { tools };
		if (message.method === "tools/call") {
			const { name, arguments: args } = message.params;
			if (name === "add_tool") {
				tools.push({ name: "added", description: "Dynamically added tool", inputSchema: schema });
				await pair.server.send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
			}
			const value = name === "echo" ? args.text : name === "added" ? "dynamic result" : "added";
			result = { content: [{ type: "text", text: value }] };
		}
		await pair.server.send({ jsonrpc: "2.0", id: message.id, result });
	});
	void pair.server.start();
	return pair.client;
}

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

test("native MCP keeps declarations and collapsed prompt stable across discovery, catalog changes and resume", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-native-mcp-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	let session;
	const requests = [];
	const transports = [];
	try {
		await writeFile(join(agentDir, "mcp.json"), JSON.stringify({
			mcpServers: {
				fixture: {
					command: process.execPath,
					exposure: "codemode",
					description: "Stable deterministic tool catalog for regression tests.",
				},
			},
		}));
		const faux = fauxProvider({ provider: "native-mcp-probe", api: "faux:native-mcp-probe" });
		const capture = (context) => {
			// Match the current CPA configuration: system-message deltas are collapsed.
			const collapsed = collapseSystemMessages(context);
			requests.push({
				prompt: getCurrentSystemPrompt(collapsed.messages),
				tools: getCurrentTools(collapsed.messages),
				messages: structuredClone(collapsed.messages),
			});
		};
		const scripts = [
			'const matches = await searchTools("echo", { namespace: "fixture" }); text(matches); text(await tools.mcp__fixture__echo({ text: "first echo" }));',
			'text(await tools.mcp__fixture__add_tool({}));',
			'text(await tools.mcp__fixture__added({}));',
			'text(await tools.mcp__fixture__echo({ text: "resumed echo" }));',
		];
		faux.setResponses(scripts.flatMap((code, index) => [
			(context) => {
				capture(context);
				return fauxAssistantMessage(
					fauxToolCall("codemode", { code }, { id: `native-${index}` }),
					{ stopReason: "toolUse" },
				);
			},
			(context) => {
				capture(context);
				return fauxAssistantMessage("done");
			},
		]));
		const credentials = new InMemoryCredentialStore();
		const modelRuntime = await ModelRuntime.create({ credentials, modelsPath: null, refreshOnCreate: false });
		modelRuntime.registerNativeProvider(faux.provider);
		const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
		const open = async (sessionManager) => {
			const loader = new DefaultResourceLoader({
				cwd: agentDir,
				agentDir,
				settingsManager,
				extensionFactories: [createCodemodeExtension(), createMcpExtension({ createTransport: () => fixtureTransport(transports) })],
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				noContextFiles: true,
				systemPrompt: "STABLE_NATIVE_MCP_SYSTEM",
			});
			await loader.reload();
			assert.deepEqual(loader.getExtensions().errors, []);
			const created = await createAgentSession({
				cwd: agentDir,
				agentDir,
				model: faux.getModel(),
				thinkingLevel: "off",
				modelRuntime,
				resourceLoader: loader,
				noTools: "builtin",
				sessionManager,
				settingsManager,
			});
			await created.session.bindExtensions({ mode: "json" });
			return created.session;
		};
		session = await open(SessionManager.inMemory(agentDir));
		await session.prompt("Find and call the echo tool.");
		await session.prompt("Add a tool to the fixture catalog.");
		const deadline = Date.now() + 2000;
		while (!session.getAllTools().some((tool) => tool.name === "mcp__fixture__added") && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		assert.ok(session.getAllTools().some((tool) => tool.name === "mcp__fixture__added"));
		await session.prompt("Call the newly discovered tool.");
		const id = session.sessionId;
		const entries = structuredClone(session.sessionManager.getEntries());
		await session.extensionRunner.emit({ type: "session_shutdown", reason: "resume" });
		session.dispose();
		session = await open(SessionManager.inMemory(agentDir, { id }, entries));
		await session.prompt("Call echo again after resume.");
		assert.equal(requests.length, 8);
		assert.equal(new Set(requests.map((request) => hash(request.prompt))).size, 1, "collapsed system prompt changed");
		assert.equal(new Set(requests.map((request) => hash(request.tools))).size, 1, "declared tool schemas changed");
		assert.deepEqual(requests[0].tools.map((tool) => tool.name), ["codemode"]);
		assert.ok(session.getAllTools().some((tool) => tool.name === "mcp__fixture__echo"));
		const results = session.messages.filter((message) => message.role === "toolResult" && message.toolName === "codemode");
		assert.equal(results.length, 4);
		assert.ok(results.every((message) => !message.isError), "codemode call failed");
		assert.match(JSON.stringify(results[0].content), /first echo/);
		assert.match(JSON.stringify(results[1].content), /added/);
		assert.match(JSON.stringify(results[2].content), /dynamic result/);
		assert.match(JSON.stringify(results[3].content), /resumed echo/);
		assert.deepEqual(requests[1].messages.slice(0, requests[0].messages.length), requests[0].messages);
	} finally {
		if (session) {
			await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			session.dispose();
		}
		await Promise.all(transports.map((transport) => transport.close()));
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		await rm(agentDir, { recursive: true, force: true });
	}
});
