import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AssistantMessage, Context, Model, Usage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import claudeWebSearchExtension from "../index.ts";

const model: Model<"anthropic-messages"> = {
	id: "kimi-k3",
	name: "Kimi K3",
	api: "anthropic-messages",
	provider: "cli-proxy-api-anthropic",
	baseUrl: "http://127.0.0.1:7777",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3 },
	contextWindow: 750000,
	maxTokens: 65536,
	compat: { forceAdaptiveThinking: true },
};

const gptModel = {
	id: "gpt-5.6-sol",
	name: "GPT 5.6",
	api: "openai-responses",
	provider: "cli-proxy-api",
};

function usage(): Usage {
	return {
		input: 10,
		output: 20,
		cacheRead: 30,
		cacheWrite: 0,
		totalTokens: 60,
		cost: { input: 0.00003, output: 0.0003, cacheRead: 0.000009, cacheWrite: 0, total: 0.000339 },
	};
}

function sse(event: string, data: unknown): string {
	return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function successfulSearchResponse(): string {
	return [
		sse("content_block_start", {
			type: "content_block_start",
			index: 0,
			content_block: { type: "server_tool_use", id: "srv_1", name: "web_search", input: {} },
		}),
		sse("content_block_delta", {
			type: "content_block_delta",
			index: 0,
			delta: { type: "input_json_delta", partial_json: '{"query":"Pi cache"}' },
		}),
		sse("content_block_stop", { type: "content_block_stop", index: 0 }),
		sse("content_block_start", {
			type: "content_block_start",
			index: 1,
			content_block: {
				type: "web_search_tool_result",
				tool_use_id: "srv_1",
				content: [
					{
						type: "web_search_result",
						encrypted_content: "opaque",
						title: "Pi cache",
						url: "https://example.com/pi-cache",
					},
				],
			},
		}),
		sse("content_block_stop", { type: "content_block_stop", index: 1 }),
		sse("content_block_start", {
			type: "content_block_start",
			index: 2,
			content_block: { type: "text", text: "", citations: null },
		}),
		sse("content_block_delta", {
			type: "content_block_delta",
			index: 2,
			delta: { type: "text_delta", text: "Stable cache-friendly search result." },
		}),
		sse("content_block_stop", { type: "content_block_stop", index: 2 }),
		sse("message_stop", { type: "message_stop" }),
	].join("");
}

describe("extension integration", () => {
	it("keeps WebSearch active only for supported models and performs hosted search inside its execution", async () => {
		let tool: any;
		const commands = new Map<string, any>();
		const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
		const events: string[] = [];
		let providerRegistrations = 0;
		let activeToolMutations = 0;
		let activeTools = ["read", "WebSearch"];
		const pi = {
			registerTool(definition: unknown) {
				tool = definition;
			},
			registerCommand(name: string, definition: unknown) {
				commands.set(name, definition);
			},
			registerProvider() {
				providerRegistrations++;
			},
			on(name: string, handler: (event: any, ctx: any) => unknown) {
				events.push(name);
				handlers.set(name, [...(handlers.get(name) ?? []), handler]);
			},
			getActiveTools() {
				return [...activeTools];
			},
			setActiveTools(names: string[]) {
				activeToolMutations++;
				activeTools = [...names];
			},
		} as unknown as ExtensionAPI;
		claudeWebSearchExtension(pi);

		assert.equal(tool?.name, "WebSearch");
		assert.equal(providerRegistrations, 0);
		assert.equal(activeToolMutations, 0);
		assert.deepEqual(events, ["session_start", "model_select"]);
		assert.equal(commands.has("claude-web-search-status"), true);

		const sessionStart = handlers.get("session_start")?.[0];
		const modelSelect = handlers.get("model_select")?.[0];
		assert.ok(sessionStart);
		assert.ok(modelSelect);

		sessionStart({}, { model });
		assert.deepEqual(activeTools, ["read", "WebSearch"]);
		assert.equal(activeToolMutations, 0);

		modelSelect({ model: gptModel }, {});
		assert.deepEqual(activeTools, ["read"]);
		assert.equal(activeToolMutations, 1);

		modelSelect({ model }, {});
		assert.deepEqual(activeTools, ["read", "WebSearch"]);
		assert.equal(activeToolMutations, 2);

		const originalFetch = globalThis.fetch;
		const payloads: Array<Record<string, unknown>> = [];
		const updates: string[] = [];
		try {
			globalThis.fetch = async () =>
				new Response(successfulSearchResponse(), { headers: { "content-type": "text/event-stream" } });
			const result = await tool.execute(
				"tool_outer",
				{ query: "Pi cache" },
				undefined,
				(update: { content?: Array<{ text?: string }> }) => {
					const text = update.content?.[0]?.text;
					if (text) updates.push(text);
				},
				{
					model,
					signal: undefined,
					modelRegistry: {
						async complete(searchModel: Model<"anthropic-messages">, context: Context, options: any) {
							const basePayload = {
								model: searchModel.id,
								max_tokens: options.maxTokens,
								stream: true,
								system: [{ type: "text", text: context.systemPrompt, cache_control: { type: "ephemeral" } }],
								messages: [{ role: "user", content: context.messages[0]?.content }],
							};
							const payload = (await options.onPayload(basePayload, searchModel)) as Record<string, unknown>;
							payloads.push(payload);
							const response = await options.fetch("https://example.test/v1/messages", {
								method: "POST",
								body: JSON.stringify(payload),
							});
							await response.text();
							const message: AssistantMessage = {
								role: "assistant",
								content: [],
								api: searchModel.api,
								provider: searchModel.provider,
								model: searchModel.id,
								usage: usage(),
								stopReason: "stop",
								rawStopReason: "end_turn",
								timestamp: Date.now(),
							};
							return message;
						},
					},
				},
			);
			assert.match(result.content[0]?.text ?? "", /Stable cache-friendly search result/);
			assert.match(result.content[0]?.text ?? "", /https:\/\/example\.com\/pi-cache/);
			assert.equal(result.usage.cacheRead, 30);
			assert.equal(payloads.length, 1);
			assert.deepEqual((payloads[0]?.tools as Array<Record<string, unknown>>)[0], {
				type: "web_search_20250305",
				name: "web_search",
				max_uses: 8,
			});
			assert.equal(updates.length >= 2, true);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});
