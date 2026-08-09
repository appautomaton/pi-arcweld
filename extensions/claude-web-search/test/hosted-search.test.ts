import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AnthropicOptions } from "@earendil-works/pi-ai/api/anthropic-messages";
import type { AssistantMessage, Context, Model, Usage } from "@earendil-works/pi-ai";
import {
	formatHostedSearchResult,
	normalizeHostedSearchInput,
	runHostedWebSearch,
	type HostedSearchComplete,
} from "../hosted-search.ts";

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
	thinkingLevelMap: { off: null, low: "low", high: "high", max: "max" },
	compat: { forceAdaptiveThinking: true },
};

function sse(event: string, data: unknown): string {
	return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function serverUse(index: number, id: string | null, query: string): string[] {
	return [
		sse("content_block_start", {
			type: "content_block_start",
			index,
			content_block: { type: "server_tool_use", id, name: "web_search" },
		}),
		sse("content_block_delta", {
			type: "content_block_delta",
			index,
			delta: { type: "input_json_delta", partial_json: JSON.stringify({ query }) },
		}),
		sse("content_block_stop", { type: "content_block_stop", index }),
	];
}

function serverResult(index: number, toolUseId: string | null, title: string, url: string): string[] {
	return [
		sse("content_block_start", {
			type: "content_block_start",
			index,
			content_block: {
				type: "web_search_tool_result",
				tool_use_id: toolUseId,
				content: [{ type: "web_search_result", encrypted_content: "opaque", title, url }],
			},
		}),
		sse("content_block_stop", { type: "content_block_stop", index }),
	];
}

function text(index: number, value: string): string[] {
	return [
		sse("content_block_start", {
			type: "content_block_start",
			index,
			content_block: { type: "text", text: "", citations: null },
		}),
		sse("content_block_delta", {
			type: "content_block_delta",
			index,
			delta: { type: "text_delta", text: value },
		}),
		sse("content_block_stop", { type: "content_block_stop", index }),
	];
}

function usage(value: number): Usage {
	return {
		input: value,
		output: value * 2,
		cacheRead: value * 3,
		cacheWrite: value * 4,
		totalTokens: value * 10,
		cost: { input: value, output: value * 2, cacheRead: value * 3, cacheWrite: value * 4, total: value * 10 },
	};
}

interface FakeTurn {
	body: string;
	rawStopReason: string;
	usage: Usage;
}

function fakeComplete(turns: FakeTurn[]) {
	const payloads: Array<Record<string, unknown>> = [];
	const contexts: Context[] = [];
	const optionsSeen: AnthropicOptions[] = [];
	let pendingBody: string | undefined;
	const complete: HostedSearchComplete = async (searchModel, context, options) => {
		contexts.push(structuredClone(context));
		optionsSeen.push(options);
		const basePayload = {
			model: searchModel.id,
			max_tokens: options.maxTokens,
			stream: true,
			system: [{ type: "text", text: context.systemPrompt, cache_control: { type: "ephemeral" } }],
			messages: [
				{
					role: "user",
					content: [{ type: "text", text: context.messages[0]?.content, cache_control: { type: "ephemeral" } }],
				},
			],
		};
		const rewritten = (await options.onPayload?.(basePayload, searchModel)) ?? basePayload;
		payloads.push(rewritten as Record<string, unknown>);
		const next = turns.shift();
		if (!next) throw new Error("No fake hosted-search response queued");
		pendingBody = next.body;
		if (!options.fetch) throw new Error("Expected observing fetch");
		const response = await options.fetch("https://example.test/v1/messages", {
			method: "POST",
			body: JSON.stringify(rewritten),
			signal: options.signal,
		});
		await response.text();
		const result: AssistantMessage = {
			role: "assistant",
			content: [],
			api: searchModel.api,
			provider: searchModel.provider,
			model: searchModel.id,
			usage: next.usage,
			stopReason: "stop",
			rawStopReason: next.rawStopReason,
			timestamp: Date.now(),
		};
		return result;
	};
	const baseFetch: typeof globalThis.fetch = async () => {
		if (pendingBody === undefined) throw new Error("No fake hosted-search response queued for fetch");
		const body = pendingBody;
		pendingBody = undefined;
		return new Response(body, { headers: { "content-type": "text/event-stream" } });
	};
	return { complete, baseFetch, payloads, contexts, optionsSeen };
}

describe("isolated hosted-search orchestration", () => {
	it("executes a pause continuation in memory and returns ordinary search data", async () => {
		const fake = fakeComplete([
			{
				body: [...serverUse(0, null, "Pi cache"), ...serverResult(1, "wrong", "Pi cache", "https://example.com/cache")].join(""),
				rawStopReason: "pause_turn",
				usage: usage(1),
			},
			{
				body: text(0, "Pi keeps provider prefixes stable when tool schemas do not change.").join(""),
				rawStopReason: "end_turn",
				usage: usage(2),
			},
		]);
		const progress: string[] = [];
		const result = await runHostedWebSearch(model, { query: "  Pi cache  " }, {
			complete: fake.complete,
			fetch: fake.baseFetch,
			onProgress: (message) => progress.push(message),
		});

		assert.equal(result.query, "Pi cache");
		assert.equal(result.requestCount, 2);
		assert.deepEqual(result.text, ["Pi keeps provider prefixes stable when tool schemas do not change."]);
		assert.deepEqual(result.sources, [{ title: "Pi cache", url: "https://example.com/cache" }]);
		assert.equal(result.usage.input, 3);
		assert.equal(result.usage.totalTokens, 30);
		assert.equal(fake.payloads.length, 2);
		const secondMessages = fake.payloads[1]?.messages as Array<Record<string, unknown>>;
		assert.equal(secondMessages.length, 2);
		const replay = secondMessages[1]?.content as Array<Record<string, unknown>>;
		assert.equal(replay[0]?.type, "server_tool_use");
		assert.match(String(replay[0]?.id), /^srvtoolu_pi_/);
		assert.equal(replay[1]?.tool_use_id, replay[0]?.id);
		assert.equal(progress.some((message) => message.includes("Continuing")), true);
	});

	it("keeps the isolated system and tool prefixes stable across queries", async () => {
		const first = fakeComplete([{ body: text(0, "alpha result").join(""), rawStopReason: "end_turn", usage: usage(1) }]);
		const second = fakeComplete([{ body: text(0, "beta result").join(""), rawStopReason: "end_turn", usage: usage(1) }]);
		await runHostedWebSearch(model, { query: "alpha query" }, { complete: first.complete, fetch: first.baseFetch });
		await runHostedWebSearch(model, { query: "beta query" }, { complete: second.complete, fetch: second.baseFetch });
		assert.equal(JSON.stringify(first.payloads[0]?.system), JSON.stringify(second.payloads[0]?.system));
		assert.equal(JSON.stringify(first.payloads[0]?.tools), JSON.stringify(second.payloads[0]?.tools));
		assert.notEqual(JSON.stringify(first.payloads[0]?.messages), JSON.stringify(second.payloads[0]?.messages));
		assert.equal(first.optionsSeen[0]?.thinkingEnabled, false);
		assert.equal(first.optionsSeen[0]?.cacheRetention, "short");
		assert.equal(first.contexts[0]?.tools?.length, 0);
	});

	it("normalizes domains and rejects ambiguous or empty inputs before any request", () => {
		assert.deepEqual(normalizeHostedSearchInput({ query: "  Pi  ", allowedDomains: ["Example.COM", "example.com"] }), {
			query: "Pi",
			allowedDomains: ["example.com"],
		});
		assert.throws(() => normalizeHostedSearchInput({ query: " " }), /at least 2 characters/);
		assert.throws(
			() => normalizeHostedSearchInput({ query: "Pi", allowedDomains: ["a.com"], blockedDomains: ["b.com"] }),
			/cannot use allowed_domains and blocked_domains together/,
		);
	});

	it("fails when the hosted request returns neither text nor sources", async () => {
		const fake = fakeComplete([{ body: "", rawStopReason: "end_turn", usage: usage(1) }]);
		await assert.rejects(
			runHostedWebSearch(model, { query: "empty result" }, { complete: fake.complete, fetch: fake.baseFetch }),
			/no usable results/,
		);
	});

	it("formats a compact source-bearing ordinary tool result", () => {
		const formatted = formatHostedSearchResult({
			query: "Pi cache",
			text: ["Stable result."],
			sources: [{ title: "[Pi] Cache", url: "https://example.com/cache" }],
			errors: [],
			requestCount: 1,
			durationSeconds: 1,
			usage: usage(1),
		});
		assert.match(formatted, /Stable result/);
		assert.match(formatted, /Sources:/);
		assert.match(formatted, /\[\\\[Pi\\\] Cache\]\(https:\/\/example\.com\/cache\)/);
	});
});
