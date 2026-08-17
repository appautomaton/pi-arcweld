import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadExtensions } from "../../build/pi-agent/runtime/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js";

interface TestModel {
	provider: string;
	api: string;
	id: string;
	baseUrl?: string;
	maxTokens?: number;
}

const geminiCpaModel: TestModel = {
	provider: "cli-proxy-api-google",
	api: "google-generative-ai",
	id: "gemini-3.7-flash-high",
	baseUrl: "http://127.0.0.1:7777/v1beta",
	maxTokens: 65536,
};

const geminiGoogleModel: TestModel = {
	provider: "google",
	api: "google-generative-ai",
	id: "gemini-2.5-pro",
	maxTokens: 65536,
};

const grokModel: TestModel = {
	provider: "cli-proxy-api",
	api: "openai-completions",
	id: "grok-4.6",
};

const gptModel: TestModel = {
	provider: "cli-proxy-api",
	api: "openai-responses",
	id: "gpt-5.6-sol",
};

const claudeModel: TestModel = {
	provider: "cli-proxy-api-anthropic",
	api: "anthropic-messages",
	id: "claude-sonnet-5",
};

const extensionSource = fileURLToPath(new URL("../gemini-web-search.ts", import.meta.url));
const testAgentDir = await mkdtemp(join(tmpdir(), "pi-gemini-web-test-"));
const testExtensionDir = join(testAgentDir, "extensions");
const extensionPath = join(testExtensionDir, "gemini-web-search.ts");
await mkdir(testExtensionDir);
await symlink(extensionSource, extensionPath);

const loaded = await loadExtensions([extensionPath], process.cwd());
await rm(testAgentDir, { recursive: true, force: true });

assert.deepEqual(loaded.errors, []);
assert.equal(loaded.extensions.length, 1);

const extension = loaded.extensions[0]!;
const tool = extension.tools.get("google_search")?.definition as any;
const geminiStatusCommand = extension.commands.get("gemini-search-status") as any;
const googleStatusCommand = extension.commands.get("google-search-status") as any;

assert.ok(tool, "google_search tool should be registered");
assert.ok(geminiStatusCommand, "/gemini-search-status command should be registered");
assert.ok(googleStatusCommand, "/google-search-status command should be registered");

test("google_search tool is registered with proper schema and metadata", () => {
	assert.equal(tool.name, "google_search");
	assert.equal(tool.label, "Google Search");
	assert.equal(tool.executionMode, "sequential");
	assert.ok(tool.description.includes("Google Search Grounding"));
	assert.ok(tool.parameters);
});

test("extension registers session_start and model_select lifecycle hooks", () => {
	const sessionStart = extension.handlers.get("session_start")?.[0];
	const modelSelect = extension.handlers.get("model_select")?.[0];
	assert.ok(sessionStart, "session_start handler must be registered");
	assert.ok(modelSelect, "model_select handler must be registered");

	// Handlers must execute safely without throwing
	assert.doesNotThrow(() => {
		sessionStart({}, { model: gptModel });
		modelSelect({ model: geminiCpaModel }, {});
		modelSelect({ model: grokModel }, {});
	});
});

test("tool execution validates model eligibility and executes isolated Google Search complete request", async () => {
	let completedCall: any = null;
	const mockContext: any = {
		model: geminiCpaModel,
		signal: new AbortController().signal,
		modelRegistry: {
			complete: async (model: any, context: any, options: any) => {
				completedCall = { model, context, options };
				// Simulate onPayload execution to test tool injection
				const rawPayload = {
					model: model.id,
					config: { tools: [{ functionDeclarations: [{ name: "dummy" }] }] },
				};
				const injectedPayload = options.onPayload?.(rawPayload);
				assert.ok(
					injectedPayload.config.tools.some((t: any) => t.googleSearch),
					"onPayload must inject { googleSearch: {} }",
				);

				return {
					role: "assistant",
					content: [
						{
							type: "text",
							text: "Gemini 3.7 Flash was announced in August 2026 with enhanced reasoning and agentic tools.",
						},
					],
					stopReason: "stop",
					usage: {
						input: 120,
						output: 45,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 165,
						cost: { input: 0.0001, output: 0.0002, cacheRead: 0, cacheWrite: 0, total: 0.0003 },
					},
				};
			},
		},
	};

	const result = await tool.execute(
		"call_123",
		{ query: "Gemini 3.7 Flash release", focusDomains: ["blog.google"] },
		mockContext.signal,
		() => {},
		mockContext,
	);

	assert.ok(completedCall, "complete() must be called");
	assert.equal(completedCall.model.id, "gemini-3.7-flash-high");
	assert.ok(completedCall.context.messages[0].content.includes("site:blog.google"));
	assert.ok(result.content[0].text.includes("Gemini 3.7 Flash was announced"));
	assert.equal(result.details.query, "Gemini 3.7 Flash release");
	assert.deepEqual(result.details.focusDomains, ["blog.google"]);
	assert.equal(result.usage.totalTokens, 165);
});

test("tool execution throws when called with an unsupported model", async () => {
	const mockContext: any = {
		model: grokModel,
		signal: new AbortController().signal,
		modelRegistry: {},
	};

	await assert.rejects(
		async () => {
			await tool.execute("call_456", { query: "test query" }, mockContext.signal, () => {}, mockContext);
		},
		/requires an active Gemini model/,
	);
});
