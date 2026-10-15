import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	InMemoryCredentialStore,
} from "../../build/pi-agent/runtime/node_modules/@earendil-works/pi-ai/dist/index.js";
import {
	createAgentSession,
	createCodemodeExtension,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "../../build/pi-agent/runtime/node_modules/@earendil-works/pi-coding-agent/dist/index.js";
import { loadExtensions } from "../../build/pi-agent/runtime/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js";
import { formatTokens } from "../../build/pi-agent/runtime/node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/footer.js";

const extensionDir = fileURLToPath(new URL("../", import.meta.url));
const loadingDir = await mkdtemp(join(tmpdir(), "pi-usage-load-"));
let loaded;
try {
	await mkdir(join(loadingDir, "extensions"));
	const paths = ["grok-search.ts", "vibrant-footer.ts"].map((name) => join(loadingDir, "extensions", name));
	await Promise.all(paths.map((path, index) => symlink(join(extensionDir, ["grok-search.ts", "vibrant-footer.ts"][index]!), path)));
	loaded = await loadExtensions(paths, loadingDir);
} finally {
	await rm(loadingDir, { recursive: true, force: true });
}
assert.deepEqual(loaded.errors, []);
const grokTool = loaded.extensions[0]!.tools.get("grok_search")!.definition;
const footerStart = loaded.extensions[1]!.handlers.get("session_start")![0]!;
const tokenRates = { input: 2, output: 6, cacheRead: 0.5, cacheWrite: 3 };
const providerUsage = {
	input_tokens: 600,
	input_tokens_details: { cached_tokens: 200, cache_write_tokens: 100 },
	output_tokens: 300,
	output_tokens_details: { reasoning_tokens: 100 },
	total_tokens: 900,
	num_server_side_tools_used: 7,
};

async function grokResult(rawUsage: unknown = providerUsage, cost = tokenRates, responseOverrides: Record<string, unknown> = {}) {
	const savedFetch = globalThis.fetch;
	globalThis.fetch = async (url, options) => {
		assert.equal(url, "https://grok-fixture.invalid/v1/responses");
		assert.equal(options?.method, "POST");
		const request = JSON.parse(String(options?.body));
		assert.equal(request.model, "grok-4.7");
		assert.deepEqual(request.reasoning, { effort: "low" });
		assert.equal(new Headers(options?.headers).get("X-Search-Route"), "fixture-route");
		return new Response(JSON.stringify({
			status: "completed",
			output: [{ type: "message", content: [{ type: "output_text", text: "Fixture answer" }] }],
			usage: rawUsage,
			...responseOverrides,
		}));
	};
	try {
		return await grokTool.execute("fixture-search", { query: "fixture query" }, undefined, undefined, {
			modelRegistry: {
				find: () => ({ baseUrl: "https://configured-fixture.invalid/v1", cost }),
				getApiKeyAndHeaders: async () => ({
					ok: true,
					apiKey: "fixture-key",
					baseUrl: "https://grok-fixture.invalid/v1",
					headers: { "X-Search-Route": "fixture-route" },
				}),
			},
		} as any);
	} finally {
		globalThis.fetch = savedFetch;
	}
}

test("Grok returns native token/cache/reasoning usage and only configured token cost", async () => {
	const result = await grokResult();
	const { cost, ...tokens } = result.usage!;
	assert.deepEqual(tokens, { input: 300, output: 300, cacheRead: 200, cacheWrite: 100, reasoning: 100, totalTokens: 900 });
	for (const [key, expected] of Object.entries({ input: 0.0006, output: 0.0018, cacheRead: 0.0001, cacheWrite: 0.0003, total: 0.0028 })) {
		assert.ok(Math.abs(cost[key as keyof typeof cost] - expected) < 1e-12, key);
	}
	assert.equal((result.details as any).toolCalls, 7);
	assert.match((result.details as any).costNote, /server-side search charges are unavailable/);
	const moreSearches = await grokResult({ ...providerUsage, num_server_side_tools_used: 70 });
	assert.deepEqual(moreSearches.usage, result.usage, "search counts must not fabricate fees");
	const noTotal = await grokResult({ ...providerUsage, total_tokens: undefined });
	assert.equal(noTotal.usage?.totalTokens, 900);
});

test("Grok retains tokens when configured rates are zero and omits absent usage", async () => {
	const result = await grokResult(providerUsage, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
	assert.equal(result.usage?.totalTokens, 900);
	assert.equal(result.usage?.cost.total, 0);
	assert.match((result.details as any).costNote, /Model-token cost unavailable/);
	const absent = await grokResult({ num_server_side_tools_used: 3 });
	assert.equal(absent.usage, undefined);
	assert.equal((absent.details as any).toolCalls, 3);
});

test("Grok marks failed, incomplete, and empty responses as errors without losing billed usage", async () => {
	for (const [payload, expected] of [
		[{ status: "failed", error: { message: "Fixture upstream failure" }, output: [] }, /Fixture upstream failure/],
		[{ status: "incomplete", incomplete_details: { reason: "max_output_tokens" } }, /incomplete: max_output_tokens/],
		[{ output: [] }, /no answer text/],
	] as const) {
		const result = await grokResult(providerUsage, tokenRates, payload);
		assert.equal(result.isError, true);
		assert.match(result.content[0]!.type === "text" ? result.content[0]!.text : "", expected);
		assert.equal(result.usage?.totalTokens, 900);
	}
});

async function renderFooter(sessionManager: SessionManager): Promise<string> {
	let component: any;
	const savedNerdFonts = process.env.POWERLINE_NERD_FONTS;
	process.env.POWERLINE_NERD_FONTS = "0";
	await footerStart({ type: "session_start", reason: "resume" }, {
		mode: "tui",
		cwd: "/fixture",
		sessionManager,
		getContextUsage: () => ({ tokens: 50, contextWindow: 1000, percent: 5 }),
		ui: {
			setFooter: (factory: any) => {
				component = factory(
					{ requestRender() {} },
					{
				appearance: "dark",
				colors: {
					syntaxKeyword: "violet", success: "green", warning: "gold", error: "rose",
					syntaxType: "ice", mdLink: "sky", mdHeading: "gold", syntaxOperator: "pink",
					syntaxString: "sage", toolPendingBg: "ink",
				},
				style: (text: string) => text,
				fg: (_color: string, text: string) => text,
				bold: (text: string) => text,
				},
					{ onBranchChange: () => () => {}, getGitBranch: () => null, getExtensionStatuses: () => new Map() },
				);
			},
		},
	} as any);
	try {
		return component.render(300).join("\n");
	} finally {
		component.dispose();
		if (savedNerdFonts === undefined) delete process.env.POWERLINE_NERD_FONTS;
		else process.env.POWERLINE_NERD_FONTS = savedNerdFonts;
	}
}

test("native nested and direct Grok results survive session reconstruction and reach footer totals once", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-usage-session-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	let session: any;
	try {
		const searchResult = await grokResult();
		const faux = fauxProvider({ provider: "usage-fixture", api: "faux:usage-fixture" });
		const assistant = (content: any, stopReason: "toolUse" | "stop") => fauxAssistantMessage(content, { stopReason });
		faux.setResponses([
			assistant(fauxToolCall("grok_search", { query: "direct" }, { id: "direct" }), "toolUse"),
			assistant("done", "stop"),
			assistant(fauxToolCall("codemode", {
				code: 'text(await tools.grok_search({ query: "nested" }));',
			}, { id: "nested" }), "toolUse"),
			assistant("done", "stop"),
		]);
		const modelRuntime = await ModelRuntime.create({
			credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false,
		});
		modelRuntime.registerNativeProvider(faux.provider);
		const settingsManager = SettingsManager.inMemory({
			compaction: { enabled: false }, retry: { enabled: false },
		});
		const loader = new DefaultResourceLoader({
			cwd: agentDir, agentDir, settingsManager,
			extensionFactories: [createCodemodeExtension(), (pi: any) => pi.registerTool({
				...grokTool, execute: async () => searchResult,
			})],
			noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, systemPrompt: "Usage fixture",
		});
		await loader.reload();
		assert.deepEqual(loader.getExtensions().errors, []);
		const manager = SessionManager.inMemory(agentDir);
		({ session } = await createAgentSession({
			cwd: agentDir, agentDir, model: faux.getModel(), thinkingLevel: "off", modelRuntime,
			resourceLoader: loader, tools: ["grok_search", "codemode"], sessionManager: manager, settingsManager,
		}));
		await session.bindExtensions({ mode: "json" });
		await session.prompt("Call Grok directly.");
		await session.prompt("Call Grok through codemode.");
		const results = manager.getEntries().filter((entry) => entry.type === "message" && entry.message.role === "toolResult");
		assert.equal(results.length, 2, "nested result must not become a separate billed entry");
		for (const result of results) {
			if (result.type !== "message" || result.message.role !== "toolResult") continue;
			assert.equal(result.message.isError, false, JSON.stringify(result.message.content));
			assert.deepEqual(result.message.usage, searchResult.usage);
		}
		const before = session.getSessionStats();
		const latestUsage = {
			input: 10, output: 20, cacheRead: 30, cacheWrite: 0, totalTokens: 60,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.1 },
		};
		manager.appendMessage({ ...fauxAssistantMessage("latest usage fixture"), usage: latestUsage });
		const first = manager.getEntries()[0]!.id;
		const summaryUsage = {
			input: 7, output: 11, cacheRead: 13, cacheWrite: 17, totalTokens: 48,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.2 },
		};
		manager.appendUsage("fixture", "fixture", "fixture", summaryUsage);
		manager.appendCompaction("compacted", first, 1000, undefined, false, summaryUsage);
		manager.branchWithSummary(first, "branch summary", undefined, false, summaryUsage);
		const stats = session.getSessionStats();
		assert.deepEqual(stats.tokens, {
			input: before.tokens.input + 31, output: before.tokens.output + 53,
			cacheRead: before.tokens.cacheRead + 69, cacheWrite: before.tokens.cacheWrite + 51,
			total: before.tokens.total + 204,
		});
		assert.ok(Math.abs(stats.cost - 0.7056) < 1e-12);
		const resumed = SessionManager.inMemory(agentDir, { id: manager.getSessionId() }, structuredClone(manager.getEntries()));
		const line = await renderFooter(resumed);
		const fresh = formatTokens(stats.tokens.input + stats.tokens.cacheWrite);
		assert.ok(line.includes(`${formatTokens(stats.tokens.cacheRead)}│${fresh}│${formatTokens(stats.tokens.output)}`), line);
		assert.ok(line.includes("75%"), line);
		assert.match(line, /\$0\.706/);
		assert.ok(line.includes("/fixture"), line);
	} finally {
		if (session) {
			await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			session.dispose();
		}
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		await rm(agentDir, { recursive: true, force: true });
	}
});
