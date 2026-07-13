import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { loadConfig, setServerDefaultEnabled } from "./config.js";
import { type CatalogFingerprint, McpManager, type ServerStatus } from "./manager.js";
import { convertMcpResult, guardTextOutput } from "./output.js";
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

interface ReportedRuntime {
	sessionEnabled: boolean;
	fingerprint?: string;
}

interface PersistedMcpSnapshot {
	summary: string;
	runtime: Record<string, ReportedRuntime>;
}

export default function mcpExtension(pi: ExtensionAPI) {
	let manager: McpManager | undefined;
	let configPath = "";
	let activePanelRefresh: (() => void) | undefined;
	// The capability summary is rendered once and reused verbatim every turn.
	// The system prompt sits ahead of the whole conversation in the provider
	// prompt-cache prefix, so re-rendering it from live connection state would
	// re-bill the entire context on every status flicker. Runtime changes reach
	// the model only as append-only custom messages.
	let frozenSummary: string | undefined;
	let reportedRuntime: Record<string, ReportedRuntime> = {};
	let lifecycleGeneration = 0;

	pi.on("session_start", async (_event, ctx) => {
		const generation = ++lifecycleGeneration;
		const previous = manager;
		manager = undefined;
		activePanelRefresh = undefined;
		await previous?.shutdown();
		const restored = restoreSnapshot(ctx);
		frozenSummary = restored?.summary;
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

	pi.on("before_agent_start", async (event) => {
		const current = manager;
		const generation = lifecycleGeneration;
		if (!current) return;
		if (frozenSummary === undefined) {
			await current.waitForWarmup();
			if (manager !== current || generation !== lifecycleGeneration) return;
			frozenSummary = current.capabilitySummary();
			reportedRuntime = snapshotRuntime(current);
			persistSnapshot(pi, frozenSummary, reportedRuntime);
			if (frozenSummary) return { systemPrompt: `${event.systemPrompt}\n\n${frozenSummary}` };
			return;
		}
		const update = collectRuntimeUpdate(current, reportedRuntime);
		if (update) persistSnapshot(pi, frozenSummary, reportedRuntime);
		if (!frozenSummary && !update) return;
		return {
			...(frozenSummary ? { systemPrompt: `${event.systemPrompt}\n\n${frozenSummary}` } : {}),
			...(update ? { message: { customType: "mcp-runtime-update", content: update, display: false } } : {}),
		};
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
		name: "mcp_call",
		label: "MCP Call",
		description: "Call an exact tool on a configured MCP server. Use mcp search and describe first when the capability or schema is unknown.",
		promptSnippet: "Call an exact MCP tool with an arguments object",
		promptGuidelines: ["Use mcp_call only with an exact server/tool pair and arguments learned from mcp describe or the capability summary."],
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

function restoreSnapshot(ctx: ExtensionContext): PersistedMcpSnapshot | undefined {
	let restored: PersistedMcpSnapshot | undefined;
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "custom" || entry.customType !== "mcp-session-snapshot") continue;
		const data = entry.data as PersistedMcpSnapshot | undefined;
		if (data && typeof data.summary === "string" && data.runtime && typeof data.runtime === "object") restored = data;
	}
	return restored;
}

function persistSnapshot(pi: ExtensionAPI, summary: string, runtime: Record<string, ReportedRuntime>): void {
	pi.appendEntry<PersistedMcpSnapshot>("mcp-session-snapshot", {
		summary,
		runtime: Object.fromEntries(Object.entries(runtime).map(([name, value]) => [name, { ...value }])),
	});
}

function snapshotRuntime(manager: McpManager): Record<string, ReportedRuntime> {
	const fingerprints = manager.catalogFingerprints();
	return Object.fromEntries(manager.status().map((status) => [status.name, {
		sessionEnabled: status.sessionEnabled,
		fingerprint: fingerprints[status.name]?.signature,
	}]));
}

function collectRuntimeUpdate(manager: McpManager, reported: Record<string, ReportedRuntime>): string | undefined {
	const notes: string[] = [];
	const fingerprints = manager.catalogFingerprints();
	for (const status of manager.status()) {
		const previous = reported[status.name] ?? { sessionEnabled: status.sessionEnabled };
		if (previous.sessionEnabled !== status.sessionEnabled) {
			notes.push(status.sessionEnabled
				? `${status.name} is enabled for this session; its catalog may still be loading.`
				: `${status.name} is disabled for this session; calls will fail until the user enables it.`);
			previous.sessionEnabled = status.sessionEnabled;
		}
		const fingerprint: CatalogFingerprint | undefined = fingerprints[status.name];
		if (fingerprint?.ready && fingerprint.signature && fingerprint.signature !== previous.fingerprint) {
			notes.push(`${status.name}'s catalog changed; ${fingerprint.toolCount} tools are currently available.`);
			previous.fingerprint = fingerprint.signature;
		}
		reported[status.name] = previous;
	}
	if (notes.length === 0) return undefined;
	return `MCP runtime update (authoritative after the frozen session snapshot):\n${notes.map((note) => `- ${note}`).join("\n")}\nUse mcp status, search, list, or describe for current details.`;
}

function requireManager(manager: McpManager | undefined): McpManager {
	if (!manager) throw new Error("MCP is not initialized; check the user-global MCP config and reload Pi");
	return manager;
}

function formatStatusBar(manager: McpManager, theme: Theme): string | undefined {
	const statuses = manager.status();
	if (statuses.length === 0) return undefined;
	const ready = statuses.filter((server) => server.sessionEnabled && server.status === "ready").length;
	const off = statuses.filter((server) => !server.sessionEnabled).length;
	const errors = statuses.filter((server) => server.sessionEnabled && server.status === "error").length;
	const marker = errors ? theme.fg("error", "!") : ready > 0 ? theme.fg("success", "●") : theme.fg("warning", "○");
	const extras = `${errors ? ` !${errors}` : ""}${off ? ` · ${off} off` : ""}`;
	return `${marker}${theme.fg("dim", ` MCP: ${ready}/${statuses.length}${extras}`)}`;
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
	const lines = [`${result.total} matching tools across ${result.readyServers ?? 0}/${result.totalServers ?? 0} ready servers`];
	for (const tool of result.tools) lines.push(`- ${tool.server}/${tool.name}${tool.description ? ` — ${tool.description}` : ""} (score ${tool.score})`);
	if (result.nextCursor) lines.push(`Next cursor: ${result.nextCursor}`);
	if (result.total === 0) lines.push("No tool matched the query; use mcp list on a likely server or try broader capability keywords.");
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
