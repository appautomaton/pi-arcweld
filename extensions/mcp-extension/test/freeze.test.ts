import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const fixturePath = fileURLToPath(new URL("./fixture-server.ts", import.meta.url));
const markerColors: string[] = [];
const theme = {
	fg: (color: string, text: string) => {
		if (text === "○") markerColors.push(color);
		return text;
	},
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
	italic: (text: string) => text,
	underline: (text: string) => text,
	inverse: (text: string) => text,
	strikethrough: (text: string) => text,
};

interface CustomStateEntry {
	type: "custom";
	customType: string;
	data: unknown;
}

interface CustomMessageEntry {
	type: "custom_message";
	customType: string;
	content: string;
	display: boolean;
}

type TestEntry = CustomStateEntry | CustomMessageEntry;

test("keeps the system prompt and tools fixed while MCP context only appends", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-mcp-freeze-"));
	await writeFile(
		join(dir, "mcp.json"),
		JSON.stringify({
			servers: {
				fixture: { transport: "stdio", command: process.execPath, args: ["--import", "tsx", fixturePath] },
				broken: { transport: "stdio", command: "/definitely/missing/mcp-server" },
				off: { enabled: false, transport: "stdio", command: process.execPath, args: ["--import", "tsx", fixturePath] },
			},
		}),
	);
	process.env.PI_CODING_AGENT_DIR = dir;
	const { default: mcpExtension } = await import("../src/index.js");

	const handlers = new Map<string, ((event: unknown, ctx: unknown) => Promise<unknown>)[]>();
	const tools: Record<string, any> = {};
	let command: { handler: (args: string, ctx: unknown) => Promise<void>; getArgumentCompletions?: (prefix: string) => unknown } | undefined;
	const notifications: string[] = [];
	const extensionStatuses = new Map<string, string>();
	const entries: TestEntry[] = [];
	let activeEntries = () => entries;
	const ui = {
		theme,
		setStatus(key: string, text: string | undefined) {
			if (text === undefined) extensionStatuses.delete(key);
			else extensionStatuses.set(key, text);
		},
		setWidget() {},
		notify(text: string) { notifications.push(text); },
		confirm: async () => false,
		custom: async () => undefined,
	};
	const ctx = {
		ui,
		hasUI: true,
		mode: "tui",
		sessionManager: {
			getBranch: () => entries,
			buildContextEntries: () => activeEntries(),
		},
	};
	const fire = async (event: string, payload: unknown = {}) => {
		let result: unknown;
		for (const handler of handlers.get(event) ?? []) result = await handler(payload, ctx);
		const typed = result as { systemPrompt?: string; message?: { customType: string; content: string; display: boolean } } | undefined;
		if (event === "before_agent_start" && typed?.message) {
			entries.push({ type: "custom_message", ...typed.message });
		}
		return typed;
	};

	mcpExtension({
		on: (event: string, handler: never) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
		registerTool: (tool: any) => (tools[tool.name] = tool),
		registerCommand: (_name: string, options: never) => { command = options; },
		appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
	} as never);
	assert.deepEqual(Object.keys(tools), ["mcp", "call_mcp_tool"]);
	const toolDefinitions = JSON.stringify(Object.values(tools).map((tool: any) => ({
		name: tool.name,
		description: tool.description,
		promptSnippet: tool.promptSnippet,
		promptGuidelines: tool.promptGuidelines,
		parameters: tool.parameters,
	})));

	await fire("session_start");
	try {
		const turn1 = await fire("before_agent_start", { systemPrompt: "BASE" });
		assert.equal(turn1?.systemPrompt, undefined, "MCP must never modify the system prompt");
		assert.equal(turn1?.message?.customType, "mcp-capability-snapshot");
		const snapshot = turn1?.message?.content ?? "";
		assert.ok(snapshot.includes("fixture: 8 tools"));
		assert.ok(!snapshot.includes("ENOENT"), "broken-server error must not leak into the snapshot");
		assert.match(extensionStatuses.get("mcp") ?? "", /MCP:\s*1\/2\s*!1\s*·\s*1 off/, "disabled servers must be reported separately from enabled-server health");

		const turn2 = await fire("before_agent_start", { systemPrompt: "BASE" });
		assert.equal(turn2, undefined, "the active context must not receive a duplicate snapshot");

		assert.ok(command);
		await command.handler("disable fixture", ctx);
		const turn3 = await fire("before_agent_start", { systemPrompt: "BASE" });
		assert.equal(turn3?.systemPrompt, undefined);
		assert.equal(turn3?.message?.customType, "mcp-runtime-update");
		assert.match(turn3?.message?.content ?? "", /fixture is disabled for this session/);

		const turn4 = await fire("before_agent_start", { systemPrompt: "BASE" });
		assert.equal(turn4, undefined, "session disable must be announced exactly once");

		await command.handler("disable broken", ctx);
		assert.match(extensionStatuses.get("mcp") ?? "", /MCP:\s*3 off/, "an all-disabled session must not render an empty health ratio");
		assert.equal(markerColors.at(-1), "dim", "an all-disabled session is neutral rather than degraded");
		const allOffSearch = await tools.mcp.execute("search-all-off", { action: "search", query: "echo" });
		const allOffSearchText = allOffSearch.content.map((block: { type: string; text?: string }) => block.type === "text" ? block.text ?? "" : "").join("\n");
		assert.match(allOffSearchText, /no MCP servers enabled for this session/);
		assert.match(allOffSearchText, /Enable a server with \/mcp before searching/);
		assert.doesNotMatch(allOffSearchText, /0\/0/);
		const allOffUpdate = await fire("before_agent_start", { systemPrompt: "BASE" });
		assert.match(allOffUpdate?.message?.content ?? "", /broken is disabled for this session/);

		await command.handler("enable fixture", ctx);
		const turn5 = await fire("before_agent_start", { systemPrompt: "BASE" });
		assert.equal(turn5?.systemPrompt, undefined);
		assert.match(turn5?.message?.content ?? "", /fixture is enabled for this session/);
		assert.ok(!(turn5?.message?.content ?? "").includes("catalog changed"), "an identical reconnect must not announce a catalog change");

		await tools.call_mcp_tool.execute("t1", { server: "fixture", tool: "add_tool", arguments: {} });
		await new Promise((resolve) => setTimeout(resolve, 700));
		const turn6 = await fire("before_agent_start", { systemPrompt: "BASE" });
		assert.equal(turn6?.systemPrompt, undefined);
		assert.match(turn6?.message?.content ?? "", /fixture's catalog changed; 9 tools/);

		const turn7 = await fire("before_agent_start", { systemPrompt: "BASE" });
		assert.equal(turn7, undefined, "a catalog change must be announced exactly once");
		assert.equal(JSON.stringify(Object.values(tools).map((tool: any) => ({
			name: tool.name,
			description: tool.description,
			promptSnippet: tool.promptSnippet,
			promptGuidelines: tool.promptGuidelines,
			parameters: tool.parameters,
		}))), toolDefinitions, "model-facing tool definitions must stay byte-stable");

		activeEntries = () => entries.filter((entry) => entry.type !== "custom_message" || entry.customType !== "mcp-capability-snapshot");
		const afterCompaction = await fire("before_agent_start", { systemPrompt: "BASE" });
		assert.equal(afterCompaction?.systemPrompt, undefined);
		assert.equal(afterCompaction?.message?.customType, "mcp-capability-snapshot");
		assert.equal(afterCompaction?.message?.content, snapshot, "compaction recovery must append the exact original snapshot");
		activeEntries = () => entries;
		assert.equal(await fire("before_agent_start", { systemPrompt: "BASE" }), undefined, "the reinserted snapshot must not repeat");

		await command.handler("disable fixture", ctx);
		const turn8 = await fire("before_agent_start", { systemPrompt: "BASE" });
		assert.equal(turn8?.systemPrompt, undefined);
		assert.match(turn8?.message?.content ?? "", /fixture is disabled for this session/);
		await fire("session_shutdown");
		await fire("session_start");
		const resumed = await fire("before_agent_start", { systemPrompt: "BASE" });
		assert.equal(resumed, undefined, "reload/resume must restore state without duplicating active context");
		await command.handler("status", ctx);
		assert.match(notifications.at(-1) ?? "", /fixture: off/);
		assert.ok(notifications.some((text) => text.includes("disable complete")));
	} finally {
		await fire("session_shutdown");
	}
});
