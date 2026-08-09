import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { loadConfig, setServerDefaultEnabled } from "./config.js";
import { McpManager, type ServerStatus } from "./manager.js";
import { convertMcpResult, guardTextOutput } from "./output.js";
import {
	activeContextHasCapabilitySnapshot,
	capabilitySnapshotMessage,
	collectRuntimeUpdate,
	persistSessionState,
	restoreSessionState,
	runtimeUpdateMessage,
	snapshotRuntime,
	type ReportedRuntime,
} from "./session-context.js";
import { openMcpControlPanel } from "./ui.js";

const CatalogParams = Type.Object({
	action: StringEnum(["status", "list", "search", "describe"] as const),
	server: Type.Optional(Type.String({ description: "Configured MCP server name; omit for cross-server search" })),
	tool: Type.Optional(Type.String({ description: "Exact MCP tool name for describe" })),
	query: Type.Optional(Type.String({ description: "Literal name/description query for search" })),
	cursor: Type.Optional(Type.String({ description: "Cursor returned by a previous list/search call" })),
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, description: "Results per page (default 50)" })),
});

const CallParams = Type.Object({
	server: Type.String({ description: "Configured MCP server name" }),
	tool: Type.String({ description: "Exact MCP tool name" }),
	arguments: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "Tool arguments" })),
});

export default function mcpExtension(pi: ExtensionAPI) {
	let manager: McpManager | undefined;
	let configPath = "";
	let activePanelRefresh: (() => void) | undefined;
	// Dynamic MCP metadata is appended as hidden session messages. The system
	// prompt and the two public tool definitions remain byte-stable.
	let capabilitySnapshot: string | undefined;
	let reportedRuntime: Record<string, ReportedRuntime> = {};
	let lifecycleGeneration = 0;

	pi.on("session_start", async (_event, ctx) => {
		const generation = ++lifecycleGeneration;
		const previous = manager;
		manager = undefined;
		activePanelRefresh = undefined;
		await previous?.shutdown();
		const restored = restoreSessionState(ctx);
		capabilitySnapshot = restored?.summary;
		reportedRuntime = restored?.runtime ?? {};
		try {
			const config = await loadConfig();
			if (generation !== lifecycleGeneration) return;
			configPath = config.path;
			let current: McpManager;
			const renderStatus = () => {
				if (manager !== current) return;
				ctx.ui.setStatus("mcp", formatStatusBar(current, ctx.ui.theme));
				activePanelRefresh?.();
			};
			current = new McpManager(config, renderStatus);
			if (restored) current.restoreSessionEnabled(Object.fromEntries(Object.entries(restored.runtime).map(([name, value]) => [name, value.sessionEnabled])));
			if (generation !== lifecycleGeneration) {
				await current.shutdown();
				return;
			}
			manager = current;
			renderStatus();
			void current.warmup();
		} catch (error) {
			if (generation !== lifecycleGeneration) return;
			manager = undefined;
			ctx.ui.setStatus("mcp", ctx.ui.theme.fg("error", "! MCP config error"));
			ctx.ui.notify(`MCP config error: ${safeMessage(error)}`, "error");
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		++lifecycleGeneration;
		const current = manager;
		manager = undefined;
		activePanelRefresh = undefined;
		ctx.ui.setStatus("mcp", undefined);
		await current?.shutdown();
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		const current = manager;
		const generation = lifecycleGeneration;
		if (!current) return;
		if (capabilitySnapshot === undefined) {
			await current.waitForWarmup();
			if (manager !== current || generation !== lifecycleGeneration) return;
			capabilitySnapshot = current.capabilitySummary();
			reportedRuntime = snapshotRuntime(current);
			persistSessionState(pi, capabilitySnapshot, reportedRuntime);
		}
		if (!activeContextHasCapabilitySnapshot(ctx, capabilitySnapshot)) {
			return { message: capabilitySnapshotMessage(capabilitySnapshot) };
		}
		const update = collectRuntimeUpdate(current, reportedRuntime);
		if (!update) return;
		persistSessionState(pi, capabilitySnapshot, reportedRuntime);
		return { message: runtimeUpdateMessage(update) };
	});

	pi.registerTool({
		name: "mcp",
		label: "MCP Catalog",
		description: "Inspect MCP capabilities. Search ranks tools across all ready servers when server is omitted; list and describe provide deterministic exact discovery.",
		promptSnippet: "Search MCP capabilities across servers, or list and describe exact tools",
		promptGuidelines: ["Use mcp search when an external capability in the MCP summary may help; use describe before calling an unfamiliar exact tool."],
		parameters: CatalogParams,
		async execute(_toolCallId, params, signal) {
			const current = requireManager(manager);
			if (params.action === "status") {
				return guardedResult(formatStatus(current), { action: "status" });
			}
			if (params.action === "search") {
				if (!params.query) throw new Error("search requires query");
				const result = await current.search(params.server, params.query, params.cursor, params.limit, signal);
				return guardedResult(formatMatches(result), { action: "search", server: params.server, query: params.query, total: result.total, nextCursor: result.nextCursor });
			}
			if (!params.server) throw new Error(`${params.action} requires server`);
			if (params.action === "list") {
				const result = await current.list(params.server, params.cursor, params.limit, signal);
				return guardedResult(formatTools(params.server, result), { action: "list", server: params.server, total: result.total, nextCursor: result.nextCursor });
			}
			if (!params.tool) throw new Error("describe requires tool");
			const tool = await current.describe(params.server, params.tool, signal);
			return guardedResult(JSON.stringify(tool, null, 2), { action: "describe", server: params.server, tool: params.tool });
		},
	});

	pi.registerTool({
		name: "call_mcp_tool",
		label: "MCP Call",
		description: "Call an exact tool on a configured MCP server. Use mcp search and describe first when the capability or schema is unknown.",
		promptSnippet: "Call an exact MCP tool with an arguments object",
		promptGuidelines: ["Use call_mcp_tool only with an exact server/tool pair and arguments learned from mcp describe or the capability summary."],
		parameters: CallParams,
		async execute(_toolCallId, params, signal) {
			const result = await requireManager(manager).call(params.server, params.tool, params.arguments ?? {}, signal);
			const converted = await convertMcpResult(result);
			return {
				content: converted.content,
				details: { server: params.server, tool: params.tool, ...converted.details },
			};
		},
	});

	pi.registerCommand("mcp", {
		description: "Manage MCP servers",
		getArgumentCompletions: (prefix) => commandCompletions(prefix, manager?.status() ?? []),
		handler: async (args, ctx) => {
			const current = manager;
			if (!current) {
				ctx.ui.notify(`MCP is not initialized${configPath ? ` (${configPath})` : ""}`, "error");
				return;
			}
			const tokens = args.trim() ? args.trim().split(/\s+/) : [];
			if (tokens.length === 0) {
				await openMcpControlPanel(ctx, configPath, () => current.status(), {
					enable: (server) => current.enableForSession(server),
					disable: (server) => current.disableForSession(server),
					reconnect: (server) => current.reconnect(server),
					setDefault: async (server, enabled) => {
						await setServerDefaultEnabled(configPath, server, enabled);
						current.setConfiguredEnabled(server, enabled);
					},
				}, { setRefresh: (refresh) => { activePanelRefresh = refresh; } });
				return;
			}
			await runMcpCommand(tokens, ctx, current, configPath);
		},
	});
}

async function runMcpCommand(tokens: string[], ctx: ExtensionCommandContext, manager: McpManager, configPath: string): Promise<void> {
	if (tokens.length === 1 && tokens[0] === "status") {
		ctx.ui.notify(formatStatus(manager), "info");
		return;
	}
	if (tokens.length === 2 && ["enable", "disable", "reconnect"].includes(tokens[0])) {
		const [action, server] = tokens;
		try {
			if (action === "enable") await manager.enableForSession(server);
			else if (action === "disable") await manager.disableForSession(server);
			else await manager.reconnect(server);
			ctx.ui.notify(`${server}: ${action} complete`, "info");
		} catch (error) {
			ctx.ui.notify(safeMessage(error), "error");
		}
		return;
	}
	if (tokens.length === 3 && tokens[0] === "set-default" && ["enabled", "disabled"].includes(tokens[2])) {
		const server = tokens[1];
		const enabled = tokens[2] === "enabled";
		if (!manager.status().some((status) => status.name === server)) {
			ctx.ui.notify(`Unknown MCP server: ${server}`, "error");
			return;
		}
		if (!ctx.hasUI) {
			ctx.ui.notify("Changing an MCP default requires TUI confirmation", "error");
			return;
		}
		const confirmed = await ctx.ui.confirm(
			`Change future-session default for ${server}?`,
			`Set ${server} to ${enabled ? "enabled" : "disabled"} by default in ${configPath}?\nThis does not change the current session and writes only the raw enabled setting.`,
		);
		if (!confirmed) return;
		try {
			await setServerDefaultEnabled(configPath, server, enabled);
			manager.setConfiguredEnabled(server, enabled);
			ctx.ui.notify(`${server}: future-session default is now ${enabled ? "enabled" : "disabled"}`, "info");
		} catch (error) {
			ctx.ui.notify(safeMessage(error), "error");
		}
		return;
	}
	ctx.ui.notify(`Usage: /mcp [status | enable <server> | disable <server> | reconnect <server> | set-default <server> enabled|disabled]`, "error");
}

function commandCompletions(prefix: string, statuses: ServerStatus[]): AutocompleteItem[] | null {
	const trimmed = prefix.trimStart();
	const commands: AutocompleteItem[] = [
		{ value: "status", label: "status", description: "Show current MCP server state" },
		{ value: "enable", label: "enable", description: "Enable a server for this session" },
		{ value: "disable", label: "disable", description: "Disable a server for this session" },
		{ value: "reconnect", label: "reconnect", description: "Restart a server connection" },
		{ value: "set-default", label: "set-default", description: "Change a server's future-session default" },
	];
	if (!trimmed.includes(" ")) return commands.filter((item) => item.value.startsWith(trimmed));
	const tokens = trimmed.split(/\s+/);
	const action = tokens[0];
	if (["enable", "disable", "reconnect", "set-default"].includes(action) && tokens.length <= 2) {
		const partial = tokens[1] ?? "";
		return statuses.filter((status) => status.name.startsWith(partial)).map((status) => ({
			value: `${action} ${status.name}`,
			label: status.name,
			description: statusDescription(status),
		}));
	}
	if (action === "set-default" && tokens.length === 3) {
		const server = tokens[1];
		const partial = tokens[2] ?? "";
		return ["enabled", "disabled"].filter((value) => value.startsWith(partial)).map((value) => ({
			value: `set-default ${server} ${value}`,
			label: value,
			description: `Use ${value} as the default in future Pi sessions`,
		}));
	}
	return null;
}

function requireManager(manager: McpManager | undefined): McpManager {
	if (!manager) throw new Error("MCP is not initialized; check the user-global MCP config and reload Pi");
	return manager;
}

function formatStatusBar(manager: McpManager, theme: Theme): string | undefined {
	const statuses = manager.status();
	if (statuses.length === 0) return undefined;
	const enabled = statuses.filter((server) => server.sessionEnabled);
	const ready = statuses.filter((server) => server.sessionEnabled && server.status === "ready").length;
	const off = statuses.filter((server) => !server.sessionEnabled).length;
	const errors = statuses.filter((server) => server.sessionEnabled && server.status === "error").length;
	const marker = errors
		? theme.fg("error", "!")
		: ready > 0
			? theme.fg("success", "●")
			: enabled.length === 0
				? theme.fg("dim", "○")
				: theme.fg("warning", "○");
	const health = enabled.length === 0
		? `${off} off`
		: `${ready}/${enabled.length}${errors ? ` !${errors}` : ""}${off ? ` · ${off} off` : ""}`;
	return `${marker}${theme.fg("dim", ` MCP: ${health}`)}`;
}

function formatStatus(manager: McpManager): string {
	const statuses = manager.status();
	if (statuses.length === 0) return "No MCP servers configured.";
	return statuses.map((server) => {
		const state = server.sessionEnabled ? server.status : "off";
		const error = server.lastError ? ` — ${server.lastError}` : "";
		return `${server.name}: ${state}, ${server.toolCount} tools, ${server.transport}, default ${server.configuredEnabled ? "enabled" : "disabled"}${error}`;
	}).join("\n");
}

function statusDescription(status: ServerStatus): string {
	const state = status.sessionEnabled ? status.status : "off";
	return `${state} · ${status.toolCount} tools · default ${status.configuredEnabled ? "enabled" : "disabled"}`;
}

function formatTools(server: string, result: { tools: Array<{ name: string; description?: string }>; total: number; nextCursor?: string }): string {
	const lines = [`${server}: ${result.total} catalog tools`];
	for (const tool of result.tools) lines.push(`- ${tool.name}${tool.description ? ` — ${tool.description}` : ""}`);
	if (result.nextCursor) lines.push(`Next cursor: ${result.nextCursor}`);
	return lines.join("\n");
}

function formatMatches(result: { tools: Array<{ server: string; name: string; description?: string; score: number }>; total: number; nextCursor?: string; readyServers?: number; totalServers?: number }): string {
	const enabledServers = result.totalServers ?? 0;
	const serverHealth = enabledServers === 0
		? "no MCP servers enabled for this session"
		: `${result.readyServers ?? 0}/${enabledServers} session-enabled servers ready`;
	const lines = [`${result.total} matching tools; ${serverHealth}`];
	for (const tool of result.tools) lines.push(`- ${tool.server}/${tool.name}${tool.description ? ` — ${tool.description}` : ""} (score ${tool.score})`);
	if (result.nextCursor) lines.push(`Next cursor: ${result.nextCursor}`);
	if (result.total === 0) lines.push(enabledServers === 0
		? "Enable a server with /mcp before searching."
		: "No tool matched the query; use mcp list on a likely server or try broader capability keywords.");
	return lines.join("\n");
}

async function guardedResult(text: string, details: Record<string, unknown>) {
	const guarded = await guardTextOutput(text);
	return { content: guarded.content, details: { ...details, ...guarded.details } };
}

function safeMessage(error: unknown): string {
	const value = error instanceof Error ? error.message : String(error);
	return value
		.replace(/\u001B(?:\[[0-?]*[ -/]*[@-~]|[@-_])/g, "")
		.replace(/[\u0000-\u001F\u007F-\u009F]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}
