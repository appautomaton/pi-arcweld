import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Context, Model, ToolResultMessage } from "@earendil-works/pi-ai";
import { prepareClaudeWebSearchPayload } from "../payload.ts";
import { createReplaySafeAnthropicStream } from "../provider.ts";
import { decodeReplayMarker } from "../protocol.ts";

const model: Model<"anthropic-messages"> = {
	id: "claude-opus-5",
	name: "Claude Opus 5",
	api: "anthropic-messages",
	provider: "cli-proxy-api-anthropic",
	baseUrl: "http://127.0.0.1:9",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
	contextWindow: 700000,
	maxTokens: 128000,
};

function sse(event: string, data: unknown): string {
	return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function response(events: string[]): Response {
	return new Response(events.join(""), {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

function messageStart(id: string): string {
	return sse("message_start", {
		type: "message_start",
		message: {
			id,
			usage: {
				input_tokens: 10,
				output_tokens: 0,
				cache_read_input_tokens: 0,
				cache_creation_input_tokens: 0,
			},
		},
	});
}

function messageEnd(stopReason: "end_turn" | "tool_use" | "pause_turn"): string[] {
	return [
		sse("message_delta", {
			type: "message_delta",
			delta: { stop_reason: stopReason, stop_sequence: null, stop_details: null, container: null },
			usage: {
				input_tokens: 10,
				output_tokens: 5,
				cache_read_input_tokens: 0,
				cache_creation_input_tokens: 0,
			},
		}),
		sse("message_stop", { type: "message_stop" }),
	];
}

function thinking(index: number, signature: string): string[] {
	return [
		sse("content_block_start", {
			type: "content_block_start",
			index,
			content_block: { type: "thinking", thinking: "", signature: "" },
		}),
		sse("content_block_delta", {
			type: "content_block_delta",
			index,
			delta: { type: "signature_delta", signature },
		}),
		sse("content_block_stop", { type: "content_block_stop", index }),
	];
}

function serverUse(index: number, id = "srvtoolu_01"): string[] {
	return [
		sse("content_block_start", {
			type: "content_block_start",
			index,
			content_block: {
				type: "server_tool_use",
				id,
				name: "web_search",
				input: {},
				caller: { type: "direct" },
			},
		}),
		sse("content_block_delta", {
			type: "content_block_delta",
			index,
			delta: { type: "input_json_delta", partial_json: '{"query":"Chrome DevTools MCP"}' },
		}),
		sse("content_block_stop", { type: "content_block_stop", index }),
	];
}

function serverResult(index: number, id = "srvtoolu_01"): string[] {
	return [
		sse("content_block_start", {
			type: "content_block_start",
			index,
			content_block: {
				type: "web_search_tool_result",
				tool_use_id: id,
				caller: { type: "direct" },
				content: [
					{
						type: "web_search_result",
						encrypted_content: "encrypted-result",
						title: "Chrome DevTools MCP",
						url: "https://example.com/chrome-devtools",
					},
				],
			},
		}),
		sse("content_block_stop", { type: "content_block_stop", index }),
	];
}

function clientTool(index: number): string[] {
	return [
		sse("content_block_start", {
			type: "content_block_start",
			index,
			content_block: { type: "tool_use", id: "toolu_bash", name: "bash", input: {} },
		}),
		sse("content_block_delta", {
			type: "content_block_delta",
			index,
			delta: { type: "input_json_delta", partial_json: '{"command":"pwd"}' },
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

function mixedSearchToolResponse(): Response {
	return response([
		messageStart("msg_mixed"),
		...thinking(0, "thinking-a"),
		...serverUse(1),
		...serverResult(2),
		...thinking(3, "thinking-b"),
		...clientTool(4),
		...messageEnd("tool_use"),
	]);
}

function simpleTextResponse(id: string, value: string, stopReason: "end_turn" | "pause_turn"): Response {
	return response([messageStart(id), ...text(0, value), ...messageEnd(stopReason)]);
}

async function requestBody(input: RequestInfo | URL, init?: RequestInit): Promise<Record<string, unknown>> {
	const body = init?.body ?? (input instanceof Request ? await input.clone().text() : undefined);
	if (typeof body !== "string") throw new Error("Expected a JSON request body");
	return JSON.parse(body) as Record<string, unknown>;
}

function fakeFetchQueue(responses: Response[]) {
	const requests: Record<string, unknown>[] = [];
	const fetch: typeof globalThis.fetch = async (input, init) => {
		requests.push(await requestBody(input, init));
		const next = responses.shift();
		if (!next) throw new Error("No fake Anthropic response queued");
		return next;
	};
	return { fetch, requests };
}

function options(fetch: typeof globalThis.fetch) {
	return {
		apiKey: "fake-key",
		fetch,
		onPayload(payload: unknown) {
			return prepareClaudeWebSearchPayload(payload, model);
		},
	};
}

describe("offline Anthropic adapter integration", () => {
	it("round-trips the captured mixed native-search and Bash continuation exactly", async () => {
		const firstTransport = fakeFetchQueue([mixedSearchToolResponse()]);
		const firstContext: Context = {
			messages: [{ role: "user", content: "Search, then inspect locally", timestamp: Date.now() }],
			tools: [{ name: "bash", description: "Run a command", parameters: { type: "object" } }],
		};
		const firstStream = createReplaySafeAnthropicStream()(model, firstContext, options(firstTransport.fetch));
		const first = await firstStream.result();
		assert.equal(first.stopReason, "toolUse");
		assert.equal(first.content.filter((block) => block.type === "thinking").length, 4);

		const toolResult: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "toolu_bash",
			toolName: "bash",
			content: [{ type: "text", text: "/home/dev/agents/pi" }],
			isError: false,
			timestamp: Date.now(),
		};
		const secondTransport = fakeFetchQueue([simpleTextResponse("msg_done", "done", "end_turn")]);
		const secondContext: Context = {
			...firstContext,
			messages: [...firstContext.messages, first, toolResult],
		};
		const secondStream = createReplaySafeAnthropicStream()(model, secondContext, options(secondTransport.fetch));
		await secondStream.result();

		const request = secondTransport.requests[0];
		assert.ok(request);
		const messages = request.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>;
		const assistantContent = messages.find((message) => message.role === "assistant")?.content;
		assert.deepEqual(assistantContent?.map((block) => block.type), [
			"thinking",
			"server_tool_use",
			"web_search_tool_result",
			"thinking",
			"tool_use",
		]);
		assert.deepEqual(assistantContent?.[1]?.input, { query: "Chrome DevTools MCP" });
		assert.equal(
			((assistantContent?.[2]?.content as Array<Record<string, unknown>>)[0]?.encrypted_content),
			"encrypted-result",
		);
	});

	it("continues pause_turn with the unchanged tunneled assistant response", async () => {
		const pausedResponse = response([
			messageStart("msg_pause"),
			...serverUse(0, "srvtoolu_pause"),
			...serverResult(1, "srvtoolu_pause"),
			...messageEnd("pause_turn"),
		]);
		const transport = fakeFetchQueue([pausedResponse, simpleTextResponse("msg_final", "finished", "end_turn")]);
		const context: Context = {
			messages: [{ role: "user", content: "Search deeply", timestamp: Date.now() }],
		};
		const stream = createReplaySafeAnthropicStream()(model, context, options(transport.fetch));
		const result = await stream.result();
		assert.equal(transport.requests.length, 2);
		assert.equal(result.stopReason, "stop");
		assert.equal(result.content.some((block) => block.type === "text" && block.text === "finished"), true);
		assert.equal(
			result.content.some(
				(block) => block.type === "thinking" && decodeReplayMarker(block.thinkingSignature)?.kind === "pause_boundary",
			),
			true,
		);

		const continuation = transport.requests[1];
		assert.ok(continuation);
		const messages = continuation.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>;
		const assistant = messages.at(-1);
		assert.equal(assistant?.role, "assistant");
		assert.deepEqual(assistant?.content.map((block) => block.type), ["server_tool_use", "web_search_tool_result"]);
	});
});
