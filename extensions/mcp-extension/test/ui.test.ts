import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { ServerStatus } from "../src/manager.js";
import { McpControlPanel, renderMcpPanel } from "../src/ui.js";

const theme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
	italic: (text: string) => text,
	underline: (text: string) => text,
	inverse: (text: string) => text,
	strikethrough: (text: string) => text,
} as Theme;

function server(overrides: Partial<ServerStatus> = {}): ServerStatus {
	return {
		name: "context7",
		transport: "streamable-http",
		target: "https://mcp.context7.com",
		status: "ready",
		configuredEnabled: true,
		sessionEnabled: true,
		toolCount: 31,
		stderr: [],
		serverName: "Context7",
		serverVersion: "1.0.0",
		...overrides,
	};
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("MCP control panel", () => {
	it("renders responsive themed rows without exposing secret-bearing config", () => {
		const statuses = [
			server(),
			server({ name: "camoufox", transport: "stdio", target: "camoufox-mcp", status: "disconnected", configuredEnabled: false, sessionEnabled: false, toolCount: 0, serverName: undefined, serverVersion: undefined }),
			server({ name: "cloudflare", target: "https://mcp.cloudflare.com", status: "error", toolCount: 0, lastError: "HTTP 401 [redacted]" }),
		];
		for (const width of [48, 90]) {
			const lines = renderMcpPanel(width, theme, statuses, 1, "/tmp/agent/mcp.json", { busy: false });
			assert.ok(lines.every((line) => visibleWidth(line) <= width));
			const text = lines.join("\n");
			assert.match(text, /MCP Servers/);
			assert.match(text, /camoufox/);
			assert.match(text, /Current session: disabled/);
			assert.match(text, /Default for future sessions: disabled/);
			assert.ok(!text.includes("Authorization"));
			assert.ok(!text.includes("CLOUDFLARE_API_TOKEN"));
		}
	});

	it("keeps large server lists in a bounded viewport around the selection", () => {
		const statuses = Array.from({ length: 15 }, (_, index) => server({ name: `server-${index}` }));
		const text = renderMcpPanel(80, theme, statuses, 12, "/tmp/agent/mcp.json", { busy: false }).join("\n");
		assert.match(text, /Showing 6-15 of 15 servers/);
		assert.match(text, /server-12/);
		assert.ok(!text.includes("server-0"));
	});

	it("strips terminal controls from server errors", () => {
		const text = renderMcpPanel(80, theme, [server({ status: "error", lastError: "bad[31m\nmessage" })], 0, "/tmp/agent/mcp.json", { busy: false }).join("\n");
		assert.ok(!text.includes(""));
		assert.match(text, /Last error: bad message/);
	});

	it("handles navigation, session actions, reconnect guards, and durable confirmation", async () => {
		const statuses = [
			server(),
			server({ name: "camoufox", transport: "stdio", target: "camoufox-mcp", status: "disconnected", configuredEnabled: false, sessionEnabled: false, toolCount: 0 }),
		];
		const calls: string[] = [];
		let closed = false;
		let renders = 0;
		const panel = new McpControlPanel(
			{ requestRender: () => { renders++; } } as never,
			theme,
			() => { closed = true; },
			"/tmp/agent/mcp.json",
			() => statuses,
			{
				enable: async (name) => { calls.push(`enable:${name}`); statuses[1].sessionEnabled = true; statuses[1].status = "ready"; },
				disable: async (name) => { calls.push(`disable:${name}`); statuses[0].sessionEnabled = false; statuses[0].status = "disconnected"; },
				reconnect: async (name) => { calls.push(`reconnect:${name}`); },
				setDefault: async (name, enabled) => { calls.push(`default:${name}:${enabled}`); statuses[1].configuredEnabled = enabled; },
			},
		);

		panel.handleInput("\x1b[B");
		panel.handleInput("r");
		assert.equal(calls.length, 0, "disabled server must not reconnect implicitly");
		assert.match(panel.render(80).join("\n"), /Enable this server/);

		panel.handleInput("\r");
		await tick();
		assert.deepEqual(calls, ["enable:camoufox"]);

		panel.handleInput("d");
		assert.match(panel.render(80).join("\n"), /Change the future-session default/);
		panel.handleInput("\r");
		assert.deepEqual(calls, ["enable:camoufox"], "enter must not confirm a persistent change");
		panel.handleInput("y");
		await tick();
		assert.deepEqual(calls, ["enable:camoufox", "default:camoufox:true"]);

		panel.handleInput("r");
		await tick();
		assert.deepEqual(calls, ["enable:camoufox", "default:camoufox:true", "reconnect:camoufox"]);
		panel.handleInput("\x1b");
		assert.equal(closed, true);
		assert.ok(renders > 0);
	});
});
