import {
	decodeReplayMarker,
	isReplayMarkerSignature,
	ReplayMarkerError,
} from "./protocol.ts";

const CLAUDE_WEB_SEARCH_TOOL_TYPE = "web_search_20250305";
const CLAUDE_WEB_SEARCH_TOOL_TYPES = new Set([
	"web_search_20250305",
	"web_search_20260209",
	"web_search_20260318",
]);

export type ClaudeWebSearchRoute = "anthropic" | "cli-proxy-api-anthropic";

export interface ModelIdentity {
	provider?: string;
	api?: string;
	id?: string;
}

interface PayloadRewriteResult {
	payload: unknown;
	changed: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function getClaudeWebSearchRoute(model: ModelIdentity | undefined): ClaudeWebSearchRoute | undefined {
	if (model?.api !== "anthropic-messages") return undefined;
	if (model.provider === "anthropic") return "anthropic";
	if (model.provider === "cli-proxy-api-anthropic") return "cli-proxy-api-anthropic";
	return undefined;
}

function markerSignature(block: unknown): unknown {
	return isRecord(block) && block.type === "thinking" ? block.signature : undefined;
}

function assertNoMarkerOutsideAssistant(message: Record<string, unknown>): void {
	if (!Array.isArray(message.content)) return;
	for (const block of message.content) {
		if (isReplayMarkerSignature(markerSignature(block))) {
			throw new ReplayMarkerError("Replay marker appeared outside an Anthropic assistant message");
		}
	}
}

function restoreAssistantMessage(message: Record<string, unknown>): { messages: Record<string, unknown>[]; changed: boolean } {
	if (message.role !== "assistant" || !Array.isArray(message.content)) {
		assertNoMarkerOutsideAssistant(message);
		return { messages: [message], changed: false };
	}

	const segments: unknown[][] = [];
	let current: unknown[] = [];
	let changed = false;
	for (const block of message.content) {
		const decoded = decodeReplayMarker(markerSignature(block));
		if (!decoded) {
			current.push(block);
			continue;
		}

		changed = true;
		if (decoded.kind === "server_block") {
			current.push(decoded.block);
			continue;
		}
		if (current.length === 0) {
			throw new ReplayMarkerError("Pause boundary cannot start an Anthropic assistant message");
		}
		segments.push(current);
		current = [];
	}

	if (!changed) return { messages: [message], changed: false };
	if (current.length === 0) {
		throw new ReplayMarkerError("Pause boundary cannot end an Anthropic assistant message");
	}
	segments.push(current);
	return {
		messages: segments.map((content) => ({ ...message, content })),
		changed: true,
	};
}

export function restoreClaudeReplayPayload(payload: unknown): PayloadRewriteResult {
	if (!isRecord(payload) || !Array.isArray(payload.messages)) return { payload, changed: false };

	let changed = false;
	const messages: unknown[] = [];
	for (const message of payload.messages) {
		if (!isRecord(message)) {
			messages.push(message);
			continue;
		}
		const restored = restoreAssistantMessage(message);
		changed ||= restored.changed;
		messages.push(...restored.messages);
	}

	return changed ? { payload: { ...payload, messages }, changed: true } : { payload, changed: false };
}

export function injectClaudeWebSearch(payload: unknown, model: ModelIdentity | undefined): PayloadRewriteResult {
	if (!getClaudeWebSearchRoute(model) || !isRecord(payload)) return { payload, changed: false };
	if (payload.tools !== undefined && !Array.isArray(payload.tools)) return { payload, changed: false };

	const tools = payload.tools ?? [];
	if (
		tools.some(
			(tool) =>
				isRecord(tool) &&
				typeof tool.type === "string" &&
				CLAUDE_WEB_SEARCH_TOOL_TYPES.has(tool.type),
		)
	) {
		return { payload, changed: false };
	}

	return {
		payload: {
			...payload,
			tools: [...tools, { type: CLAUDE_WEB_SEARCH_TOOL_TYPE, name: "web_search" }],
		},
		changed: true,
	};
}

export function prepareClaudeWebSearchPayload(payload: unknown, model: ModelIdentity | undefined): unknown {
	if (!getClaudeWebSearchRoute(model)) return payload;
	const restored = restoreClaudeReplayPayload(payload);
	const injected = injectClaudeWebSearch(restored.payload, model);
	return restored.changed || injected.changed ? injected.payload : payload;
}
