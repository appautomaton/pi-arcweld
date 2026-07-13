import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const fixturePath = fileURLToPath(new URL("./fixture-server.ts", import.meta.url));
const theme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
	italic: (text: string) => text,
	underline: (text: string) => text,
	inverse: (text: string) => text,
	strikethrough: (text: string) => text,
};

// Drives the extension surface with a stubbed pi API. Runs in its own test file
// so the PI_CODING_AGENT_DIR mutation stays isolated in this process.
test("keeps tools and the frozen summary stable while runtime changes append", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-mcp-freeze-"));
	await writeFile(
		join(dir, "mcp.json"),
		JSON.stringify({
			servers: {
				fixture: { transport: "stdio", command: process.execPath, args: ["--import", "tsx", fixturePath] },
				broken: { transport: "stdio", command: "/definitely/missing/mcp-server" },
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
	const branch: Array<{ type: "custom"; customType: string; data: unknown }> = [];
	const ctx = {
		ui,
		hasUI: true,
		mode: "tui",
		sessionManager: { getBranch: () => branch },
	};
	const fire = async (event: string, payload: unknown = {}) => {
		let result: unknown;
		for (const handler of handlers.get(event) ?? []) result = await handler(payload, ctx);
		return result as { systemPrompt?: string; message?: { content?: string } } | undefined;
	};

	mcpExtension({
		on: (event: string, handler: never) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
		registerTool: (tool: any) => (tools[tool.name] = tool),
		registerCommand: (_name: string, options: never) => { command = options; },
		appendEntry: (customType: string, data: unknown) => branch.push({ type: "custom", customType, data }),
	} as never);
	assert.deepEqual(Object.keys(tools), ["mcp", "mcp_call"]);
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
		const frozen = turn1?.systemPrompt;
		assert.ok(frozen, "turn 1 must return a system prompt override");
		assert.ok(frozen.startsWith("BASE\n\n"));
		assert.ok(frozen.includes("fixture: 8 tools"));
		assert.ok(!frozen.includes("ENOENT"), "broken-server error must not leak into the summary");
		assert.match(extensionStatuses.get("mcp") ?? "", /MCP:\s*1\/2\s*!1/, "compact footers must be able to parse MCP health");

		const turn2 = await fire("before_agent_start", { systemPrompt: "BASE" });
		assert.equal(turn2?.systemPrompt, frozen, "system prompt must be byte-identical across turns");
		assert.equal(turn2?.message, undefined);

		assert.ok(command);
		await command.handler("disable fixture", ctx);
		const turn3 = await fire("before_agent_start", { systemPrompt: "BASE" });
		assert.equal(turn3?.systemPrompt, frozen);
		assert.match(turn3?.message?.content ?? "", /fixture is disabled for this session/);

		const turn4 = await fire("before_agent_start", { systemPrompt: "BASE" });
		assert.equal(turn4?.systemPrompt, frozen);
		assert.equal(turn4?.message, undefined, "session disable must be announced exactly once");

		await command.handler("enable fixture", ctx);
		const turn5 = await fire("before_agent_start", { systemPrompt: "BASE" });
		assert.equal(turn5?.systemPrompt, frozen);
		assert.match(turn5?.message?.content ?? "", /fixture is enabled for this session/);
		assert.ok(!(turn5?.message?.content ?? "").includes("catalog changed"), "an identical reconnect must not announce a catalog change");

		// Mutate the live catalog through the real tool surface, then let the
		// list_changed debounce and refresh land.
		await tools.mcp_call.execute("t1", { server: "fixture", tool: "add_tool", arguments: {} });
		await new Promise((resolve) => setTimeout(resolve, 700));

		const turn6 = await fire("before_agent_start", { systemPrompt: "BASE" });
		assert.equal(turn6?.systemPrompt, frozen, "system prompt must stay frozen after a catalog change");
		assert.match(turn6?.message?.content ?? "", /fixture's catalog changed; 9 tools/);

		const turn7 = await fire("before_agent_start", { systemPrompt: "BASE" });
		assert.equal(turn7?.systemPrompt, frozen);
		assert.equal(turn7?.message, undefined, "a catalog change must be announced exactly once");
		assert.equal(JSON.stringify(Object.values(tools).map((tool: any) => ({
			name: tool.name,
			description: tool.description,
			promptSnippet: tool.promptSnippet,
			promptGuidelines: tool.promptGuidelines,
			parameters: tool.parameters,
		}))), toolDefinitions, "model-facing tool definitions must stay byte-stable");

		await command.handler("disable fixture", ctx);
		const turn8 = await fire("before_agent_start", { systemPrompt: "BASE" });
		assert.equal(turn8?.systemPrompt, frozen);
		assert.match(turn8?.message?.content ?? "", /fixture is disabled for this session/);
		await fire("session_shutdown");
		await fire("session_start");
		const resumed = await fire("before_agent_start", { systemPrompt: "BASE" });
		assert.equal(resumed?.systemPrompt, frozen, "resumed sessions must restore the exact frozen summary");
		assert.equal(resumed?.message, undefined, "restored runtime state must not be re-announced");
		await command.handler("status", ctx);
		assert.match(notifications.at(-1) ?? "", /fixture: off/);
		assert.ok(notifications.some((text) => text.includes("disable complete")));
	} finally {
		await fire("session_shutdown");
	}
});
