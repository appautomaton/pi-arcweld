import { streamSimple as streamAnthropic } from "@earendil-works/pi-ai/api/anthropic-messages";
import {
	createAssistantMessageEventStream,
	type AssistantMessage,
	type AssistantMessageEvent,
	type AssistantMessageEventStream,
	type Context,
	type Model,
	type SimpleStreamOptions,
	type StreamFunction,
	type ThinkingContent,
	type ToolCall,
	type Usage,
} from "@earendil-works/pi-ai";
import { encodePauseBoundaryMarker } from "./protocol.ts";
import { createReplaySafeFetch } from "./sse-tunnel.ts";

const MAX_PAUSE_CONTINUATIONS = 10;

type AnthropicStreamSimple = StreamFunction<"anthropic-messages", SimpleStreamOptions>;

function emptyUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function addUsage(left: Usage, right: Usage): Usage {
	const cacheWrite1h = (left.cacheWrite1h ?? 0) + (right.cacheWrite1h ?? 0);
	const reasoning = (left.reasoning ?? 0) + (right.reasoning ?? 0);
	return {
		input: left.input + right.input,
		output: left.output + right.output,
		cacheRead: left.cacheRead + right.cacheRead,
		cacheWrite: left.cacheWrite + right.cacheWrite,
		...(left.cacheWrite1h !== undefined || right.cacheWrite1h !== undefined ? { cacheWrite1h } : {}),
		...(left.reasoning !== undefined || right.reasoning !== undefined ? { reasoning } : {}),
		totalTokens: left.totalTokens + right.totalTokens,
		cost: {
			input: left.cost.input + right.cost.input,
			output: left.cost.output + right.cost.output,
			cacheRead: left.cost.cacheRead + right.cost.cacheRead,
			cacheWrite: left.cost.cacheWrite + right.cost.cacheWrite,
			total: left.cost.total + right.cost.total,
		},
	};
}

function createAggregateMessage(model: Model<"anthropic-messages">): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: emptyUsage(),
		stopReason: "pending",
		timestamp: Date.now(),
	};
}

function pauseBoundaryBlock(): ThinkingContent {
	return {
		type: "thinking",
		thinking: "",
		thinkingSignature: encodePauseBoundaryMarker(),
	};
}

function copyTurnIntoAggregate(
	aggregate: AssistantMessage,
	turn: AssistantMessage,
	offset: number,
	completedUsage: Usage,
): void {
	aggregate.content.splice(offset, aggregate.content.length - offset, ...turn.content);
	aggregate.usage = addUsage(completedUsage, turn.usage);
	aggregate.stopReason = turn.stopReason;
	aggregate.rawStopReason = turn.rawStopReason;
	aggregate.errorMessage = turn.errorMessage;
	aggregate.responseId = turn.responseId;
	aggregate.responseModel = turn.responseModel;
	aggregate.diagnostics = turn.diagnostics;
}

function mappedEvent(
	event: Exclude<AssistantMessageEvent, { type: "start" | "done" | "error" }>,
	aggregate: AssistantMessage,
	offset: number,
): AssistantMessageEvent {
	const contentIndex = offset + event.contentIndex;
	if (event.type === "toolcall_end") {
		const toolCall = aggregate.content[contentIndex];
		if (!toolCall || toolCall.type !== "toolCall") {
			throw new Error(`Missing aggregate tool call at content index ${contentIndex}`);
		}
		return { ...event, contentIndex, toolCall, partial: aggregate };
	}
	return { ...event, contentIndex, partial: aggregate };
}

function clientToolCalls(message: AssistantMessage): ToolCall[] {
	return message.content.filter((block): block is ToolCall => block.type === "toolCall");
}

function finalizeError(
	aggregate: AssistantMessage,
	message: string,
	aborted: boolean,
): Extract<AssistantMessageEvent, { type: "error" }> {
	aggregate.stopReason = aborted ? "aborted" : "error";
	aggregate.errorMessage = message;
	return { type: "error", reason: aggregate.stopReason, error: aggregate };
}

export function createReplaySafeAnthropicStream(
	baseStream: AnthropicStreamSimple = streamAnthropic,
	maxPauseContinuations = MAX_PAUSE_CONTINUATIONS,
): AnthropicStreamSimple {
	if (!Number.isInteger(maxPauseContinuations) || maxPauseContinuations < 0) {
		throw new Error("maxPauseContinuations must be a non-negative integer");
	}
	return (model, context, options): AssistantMessageEventStream => {
		const outer = createAssistantMessageEventStream();
		const aggregate = createAggregateMessage(model);

		queueMicrotask(async () => {
			let completedUsage = emptyUsage();
			let pauseContinuations = 0;
			let started = false;
			const messages = [...context.messages];
			const fetch = createReplaySafeFetch(options?.fetch ?? globalThis.fetch);

			try {
				while (true) {
					if (options?.signal?.aborted) throw new Error("Request was aborted");
					const offset = aggregate.content.length;
					const innerContext: Context = { ...context, messages: [...messages] };
					const inner = baseStream(model, innerContext, { ...options, fetch });

					for await (const event of inner) {
						if (event.type === "start") {
							copyTurnIntoAggregate(aggregate, event.partial, offset, completedUsage);
							aggregate.stopReason = "pending";
							if (!started) {
								started = true;
								outer.push({ type: "start", partial: aggregate });
							}
							continue;
						}
						if (event.type === "done" || event.type === "error") continue;
						copyTurnIntoAggregate(aggregate, event.partial, offset, completedUsage);
						outer.push(mappedEvent(event, aggregate, offset));
					}

					const result = await inner.result();
					copyTurnIntoAggregate(aggregate, result, offset, completedUsage);
					completedUsage = addUsage(completedUsage, result.usage);
					aggregate.usage = completedUsage;

					if (result.stopReason === "error" || result.stopReason === "aborted") {
						outer.push({ type: "error", reason: result.stopReason, error: aggregate });
						outer.end();
						return;
					}

					if (result.rawStopReason !== "pause_turn") {
						if (result.stopReason === "pending") throw new Error("Anthropic stream ended without a stop reason");
						outer.push({ type: "done", reason: result.stopReason, message: aggregate });
						outer.end();
						return;
					}

					if (result.content.length === 0) {
						throw new Error("Anthropic pause_turn response contained no replayable assistant content");
					}
					const pausedToolCalls = clientToolCalls(result);
					if (pausedToolCalls.length > 0) {
						throw new Error("Anthropic pause_turn response unexpectedly contained executable client tool calls");
					}
					pauseContinuations++;
					if (pauseContinuations > maxPauseContinuations) {
						throw new Error(`Anthropic exceeded ${maxPauseContinuations} pause_turn continuations`);
					}

					messages.push(result);
					aggregate.content.push(pauseBoundaryBlock());
					aggregate.stopReason = "pending";
					aggregate.rawStopReason = undefined;
					aggregate.errorMessage = undefined;
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				outer.push(finalizeError(aggregate, message, Boolean(options?.signal?.aborted)));
				outer.end();
			}
		});

		return outer;
	};
}

export const replaySafeAnthropicStream = createReplaySafeAnthropicStream();
