import { createHash } from "node:crypto";
import { basename } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { McpConfig, McpServerConfig } from "./config.js";

const MAX_CATALOG_PAGES = 100;
const STDERR_LINES = 100;
const SUMMARY_CHARS = 8_000;
const INSTRUCTIONS_CHARS = 1_000;
const DESCRIPTION_CHARS = 180;

export interface McpTool {
	name: string;
	description?: string;
	inputSchema: Record<string, unknown>;
	outputSchema?: Record<string, unknown>;
	annotations?: Record<string, unknown>;
}

export interface ToolMatch extends McpTool {
	server: string;
	score: number;
}

export type ConnectionStatus = "configured" | "connecting" | "ready" | "disconnected" | "error";

interface ServerState {
	name: string;
	config: McpServerConfig;
	status: ConnectionStatus;
	sessionEnabled: boolean;
	client?: Client;
	transport?: Transport;
	tools: McpTool[];
	connectPromise?: Promise<void>;
	refreshPromise?: Promise<void>;
	cleanupPromise?: Promise<void>;
	refreshAgain?: boolean;
	lastError?: string;
	stderr: string[];
	generation: number;
	controller?: AbortController;
	serverName?: string;
	serverVersion?: string;
	instructions?: string;
}

export interface ServerStatus {
	name: string;
	transport: McpServerConfig["transport"];
	target: string;
	status: ConnectionStatus;
	configuredEnabled: boolean;
	sessionEnabled: boolean;
	toolCount: number;
	lastError?: string;
	stderr: string[];
	serverName?: string;
	serverVersion?: string;
	instructions?: string;
}

export interface CatalogPage<T = McpTool> {
	tools: T[];
	nextCursor?: string;
	total: number;
	readyServers?: number;
	totalServers?: number;
}

export interface CatalogFingerprint {
	ready: boolean;
	toolCount: number;
	signature?: string;
}

export class McpManager {
	private readonly servers = new Map<string, ServerState>();
	private closing = false;
	private warmupPromise?: Promise<void>;

	constructor(config: McpConfig, private readonly onStatusChange: () => void = () => {}) {
		for (const [name, serverConfig] of Object.entries(config.servers)) {
			this.servers.set(name, {
				name,
				config: serverConfig,
				sessionEnabled: serverConfig.enabled,
				status: "configured",
				tools: [],
				stderr: [],
				generation: 0,
			});
		}
	}

	status(): ServerStatus[] {
		return [...this.servers.values()].map((state) => ({
			name: state.name,
			transport: state.config.transport,
			target: displayTarget(state.config),
			status: state.status,
			configuredEnabled: state.config.enabled,
			sessionEnabled: state.sessionEnabled,
			toolCount: state.tools.length,
			lastError: state.lastError,
			stderr: [...state.stderr],
			serverName: state.serverName,
			serverVersion: state.serverVersion,
			instructions: state.instructions,
		}));
	}

	warmup(): Promise<void> {
		if (!this.warmupPromise) {
			this.warmupPromise = Promise.allSettled([...this.servers.values()]
				.filter((state) => state.sessionEnabled)
				.map((state) => this.connect(state))).then(() => {});
		}
		return this.warmupPromise;
	}

	async waitForWarmup(timeoutMs = 3_000): Promise<void> {
		const warmup = this.warmup();
		let timer: NodeJS.Timeout | undefined;
		await Promise.race([
			warmup,
			new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); }),
		]);
		if (timer) clearTimeout(timer);
	}

	/**
	 * Renders the model-facing capability summary. The output must stay byte-stable
	 * for unchanged catalogs: it is frozen into the system prompt for the whole
	 * session, and any variation would invalidate the provider prompt cache for the
	 * entire conversation. Connection status words, live errors, and other volatile
	 * state are deliberately excluded; mcp status remains the live view.
	 */
	capabilitySummary(maxChars = SUMMARY_CHARS): string {
		if (this.servers.size === 0) return "";
		const lines = [
			"MCP routing: for current/external docs, call mcp search before answering; search waits for connecting servers. Do not rely only on training data.",
			"Untrusted MCP capabilities (session snapshot, use mcp status for live state):",
		];
		for (const state of this.servers.values()) {
			if (!state.sessionEnabled) {
				lines.push(`- ${state.name}: disabled for this session; the user can enable it with /mcp`);
				continue;
			}
			if (state.status !== "ready") {
				lines.push(`- ${state.name}: catalog not loaded at snapshot time, use mcp status and mcp search`);
				continue;
			}
			const identity = state.serverName && state.serverName !== state.name ? ` (server: ${state.serverName}${state.serverVersion ? ` ${state.serverVersion}` : ""})` : "";
			lines.push(`- ${state.name}: ${state.tools.length} tools${identity}`);
			if (state.instructions) lines.push(`  Instructions: ${shorten(state.instructions, Math.min(INSTRUCTIONS_CHARS, Math.max(80, Math.floor(maxChars / 5))))}`);
			let shown = 0;
			for (const tool of state.tools) {
				const line = `  - ${tool.name}${tool.description ? ` — ${shorten(tool.description, DESCRIPTION_CHARS)}` : ""}`;
				if ([...lines, line].join("\n").length > maxChars - 160) break;
				lines.push(line);
				shown++;
			}
			if (shown < state.tools.length) lines.push(`  (${shown}/${state.tools.length} shown; use mcp search or paginated mcp list for the rest)`);
			if (lines.join("\n").length >= maxChars - 160) break;
		}
		const omittedServers = this.servers.size - lines.filter((line) => line.startsWith("- ")).length;
		if (omittedServers > 0) lines.push(`(${omittedServers} servers omitted by the capability-summary budget; use mcp status/search)`);
		return shorten(lines.join("\n"), maxChars);
	}

	/** Semantic catalog fingerprints used only for append-only runtime updates. */
	catalogFingerprints(): Record<string, CatalogFingerprint> {
		const fingerprints: Record<string, CatalogFingerprint> = {};
		for (const state of this.servers.values()) {
			if (state.status !== "ready") {
				fingerprints[state.name] = { ready: false, toolCount: 0 };
				continue;
			}
			const canonical = canonicalJson({
				serverName: state.serverName,
				serverVersion: state.serverVersion,
				instructions: state.instructions,
				tools: toolsByName(state.tools),
			});
			fingerprints[state.name] = {
				ready: true,
				toolCount: state.tools.length,
				signature: createHash("sha256").update(canonical).digest("base64url"),
			};
		}
		return fingerprints;
	}

	/** @deprecated Use catalogFingerprints for semantic change detection. */
	catalogSignatures(): Record<string, string> {
		return Object.fromEntries(Object.entries(this.catalogFingerprints()).map(([name, value]) => [name, value.signature ?? ""]));
	}

	restoreSessionEnabled(states: Record<string, boolean>): void {
		for (const state of this.servers.values()) {
			if (states[state.name] === undefined) continue;
			state.sessionEnabled = states[state.name];
			state.status = "configured";
		}
	}

	setConfiguredEnabled(serverName: string, enabled: boolean): void {
		const state = this.requireServer(serverName);
		state.config.enabled = enabled;
		this.changed();
	}

	async enableForSession(serverName: string, signal?: AbortSignal): Promise<void> {
		const state = this.requireServer(serverName);
		if (state.cleanupPromise) await waitFor(state.cleanupPromise, signal);
		if (!state.sessionEnabled) {
			state.sessionEnabled = true;
			state.status = "configured";
			state.lastError = undefined;
			this.changed();
		}
		await this.connect(state, signal);
	}

	async disableForSession(serverName: string): Promise<void> {
		const state = this.requireServer(serverName);
		if (!state.sessionEnabled) {
			await state.cleanupPromise;
			return;
		}
		state.sessionEnabled = false;
		const pending = this.pendingStateWork(state);
		const client = this.invalidateState(state);
		state.status = "disconnected";
		state.lastError = undefined;
		this.changed();
		await this.startCleanup(state, client, pending);
	}

	async reconnect(serverName: string, signal?: AbortSignal): Promise<void> {
		const state = this.requireServer(serverName);
		if (state.cleanupPromise) await waitFor(state.cleanupPromise, signal);
		if (!state.sessionEnabled) throw new Error(`MCP server is disabled for this session: ${serverName}`);
		const pending = this.pendingStateWork(state);
		const client = this.invalidateState(state);
		state.status = "configured";
		state.lastError = undefined;
		this.changed();
		await waitFor(this.startCleanup(state, client, pending), signal);
		await this.connect(state, signal);
	}

	async list(serverName: string, cursor?: string, limit = 50, signal?: AbortSignal): Promise<CatalogPage> {
		const state = await this.ready(serverName, signal);
		return page(state.tools, cursor, limit);
	}

	async search(serverName: string | undefined, query: string, cursor?: string, limit = 50, signal?: AbortSignal): Promise<CatalogPage<ToolMatch>> {
		if (serverName) await this.ready(serverName, signal);
		else await this.settleEnabledCatalogs(signal);
		const states = serverName
			? [this.requireServer(serverName)]
			: [...this.servers.values()].filter((state) => state.sessionEnabled);
		const matches = states.flatMap((state) => state.tools
			.map((tool) => ({ ...tool, server: state.name, score: scoreTool(query, state, tool) }))
			.filter((tool) => tool.score > 0))
			.sort((left, right) => right.score - left.score || left.server.localeCompare(right.server) || left.name.localeCompare(right.name));
		return {
			...page(matches, cursor, limit),
			readyServers: states.filter((state) => state.status === "ready").length,
			totalServers: states.length,
		};
	}

	async describe(serverName: string, toolName: string, signal?: AbortSignal): Promise<McpTool> {
		const state = await this.ready(serverName, signal);
		const tool = state.tools.find((candidate) => candidate.name === toolName);
		if (!tool) throw new Error(`MCP tool not found: ${serverName}/${toolName}`);
		return tool;
	}

	async call(serverName: string, toolName: string, args: Record<string, unknown>, signal?: AbortSignal) {
		const state = await this.ready(serverName, signal);
		if (!state.tools.some((tool) => tool.name === toolName)) throw new Error(`MCP tool not found: ${serverName}/${toolName}`);
		const generation = state.generation;
		const requestSignal = combineSignals(signal, state.controller?.signal);
		try {
			const result = await state.client!.callTool(
				{ name: toolName, arguments: args },
				undefined,
				requestSignal ? { signal: requestSignal } : undefined,
			);
			if (!this.canCommit(state, generation)) throw new Error(`MCP call became stale: ${serverName}/${toolName}`);
			if ("toolResult" in result) throw new Error("Task-based MCP tools are not supported");
			if (result.isError) {
				const errorMessage = result.content
					.filter((block): block is Extract<(typeof result.content)[number], { type: "text" }> => block.type === "text")
					.map((block) => block.text)
					.join("\n") || `MCP tool failed: ${serverName}/${toolName}`;
				throw new Error(errorMessage);
			}
			return result;
		} catch (error) {
			if (this.canCommit(state, generation) && !requestSignal?.aborted) {
				const sanitized = safeError(state.config, error);
				state.lastError = sanitized;
				this.changed();
				throw new Error(sanitized, { cause: error });
			}
			throw error;
		}
	}

	async refresh(serverName: string, signal?: AbortSignal): Promise<void> {
		const state = this.requireServer(serverName);
		if (!state.sessionEnabled) throw new Error(`MCP server is disabled for this session: ${serverName}`);
		if (state.refreshPromise) {
			state.refreshAgain = true;
			return state.refreshPromise;
		}
		if (!state.client || state.status !== "ready") throw new Error(`MCP server is not connected: ${serverName}`);
		const generation = state.generation;
		const requestSignal = combineSignals(signal, state.controller?.signal);
		const promise = this.fetchTools(state.client, requestSignal).then((tools) => {
			if (!this.canCommit(state, generation)) return;
			state.tools = tools;
			state.lastError = undefined;
			this.changed();
		}).catch((error) => {
			if (this.canCommit(state, generation) && !requestSignal?.aborted) {
				const sanitized = safeError(state.config, error);
				state.lastError = sanitized;
				this.changed();
				throw new Error(sanitized, { cause: error });
			}
			throw error;
		}).finally(() => {
			if (state.refreshPromise !== promise) return;
			state.refreshPromise = undefined;
			if (state.refreshAgain && this.canCommit(state, generation)) {
				state.refreshAgain = false;
				void this.refresh(state.name).catch(() => {});
			}
		});
		state.refreshPromise = promise;
		return promise;
	}

	async shutdown(): Promise<void> {
		this.closing = true;
		const pending = [...this.servers.values()].flatMap((state) => [state.connectPromise, state.refreshPromise, state.cleanupPromise].filter((promise): promise is Promise<void> => promise !== undefined));
		const clients = [...this.servers.values()].map((state) => this.invalidateState(state)).filter((client): client is Client => client !== undefined);
		await Promise.allSettled(clients.map((client) => client.close()));
		await Promise.allSettled(pending);
	}

	private async ready(name: string, signal?: AbortSignal): Promise<ServerState> {
		const state = this.requireServer(name);
		if (state.cleanupPromise) await waitFor(state.cleanupPromise, signal);
		if (!state.sessionEnabled) throw new Error(`MCP server is disabled for this session: ${name}`);
		if (state.status === "ready" && state.client) return state;
		await this.connect(state, signal);
		if (!state.sessionEnabled) throw new Error(`MCP server is disabled for this session: ${name}`);
		if (state.status !== "ready" || !state.client) throw new Error(`MCP server is not connected: ${name}`);
		return state;
	}

	private async connect(state: ServerState, signal?: AbortSignal): Promise<void> {
		if (this.closing) throw new Error("MCP manager is shutting down");
		if (!state.sessionEnabled) throw new Error(`MCP server is disabled for this session: ${state.name}`);
		if (state.status === "ready" && state.client) return;
		if (state.connectPromise) return waitFor(state.connectPromise, signal);
		const generation = ++state.generation;
		state.status = "connecting";
		state.lastError = undefined;
		this.changed();
		const controller = new AbortController();
		state.controller = controller;
		const requestSignal = controller.signal;
		const transport = this.createTransport(state);
		const client = new Client(
			{ name: "pi-mcp-client", version: "0.1.0" },
			{
				capabilities: {},
				listChanged: { tools: { autoRefresh: false, debounceMs: 100, onChanged: (error) => {
					if (!this.canCommit(state, generation)) return;
					if (error) {
						state.lastError = safeError(state.config, error);
						this.changed();
						return;
					}
					void this.refresh(state.name).catch(() => {});
				} } },
			},
		);
		let transportClosed = false;
		transport.onerror = (error) => {
			if (!this.canCommit(state, generation) || state.client !== client) return;
			this.disconnectState(state, client, error);
		};
		client.onclose = () => {
			transportClosed = true;
			if (!this.canCommit(state, generation) || state.client !== client) return;
			this.disconnectState(state, client);
		};
		const promise = (async () => {
			try {
				await client.connect(transport, requestSignal ? { signal: requestSignal } : undefined);
				const tools = await this.fetchTools(client, requestSignal);
				if (transportClosed || !this.canCommit(state, generation)) throw new Error("MCP connection became stale during startup");
				const version = client.getServerVersion();
				state.client = client;
				state.transport = transport;
				state.tools = tools;
				state.serverName = clean(version?.name);
				state.serverVersion = clean(version?.version);
				state.instructions = clean(client.getInstructions(), INSTRUCTIONS_CHARS);
				state.status = "ready";
				this.changed();
			} catch (error) {
				await client.close().catch(() => {});
				if (this.canCommit(state, generation)) {
					if (state.controller === controller) state.controller = undefined;
					state.status = "disconnected";
					if (!requestSignal?.aborted) {
						const sanitized = safeError(state.config, error);
						state.status = "error";
						state.lastError = sanitized;
						this.changed();
						throw new Error(sanitized, { cause: error });
					}
					this.changed();
				}
				throw error;
			}
		})().finally(() => {
			if (state.connectPromise === promise) state.connectPromise = undefined;
		});
		state.connectPromise = promise;
		return waitFor(promise, signal);
	}

	private async settleEnabledCatalogs(signal?: AbortSignal): Promise<void> {
		const attempts = [...this.servers.values()]
			.filter((state) => state.sessionEnabled && (state.status !== "ready" || !state.client))
			.map((state) => this.connect(state, signal));
		await waitFor(Promise.allSettled(attempts), signal);
		for (;;) {
			const pending = [...this.servers.values()].flatMap((state) => [state.connectPromise, state.refreshPromise]
				.filter((promise): promise is Promise<void> => promise !== undefined));
			if (pending.length === 0) return;
			await waitFor(Promise.allSettled(pending), signal);
		}
	}

	private canCommit(state: ServerState, generation: number): boolean {
		return !this.closing && state.sessionEnabled && state.generation === generation;
	}

	private disconnectState(state: ServerState, client: Client, error?: unknown): void {
		if (state.client !== client) return;
		this.invalidateState(state);
		state.status = "disconnected";
		if (error !== undefined) state.lastError = safeError(state.config, error);
		this.changed();
	}

	private pendingStateWork(state: ServerState): Promise<void>[] {
		return [state.connectPromise, state.refreshPromise].filter((promise): promise is Promise<void> => promise !== undefined);
	}

	private startCleanup(state: ServerState, client: Client | undefined, pending: Promise<void>[]): Promise<void> {
		const cleanup = Promise.allSettled([
			...pending,
			...(client ? [client.close()] : []),
		]).then(() => {});
		const tracked = cleanup.finally(() => {
			if (state.cleanupPromise === tracked) state.cleanupPromise = undefined;
		});
		state.cleanupPromise = tracked;
		return tracked;
	}

	private invalidateState(state: ServerState): Client | undefined {
		state.generation++;
		state.controller?.abort();
		state.controller = undefined;
		const client = state.client;
		state.client = undefined;
		state.transport = undefined;
		state.tools = [];
		state.serverName = undefined;
		state.serverVersion = undefined;
		state.instructions = undefined;
		state.connectPromise = undefined;
		state.refreshPromise = undefined;
		state.refreshAgain = false;
		return client;
	}

	private createTransport(state: ServerState): Transport {
		if (state.config.transport === "stdio") {
			const transport = new StdioClientTransport({
				command: state.config.command,
				args: state.config.args,
				env: { ...getDefaultEnvironment(), ...state.config.env },
				cwd: state.config.cwd,
				stderr: "pipe",
			});
			transport.stderr?.on("data", (chunk: Buffer) => {
				for (const line of chunk.toString().split("\n").filter(Boolean)) {
					state.stderr.push(line);
					if (state.stderr.length > STDERR_LINES) state.stderr.shift();
				}
			});
			return transport;
		}
		return new StreamableHTTPClientTransport(new URL(state.config.url), {
			requestInit: Object.keys(state.config.headers).length ? { headers: state.config.headers } : undefined,
			reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1_000, maxReconnectionDelay: 1_000, reconnectionDelayGrowFactor: 1 },
		});
	}

	private async fetchTools(client: Client, signal?: AbortSignal): Promise<McpTool[]> {
		const tools: McpTool[] = [];
		let cursor: string | undefined;
		for (let pages = 0; pages < MAX_CATALOG_PAGES; pages++) {
			const result = await client.listTools(cursor ? { cursor } : undefined, signal ? { signal } : undefined);
			for (const tool of result.tools) {
				tools.push({
					name: tool.name,
					description: clean(tool.description),
					inputSchema: tool.inputSchema,
					outputSchema: tool.outputSchema,
					annotations: tool.annotations,
				});
			}
			cursor = result.nextCursor;
			if (!cursor) return tools.sort((left, right) => left.name.localeCompare(right.name));
		}
		throw new Error(`MCP tools/list exceeded ${MAX_CATALOG_PAGES} pages`);
	}

	private requireServer(name: string): ServerState {
		const state = this.servers.get(name);
		if (!state) throw new Error(`Unknown MCP server: ${name}`);
		return state;
	}

	private changed(): void {
		try { this.onStatusChange(); } catch { /* UI updates must not break MCP operations. */ }
	}
}

function displayTarget(config: McpServerConfig): string {
	if (config.transport === "stdio") return basename(config.command);
	const url = new URL(config.url);
	return url.origin;
}

function safeError(config: McpServerConfig, error: unknown): string {
	let value = stripControlCharacters(message(error));
	if (config.transport === "streamable-http") {
		value = value.replaceAll(config.url, new URL(config.url).origin);
		for (const secret of Object.values(config.headers)) {
			if (secret.length >= 4) value = value.replaceAll(secret, "[redacted]");
		}
	} else {
		for (const secret of Object.values(config.env)) {
			if (secret.length >= 4) value = value.replaceAll(secret, "[redacted]");
		}
	}
	return shorten(value, 1_000);
}

function stripControlCharacters(value: string): string {
	return value
		.replace(/\u001B(?:\[[0-?]*[ -/]*[@-~]|[@-_])/g, "")
		.replace(/[\u0000-\u001F\u007F-\u009F]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function canonicalJson(value: unknown): string {
	return JSON.stringify(canonicalize(value));
}

/**
 * A tool's identity is its name, so catalog list order carries no meaning. Sorting
 * by name before fingerprinting keeps an identical reconnect that merely reorders
 * its tools from being reported as a catalog change. Uses the same collation as
 * canonicalize's object keys so the whole signature shares one ordering rule.
 */
function toolsByName(tools: McpTool[]): McpTool[] {
	return [...tools].sort((left, right) => left.name.localeCompare(right.name));
}

function canonicalize(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonicalize);
	if (!value || typeof value !== "object") return value;
	return Object.fromEntries(Object.entries(value as Record<string, unknown>)
		.filter(([, item]) => item !== undefined)
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([key, item]) => [key, canonicalize(item)]));
}

function scoreTool(query: string, state: ServerState, tool: McpTool): number {
	const normalizedQuery = normalize(query);
	const queryTokens = tokens(query);
	if (!normalizedQuery || queryTokens.length === 0) return 0;
	const normalizedName = normalize(tool.name);
	const nameTokens = new Set(tokens(tool.name));
	const description = normalize(tool.description ?? "");
	const descriptionTokens = new Set(tokens(tool.description ?? ""));
	const serverText = normalize(`${state.name} ${state.serverName ?? ""} ${state.instructions ?? ""}`);
	let score = 0;
	if (normalizedName === normalizedQuery) score += 1_000;
	else if (normalizedName.startsWith(normalizedQuery)) score += 500;
	if (description.includes(normalizedQuery)) score += 160;
	if (serverText.includes(normalizedQuery)) score += 40;
	for (const token of queryTokens) {
		if (nameTokens.has(token)) score += 100;
		else if ([...nameTokens].some((candidate) => candidate.startsWith(token))) score += 60;
		if (descriptionTokens.has(token)) score += 24;
		else if (description.includes(token)) score += 8;
		if (serverText.includes(token)) score += 3;
	}
	return score;
}

function tokens(value: string): string[] {
	return [...new Set(value
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter((token) => token.length > 1))];
}

function normalize(value: string): string {
	return tokens(value).join(" ");
}

function clean(value: string | undefined, max = 10_000): string | undefined {
	if (!value) return undefined;
	const cleaned = value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim();
	return cleaned ? shorten(cleaned, max) : undefined;
}

function shorten(value: string, max: number): string {
	return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function waitFor<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (!signal) return promise;
	if (signal.aborted) return Promise.reject(signal.reason ?? new Error("Aborted"));
	return new Promise<T>((resolve, reject) => {
		const abort = () => reject(signal.reason ?? new Error("Aborted"));
		signal.addEventListener("abort", abort, { once: true });
		promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
	});
}

function combineSignals(left: AbortSignal | undefined, right: AbortSignal | undefined): AbortSignal | undefined {
	if (!left) return right;
	if (!right) return left;
	return AbortSignal.any([left, right]);
}

function page<T>(tools: T[], cursor: string | undefined, requestedLimit: number): CatalogPage<T> {
	const limit = Math.max(1, Math.min(100, Math.floor(requestedLimit)));
	const offset = decodeCursor(cursor);
	if (offset > tools.length) throw new Error("Invalid MCP catalog cursor");
	const selected = tools.slice(offset, offset + limit);
	const next = offset + selected.length;
	return { tools: selected, total: tools.length, nextCursor: next < tools.length ? encodeCursor(next) : undefined };
}

function encodeCursor(offset: number): string {
	return Buffer.from(String(offset)).toString("base64url");
}

function decodeCursor(cursor: string | undefined): number {
	if (!cursor) return 0;
	const value = Buffer.from(cursor, "base64url").toString("utf8");
	if (!/^\d+$/.test(value)) throw new Error("Invalid MCP catalog cursor");
	return Number(value);
}
