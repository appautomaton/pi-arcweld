import assert from "node:assert/strict";
import { createServer, type Server as HttpServer } from "node:http";
import { chmod, mkdtemp, readFile, readlink, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { getConfigPath, loadConfig, setServerDefaultEnabled, type McpConfig } from "../src/config.js";
import { McpManager } from "../src/manager.js";
import { convertMcpResult } from "../src/output.js";

const fixturePath = fileURLToPath(new URL("./fixture-server.ts", import.meta.url));

async function configFile(value: unknown, env?: string): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "pi-mcp-config-"));
	const path = join(dir, "mcp.json");
	await writeFile(path, JSON.stringify(value), "utf8");
	if (env !== undefined) await writeFile(join(dir, "mcp.env"), env, { mode: 0o600 });
	return path;
}

function stdioConfig(extraEnv: Record<string, string> = {}): McpConfig {
	return {
		path: "test",
		servers: {
			fixture: {
				enabled: true,
				transport: "stdio",
				command: process.execPath,
				args: ["--import", "tsx", fixturePath],
				env: extraEnv,
			},
		},
	};
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error("Timed out waiting for test condition");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

describe("config", () => {
	it("loads stdio and Streamable HTTP secrets from the colocated MCP environment", async () => {
		const path = await configFile({ servers: {
			local: { transport: "stdio", command: process.execPath, args: ["server.js"], env: { TOKEN: "${TEST_MCP_TOKEN}" } },
			remote: { transport: "streamable-http", url: "https://example.com/mcp", headers: { Authorization: "Bearer ${TEST_MCP_TOKEN}" } },
		} }, "TEST_MCP_TOKEN=secret\n");
		const config = await loadConfig(path);
		assert.equal(config.servers.local.transport === "stdio" ? config.servers.local.env.TOKEN : "", "secret");
		assert.equal(config.servers.remote.transport === "streamable-http" ? config.servers.remote.headers.Authorization : "", "Bearer secret");
	});

	it("fails closed for unknown fields, relative commands, and missing MCP env", async () => {
		const relative = await configFile({ servers: { bad: { transport: "stdio", command: "node" } } });
		const unknown = await configFile({ servers: { bad: { transport: "stdio", command: process.execPath, surprise: true } } });
		const missingEnv = await configFile({ servers: { bad: { transport: "streamable-http", url: "https://example.com", headers: { X: "${MISSING_MCP_ENV}" } } } });
		await assert.rejects(() => loadConfig(relative), /absolute path/);
		await assert.rejects(() => loadConfig(unknown), /Unknown field/);
		await assert.rejects(() => loadConfig(missingEnv), /missing MCP environment variable/);
	});

	it("does not fall back to the Pi process environment", async () => {
		process.env.PROCESS_ONLY_MCP_SECRET = "must-not-load";
		try {
			const path = await configFile({ servers: { remote: { transport: "streamable-http", url: "https://example.com/mcp", headers: { Authorization: "Bearer ${PROCESS_ONLY_MCP_SECRET}" } } } });
			await assert.rejects(() => loadConfig(path), /missing MCP environment variable/);
		} finally {
			delete process.env.PROCESS_ONLY_MCP_SECRET;
		}
	});

	it("uses only the user-global config path", () => {
		const original = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = "/tmp/custom-pi-agent";
		assert.equal(getConfigPath(), "/tmp/custom-pi-agent/mcp.json");
		if (original === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = original;
	});

	it("normalizes enabled defaults and rejects non-boolean values", async () => {
		const path = await configFile({ servers: {
			on: { transport: "stdio", command: process.execPath },
			off: { enabled: false, transport: "stdio", command: process.execPath },
		} });
		const config = await loadConfig(path);
		assert.equal(config.servers.on.enabled, true);
		assert.equal(config.servers.off.enabled, false);
		const invalid = await configFile({ servers: { bad: { enabled: "no", transport: "stdio", command: process.execPath } } });
		await assert.rejects(() => loadConfig(invalid), /enabled must be a boolean/);
	});

	it("persists only raw enabled defaults without exposing MCP secrets", async () => {
		const path = await configFile({ servers: {
			remote: { transport: "streamable-http", url: "https://example.com/mcp", headers: { Authorization: "Bearer ${TEST_MCP_TOKEN}" } },
			local: { enabled: false, transport: "stdio", command: process.execPath },
		} }, "TEST_MCP_TOKEN=super-secret\n");
		const initialMode = (await stat(path)).mode & 0o777;
		await setServerDefaultEnabled(path, "remote", false);
		await setServerDefaultEnabled(path, "local", true);
		const text = await readFile(path, "utf8");
		const raw = JSON.parse(text);
		assert.equal(raw.servers.remote.enabled, false);
		assert.equal(raw.servers.local.enabled, undefined);
		assert.match(text, /\$\{TEST_MCP_TOKEN\}/);
		assert.ok(!text.includes("super-secret"));
		assert.equal((await stat(path)).mode & 0o777, initialMode);
	});

	it("serializes concurrent enabled-default writes", async () => {
		const path = await configFile({ servers: {
			first: { transport: "stdio", command: process.execPath },
			second: { transport: "stdio", command: process.execPath },
		} });
		await Promise.all([
			setServerDefaultEnabled(path, "first", false),
			setServerDefaultEnabled(path, "second", false),
		]);
		const raw = JSON.parse(await readFile(path, "utf8"));
		assert.equal(raw.servers.first.enabled, false);
		assert.equal(raw.servers.second.enabled, false);
	});

	it("updates a symlink target without replacing the config symlink", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-mcp-symlink-"));
		const target = join(dir, "real-mcp.json");
		const path = join(dir, "mcp.json");
		await writeFile(target, JSON.stringify({ servers: { fixture: { transport: "stdio", command: process.execPath } } }), "utf8");
		await symlink("real-mcp.json", path);

		await setServerDefaultEnabled(path, "fixture", false);

		assert.equal(await readlink(path), "real-mcp.json");
		const raw = JSON.parse(await readFile(target, "utf8"));
		assert.equal(raw.servers.fixture.enabled, false);
	});

	it("preserves the exact config mode under a restrictive umask", async () => {
		const path = await configFile({ servers: { fixture: { transport: "stdio", command: process.execPath } } });
		await chmod(path, 0o640);
		const previousUmask = process.umask(0o077);
		try {
			await setServerDefaultEnabled(path, "fixture", false);
		} finally {
			process.umask(previousUmask);
		}
		assert.equal((await stat(path)).mode & 0o777, 0o640);
	});
});

describe("stdio manager", () => {
	let manager: McpManager;

	before(() => {
		process.env.SHOULD_NOT_LEAK = "hidden";
		manager = new McpManager(stdioConfig({ EXPLICIT_TEST_ENV: "visible" }));
	});

	after(async () => {
		delete process.env.SHOULD_NOT_LEAK;
		await manager.shutdown();
	});

	it("warms up in the background, reports metadata, and reuses the connection", async () => {
		const statuses: string[] = [];
		const countFile = join(await mkdtemp(join(tmpdir(), "pi-mcp-count-")), "starts");
		let observed: McpManager;
		observed = new McpManager(stdioConfig({ FIXTURE_START_COUNT_FILE: countFile }), () => statuses.push(observed.status()[0]?.status ?? "missing"));
		const warmup = observed.warmup();
		const list = observed.list("fixture");
		await Promise.all([warmup, list]);
		assert.ok(statuses.includes("connecting"));
		assert.equal(observed.status()[0].status, "ready");
		assert.equal(observed.status()[0].serverName, "pi-mcp-fixture");
		assert.match(observed.status()[0].instructions ?? "", /deterministic fixture/);
		assert.equal((await readFile(countFile, "utf8")).trim().split("\n").length, 1);
		await observed.shutdown();
	});

	it("bounds warmup waiting and capability summaries", async () => {
		const delayed = new McpManager(stdioConfig({ FIXTURE_START_DELAY_MS: "500", FIXTURE_INSTRUCTIONS: "x".repeat(2_000) }));
		try {
			const warmup = delayed.warmup();
			const started = Date.now();
			await delayed.waitForWarmup(25);
			assert.ok(Date.now() - started < 300);
			await warmup;
			const summary = delayed.capabilitySummary(700);
			assert.ok(summary.length <= 700);
			assert.match(summary, /fixture: \d+ tools/);
			assert.match(summary, /echo/);
			assert.ok((delayed.status()[0].instructions?.length ?? 0) <= 1_000);
		} finally {
			await delayed.shutdown();
		}
	});

	it("renders a byte-stable capability summary without volatile connection state", async () => {
		const config = stdioConfig();
		config.servers.broken = { enabled: true, transport: "stdio", command: "/definitely/missing/mcp-server", args: [], env: {} };
		const mixed = new McpManager(config);
		try {
			await mixed.warmup();
			const summary = mixed.capabilitySummary();
			assert.match(summary, /fixture: \d+ tools/);
			assert.match(summary, /broken: catalog not loaded at snapshot time/);
			assert.ok(!summary.includes("ENOENT") && !summary.includes("Error:"), "connection errors must not reach the frozen summary");
			assert.ok(!/: (configured|connecting|ready|disconnected|error),/.test(summary), "status words must not reach the frozen summary");
			assert.equal(mixed.capabilitySummary(), summary, "summary must be deterministic for unchanged catalogs");
			const fingerprints = mixed.catalogFingerprints();
			assert.deepEqual(fingerprints.broken, { ready: false, toolCount: 0 });
			assert.equal(fingerprints.fixture.ready, true);
			assert.equal(fingerprints.fixture.toolCount, 8);
			assert.ok(fingerprints.fixture.signature);
		} finally {
			await mixed.shutdown();
		}
	});

	it("discovers servers independently and searches across ready catalogs", async () => {
		const config = stdioConfig();
		config.servers.second = { ...config.servers.fixture };
		config.servers.broken = { enabled: true, transport: "stdio", command: "/definitely/missing/mcp-server", args: [], env: {} };
		config.servers.off = { ...config.servers.fixture, enabled: false };
		const mixed = new McpManager(config);
		try {
			await mixed.warmup();
			assert.equal(mixed.status().filter((server) => server.status === "ready").length, 2);
			assert.equal(mixed.status().find((server) => server.name === "broken")?.status, "error");
			const search = await mixed.search(undefined, "echo text");
			assert.equal(search.readyServers, 2);
			assert.equal(search.totalServers, 3, "disabled servers are outside the cross-server search denominator");
			assert.deepEqual(new Set(search.tools.map((tool) => tool.server)), new Set(["fixture", "second"]));
		} finally {
			await mixed.shutdown();
		}
	});

	it("connects lazily and follows tools/list pagination", async () => {
		const result = await manager.list("fixture", undefined, 100);
		assert.equal(result.total, 8);
		assert.ok(result.tools.some((tool) => tool.name === "echo"));
	});

	it("supports deterministic paging, ranked cross-server search, and describe", async () => {
		const first = await manager.list("fixture", undefined, 2);
		assert.equal(first.tools.length, 2);
		assert.ok(first.nextCursor);
		const second = await manager.list("fixture", first.nextCursor, 2);
		assert.equal(second.tools.length, 2);
		const exact = await manager.search(undefined, "structured");
		assert.equal(exact.tools[0].name, "structured");
		assert.equal(exact.tools[0].server, "fixture");
		const description = await manager.search("fixture", "selected environment variables");
		assert.equal(description.tools[0].name, "environment");
		const tokenized = await manager.search("fixture", "add tool");
		assert.equal(tokenized.tools[0].name, "add_tool");
		const described = await manager.describe("fixture", "echo");
		assert.equal(described.inputSchema.type, "object");
	});

	it("calls tools without leaking the full Pi environment", async () => {
		const result = await manager.call("fixture", "environment", {});
		const converted = await convertMcpResult(result);
		const value = JSON.parse(converted.content[0].type === "text" ? converted.content[0].text : "{}");
		assert.equal(value.secret, undefined);
		assert.equal(value.explicit, "visible");
		assert.ok(value.path);
	});

	it("refreshes descriptions and search after tools/list_changed", async () => {
		await manager.call("fixture", "add_tool", {});
		await new Promise((resolve) => setTimeout(resolve, 250));
		const described = await manager.describe("fixture", "added");
		assert.equal(described.description, "Dynamically added tool");
		const search = await manager.search(undefined, "dynamically added");
		assert.equal(search.tools[0].name, "added");
	});

	it("propagates MCP tool errors", async () => {
		await assert.rejects(() => manager.call("fixture", "fail", {}), /fixture failure/);
	});

	it("propagates cancellation", async () => {
		const controller = new AbortController();
		const call = manager.call("fixture", "slow", {}, controller.signal);
		setTimeout(() => controller.abort(), 50);
		await assert.rejects(() => call);
	});

	it("keeps shared startup alive when the initiating caller cancels", async () => {
		const countFile = join(await mkdtemp(join(tmpdir(), "pi-mcp-shared-connect-")), "starts");
		const isolated = new McpManager(stdioConfig({ FIXTURE_START_COUNT_FILE: countFile, FIXTURE_START_DELAY_MS: "300" }));
		try {
			const controller = new AbortController();
			const cancelled = isolated.list("fixture", undefined, 50, controller.signal);
			const rejected = assert.rejects(cancelled);
			await waitUntil(() => isolated.status()[0].status === "connecting");
			const joined = isolated.list("fixture");
			controller.abort();
			await rejected;
			const result = await joined;
			assert.equal(result.total, 8);
			assert.equal(isolated.status()[0].status, "ready");
			assert.equal((await readFile(countFile, "utf8")).trim().split("\n").length, 1);
		} finally {
			await isolated.shutdown();
		}
	});

	it("runs one trailing refresh when a notification arrives during refresh", async () => {
		const isolated = new McpManager(stdioConfig());
		try {
			await isolated.list("fixture");
			const internals = isolated as unknown as { fetchTools: (...args: any[]) => Promise<any[]> };
			const originalFetchTools = internals.fetchTools.bind(isolated);
			let fetches = 0;
			let releaseFirst!: () => void;
			const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
			internals.fetchTools = async (...args: any[]) => {
				fetches++;
				if (fetches === 1) await firstGate;
				return originalFetchTools(...args);
			};

			const first = isolated.refresh("fixture");
			await waitUntil(() => fetches === 1);
			const second = isolated.refresh("fixture");
			releaseFirst();
			await Promise.all([first, second]);
			await waitUntil(() => fetches === 2);
			assert.equal(fetches, 2);
		} finally {
			await isolated.shutdown();
		}
	});

	it("rejects an unbounded tools/list cursor chain", async () => {
		const isolated = new McpManager(stdioConfig({ FIXTURE_INFINITE_PAGES: "1" }));
		await assert.rejects(() => isolated.list("fixture"), /exceeded 100 pages/);
		await isolated.shutdown();
	});

	it("keeps default-disabled servers visible without starting them", async () => {
		const countFile = join(await mkdtemp(join(tmpdir(), "pi-mcp-disabled-")), "starts");
		const config = stdioConfig({ FIXTURE_START_COUNT_FILE: countFile });
		config.servers.fixture.enabled = false;
		const isolated = new McpManager(config);
		try {
			await isolated.warmup();
			const status = isolated.status()[0];
			assert.equal(status.configuredEnabled, false);
			assert.equal(status.sessionEnabled, false);
			const disabledSearch = await isolated.search(undefined, "echo");
			assert.equal(disabledSearch.readyServers, 0);
			assert.equal(disabledSearch.totalServers, 0);
			await assert.rejects(() => isolated.list("fixture"), /disabled for this session/);
			await assert.rejects(() => readFile(countFile, "utf8"), /ENOENT/);
			await isolated.enableForSession("fixture");
			assert.equal(isolated.status()[0].status, "ready");
			const enabledSearch = await isolated.search(undefined, "echo");
			assert.equal(enabledSearch.readyServers, 1);
			assert.equal(enabledSearch.totalServers, 1);
			assert.equal((await readFile(countFile, "utf8")).trim(), "start");
			await isolated.disableForSession("fixture");
			assert.equal(isolated.status()[0].sessionEnabled, false);
			assert.equal(isolated.status()[0].toolCount, 0);
		} finally {
			await isolated.shutdown();
		}
	});

	it("prevents a delayed connection from committing after session disable", async () => {
		const isolated = new McpManager(stdioConfig({ FIXTURE_START_DELAY_MS: "500" }));
		try {
			const warmup = isolated.warmup();
			await new Promise((resolve) => setTimeout(resolve, 50));
			await isolated.disableForSession("fixture");
			await warmup;
			const disabled = isolated.status()[0];
			assert.equal(disabled.sessionEnabled, false);
			assert.equal(disabled.status, "disconnected");
			assert.equal(disabled.lastError, undefined);
			assert.equal(disabled.toolCount, 0);
			await isolated.enableForSession("fixture");
			assert.equal(isolated.status()[0].status, "ready");
		} finally {
			await isolated.shutdown();
		}
	});

	it("serializes immediate re-enable behind canceled startup cleanup", async () => {
		const countFile = join(await mkdtemp(join(tmpdir(), "pi-mcp-reenable-")), "starts");
		const isolated = new McpManager(stdioConfig({ FIXTURE_START_COUNT_FILE: countFile, FIXTURE_START_DELAY_MS: "300" }));
		try {
			const warmup = isolated.warmup();
			await waitUntil(() => isolated.status()[0].status === "connecting");
			const disabling = isolated.disableForSession("fixture");
			const enabling = isolated.enableForSession("fixture");
			await Promise.all([warmup, disabling, enabling]);
			const status = isolated.status()[0];
			assert.equal(status.sessionEnabled, true);
			assert.equal(status.status, "ready");
			assert.equal(status.lastError, undefined);
			assert.equal((await readFile(countFile, "utf8")).trim().split("\n").length, 2);
		} finally {
			await isolated.shutdown();
		}
	});

	it("cancels in-flight calls cleanly when disabled", async () => {
		const isolated = new McpManager(stdioConfig());
		try {
			await isolated.list("fixture");
			const call = isolated.call("fixture", "slow", {});
			const rejected = assert.rejects(call);
			await new Promise((resolve) => setTimeout(resolve, 50));
			await isolated.disableForSession("fixture");
			await rejected;
			assert.equal(isolated.status()[0].lastError, undefined);
			assert.equal(isolated.status()[0].sessionEnabled, false);
		} finally {
			await isolated.shutdown();
		}
	});

	it("reconnects exactly once without changing enable defaults", async () => {
		const countFile = join(await mkdtemp(join(tmpdir(), "pi-mcp-reconnect-")), "starts");
		const isolated = new McpManager(stdioConfig({ FIXTURE_START_COUNT_FILE: countFile }));
		try {
			await isolated.list("fixture");
			await isolated.reconnect("fixture");
			assert.equal((await readFile(countFile, "utf8")).trim().split("\n").length, 2);
			const status = isolated.status()[0];
			assert.equal(status.configuredEnabled, true);
			assert.equal(status.sessionEnabled, true);
			assert.equal(status.status, "ready");
		} finally {
			await isolated.shutdown();
		}
	});

	it("terminates the stdio child process on shutdown", async () => {
		const pidFile = join(await mkdtemp(join(tmpdir(), "pi-mcp-pid-")), "pid");
		const isolated = new McpManager(stdioConfig({ FIXTURE_PID_FILE: pidFile }));
		await isolated.list("fixture");
		const pid = Number(await readFile(pidFile, "utf8"));
		assert.ok(pid > 0);
		await isolated.shutdown();
		await new Promise((resolve) => setTimeout(resolve, 50));
		assert.throws(() => process.kill(pid, 0));
	});
});

describe("output", () => {
	it("uses structured content when normal content is empty", async () => {
		const converted = await convertMcpResult({ content: [], structuredContent: { ok: true } });
		assert.match(converted.content[0].type === "text" ? converted.content[0].text : "", /"ok": true/);
	});

	it("passes images through and truncates oversized text to a mode-0600 file", async () => {
		const image = await convertMcpResult({ content: [{ type: "image", mimeType: "image/png", data: "abc" }] });
		assert.equal(image.content[0].type, "image");
		const large = await convertMcpResult({ content: [{ type: "text", text: "x".repeat(60_000) }] });
		assert.ok(large.details.truncation);
		const fullPath = large.details.truncation!.fullOutputPath;
		assert.equal((await stat(fullPath)).mode & 0o777, 0o600);
		assert.equal((await readFile(fullPath, "utf8")).length, 60_000);
	});
});

describe("Streamable HTTP manager", () => {
	let httpServer: HttpServer;
	let manager: McpManager;
	let header: string | undefined;

	before(async () => {
		const createHttpMcpServer = () => {
			const server = new Server({ name: "http-fixture", version: "1.0.0" }, { capabilities: { tools: {} } });
			server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: "echo", description: "Echo", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }] }));
			server.setRequestHandler(CallToolRequestSchema, async (request) => ({ content: [{ type: "text", text: String(request.params.arguments?.text ?? "") }] }));
			return server;
		};

		httpServer = createServer(async (req, res) => {
			header = req.headers["x-test"] as string | undefined;
			const server = createHttpMcpServer();
			const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
			await server.connect(transport);
			await transport.handleRequest(req, res);
			res.on("close", () => {
				void transport.close();
				void server.close();
			});
		});
		await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
		const address = httpServer.address();
		if (!address || typeof address === "string") throw new Error("HTTP fixture did not bind");
		manager = new McpManager({ path: "test", servers: { http: { enabled: true, transport: "streamable-http", url: `http://127.0.0.1:${address.port}/mcp`, headers: { "X-Test": "yes" } } } });
	});

	after(async () => {
		await manager.shutdown();
		await new Promise<void>((resolve, reject) => httpServer.close((error) => error ? reject(error) : resolve()));
	});

	it("lists and calls tools with configured headers", async () => {
		const tools = await manager.list("http");
		assert.equal(tools.total, 1);
		const result = await manager.call("http", "echo", { text: "web" });
		const converted = await convertMcpResult(result);
		assert.equal(converted.content[0].type === "text" ? converted.content[0].text : "", "web");
		assert.equal(header, "yes");
	});
});
