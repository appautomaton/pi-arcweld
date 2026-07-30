import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	createAssistantMessageEventStream,
	type AssistantMessage,
	type AssistantMessageEvent,
	type Context,
	type Model,
	type SimpleStreamOptions,
	type StreamFunction,
	type Usage,
} from "@earendil-works/pi-ai";
import { createReplaySafeAnthropicStream } from "../provider.ts";
import { decodeReplayMarker, encodeServerBlockMarker } from "../protocol.ts";

const model: Model<"anthropic-messages"> = {
	id: "claude-opus-5",
	name: "Claude Opus 5",
	api: "anthropic-messages",
	provider: "cli-proxy-api-anthropic",
	baseUrl: "http://127.0.0.1:8317",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
	contextWindow: 700000,
	maxTokens: 128000,
};

function usage(value: number): Usage {
	return {
		input: value,
		output: value * 2,
		cacheRead: value * 3,
		cacheWrite: value * 4,
		cacheWrite1h: value,
		reasoning: value,
		totalTokens: value * 10,
		cost: {
			input: value,
			output: value * 2,
			cacheRead: value * 3,
			cacheWrite: value * 4,
			total: value * 10,
		},
	};
}

function assistant(
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"],
	rawStopReason: string,
	usageValue: number,
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: usage(usageValue),
		stopReason,
		rawStopReason,
		timestamp: Date.now(),
	};
}

function fakeStream(message: AssistantMessage) {
	const stream = createAssistantMessageEventStream();
	queueMicrotask(() => {
		const partial: AssistantMessage = { ...message, content: [], stopReason: "pending", usage: usage(0) };
		stream.push({ type: "start", partial });
		for (let index = 0; index < message.content.length; index++) {
			const block = message.content[index];
			partial.content.push(structuredClone(block));
			if (block.type === "text") {
				stream.push({ type: "text_start", contentIndex: index, partial });
				stream.push({ type: "text_end", contentIndex: index, content: block.text, partial });
			} else if (block.type === "thinking") {
				stream.push({ type: "thinking_start", contentIndex: index, partial });
				stream.push({ type: "thinking_end", contentIndex: index, content: block.thinking, partial });
			} else {
				stream.push({ type: "toolcall_start", contentIndex: index, partial });
				stream.push({ type: "toolcall_end", contentIndex: index, toolCall: block, partial });
			}
		}
		Object.assign(partial, message);
		if (message.stopReason === "error" || message.stopReason === "aborted") {
			stream.push({ type: "error", reason: message.stopReason, error: message });
		} else {
			if (message.stopReason === "pending") throw new Error("Fake response cannot finish with pending");
			stream.push({ type: "done", reason: message.stopReason, message });
		}
		stream.end();
	});
	return stream;
}

function queuedBase(messages: AssistantMessage[]) {
	const contexts: Context[] = [];
	const optionsSeen: Array<SimpleStreamOptions | undefined> = [];
	const base: StreamFunction<"anthropic-messages", SimpleStreamOptions> = (_model, context, options) => {
		contexts.push(structuredClone(context));
		optionsSeen.push(options);
		const next = messages.shift();
		if (!next) throw new Error("No fake Anthropic response queued");
		return fakeStream(next);
	};
	return { base, contexts, optionsSeen };
}

const markerBlock = {
	type: "thinking" as const,
	thinking: "",
	thinkingSignature: encodeServerBlockMarker({
		type: "server_tool_use",
		id: "srvtoolu_01",
		name: "web_search",
		input: { query: "Pi" },
	}),
};

describe("replay-safe Anthropic provider wrapper", () => {
	it("passes through an ordinary response with one outer start and terminal event", async () => {
		const queued = queuedBase([assistant([{ type: "text", text: "done" }], "stop", "end_turn", 1)]);
		const stream = createReplaySafeAnthropicStream(queued.base)(model, { messages: [] }, {});
		const events: AssistantMessageEvent[] = [];
		for await (const event of stream) events.push(event);
		const result = await stream.result();
		assert.equal(queued.contexts.length, 1);
		assert.deepEqual(result.content, [{ type: "text", text: "done" }]);
		assert.equal(events.filter((event) => event.type === "start").length, 1);
		assert.equal(events.filter((event) => event.type === "done").length, 1);
	});

	it("continues multiple pause turns, remaps indices, and sums usage", async () => {
		const queued = queuedBase([
			assistant([markerBlock, { type: "text", text: "searching" }], "stop", "pause_turn", 1),
			assistant([markerBlock], "stop", "pause_turn", 2),
			assistant(
				[{ type: "toolCall", id: "toolu_bash", name: "bash", arguments: { command: "pwd" } }],
				"toolUse",
				"tool_use",
				3,
			),
		]);
		const stream = createReplaySafeAnthropicStream(queued.base)(model, { messages: [] }, {});
		const events: AssistantMessageEvent[] = [];
		for await (const event of stream) events.push(event);
		const result = await stream.result();

		assert.equal(queued.contexts.length, 3);
		assert.equal(queued.contexts[1]?.messages.at(-1)?.role, "assistant");
		assert.equal(queued.contexts[2]?.messages.at(-1)?.role, "assistant");
		assert.equal(result.stopReason, "toolUse");
		assert.equal(result.rawStopReason, "tool_use");
		assert.equal(result.usage.input, 6);
		assert.equal(result.usage.totalTokens, 60);
		assert.equal(result.content.length, 6);
		const boundaries = result.content.filter(
			(block) => block.type === "thinking" && decodeReplayMarker(block.thinkingSignature)?.kind === "pause_boundary",
		);
		assert.equal(boundaries.length, 2);

		const toolEnd = events.find((event) => event.type === "toolcall_end");
		assert.equal(toolEnd?.type, "toolcall_end");
		if (toolEnd?.type === "toolcall_end") assert.equal(toolEnd.contentIndex, 5);
		assert.equal(events.filter((event) => event.type === "start").length, 1);
		assert.equal(events.filter((event) => event.type === "done").length, 1);
	});

	it("fails clearly when the pause limit is exceeded", async () => {
		const queued = queuedBase([
			assistant([markerBlock], "stop", "pause_turn", 1),
			assistant([markerBlock], "stop", "pause_turn", 1),
		]);
		const stream = createReplaySafeAnthropicStream(queued.base, 1)(model, { messages: [] }, {});
		const result = await stream.result();
		assert.equal(result.stopReason, "error");
		assert.match(result.errorMessage ?? "", /exceeded 1 pause_turn/);
	});

	it("rejects empty paused responses", async () => {
		const queued = queuedBase([assistant([], "stop", "pause_turn", 1)]);
		const stream = createReplaySafeAnthropicStream(queued.base)(model, { messages: [] }, {});
		const result = await stream.result();
		assert.equal(result.stopReason, "error");
		assert.match(result.errorMessage ?? "", /contained no replayable assistant content/);
	});

	it("rejects executable client tools inside a paused response", async () => {
		const queued = queuedBase([
			assistant(
				[{ type: "toolCall", id: "toolu_bash", name: "bash", arguments: { command: "pwd" } }],
				"stop",
				"pause_turn",
				1,
			),
		]);
		const stream = createReplaySafeAnthropicStream(queued.base)(model, { messages: [] }, {});
		const result = await stream.result();
		assert.equal(result.stopReason, "error");
		assert.match(result.errorMessage ?? "", /unexpectedly contained executable client tool calls/);
	});

	it("validates the pause continuation limit", () => {
		const queued = queuedBase([]);
		assert.throws(() => createReplaySafeAnthropicStream(queued.base, -1), /non-negative integer/);
		assert.throws(() => createReplaySafeAnthropicStream(queued.base, 1.5), /non-negative integer/);
	});

	it("honors cancellation before issuing an inner request", async () => {
		const queued = queuedBase([]);
		const controller = new AbortController();
		controller.abort();
		const stream = createReplaySafeAnthropicStream(queued.base)(model, { messages: [] }, { signal: controller.signal });
		const result = await stream.result();
		assert.equal(result.stopReason, "aborted");
		assert.equal(queued.contexts.length, 0);
	});
});
