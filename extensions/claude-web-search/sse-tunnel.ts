import { encodeServerBlockMarker, type ReplayableServerBlock } from "./protocol.ts";

interface ParsedSseEvent {
	event: string | null;
	data: string;
	raw: string;
}

interface PendingServerBlock {
	block: ReplayableServerBlock;
	partialJson: string;
}

export class SseTunnelError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SseTunnelError";
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function findEventBoundary(text: string): { index: number; length: number } | undefined {
	const boundaries = [
		{ token: "\r\n\r\n", length: 4 },
		{ token: "\n\n", length: 2 },
		{ token: "\r\r", length: 2 },
	]
		.map(({ token, length }) => ({ index: text.indexOf(token), length }))
		.filter(({ index }) => index !== -1)
		.sort((left, right) => left.index - right.index || right.length - left.length);
	return boundaries[0];
}

function parseSseEvent(raw: string): ParsedSseEvent {
	let event: string | null = null;
	const data: string[] = [];
	for (const line of raw.split(/\r\n|\r|\n/)) {
		if (!line || line.startsWith(":")) continue;
		const separator = line.indexOf(":");
		const field = separator === -1 ? line : line.slice(0, separator);
		let value = separator === -1 ? "" : line.slice(separator + 1);
		if (value.startsWith(" ")) value = value.slice(1);
		if (field === "event") event = value;
		if (field === "data") data.push(value);
	}
	return { event, data: data.join("\n"), raw };
}

function formatSseEvent(event: string, data: unknown): string {
	return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function syntheticThinkingEvents(index: number, signature: string): string {
	return [
		formatSseEvent("content_block_start", {
			type: "content_block_start",
			index,
			content_block: { type: "thinking", thinking: "", signature: "" },
		}),
		formatSseEvent("content_block_delta", {
			type: "content_block_delta",
			index,
			delta: { type: "signature_delta", signature },
		}),
		formatSseEvent("content_block_stop", { type: "content_block_stop", index }),
	].join("");
}

function cloneReplayableBlock(value: Record<string, unknown>): ReplayableServerBlock {
	return structuredClone(value) as ReplayableServerBlock;
}

function parseJsonRecord(data: string): Record<string, unknown> | undefined {
	try {
		const value: unknown = JSON.parse(data);
		return isRecord(value) ? value : undefined;
	} catch {
		return undefined;
	}
}

export class AnthropicSseTunnel {
	private buffer = "";
	private readonly pending = new Map<number, PendingServerBlock>();

	push(chunk: string): string {
		this.buffer += chunk;
		let output = "";
		let boundary = findEventBoundary(this.buffer);
		while (boundary) {
			const raw = this.buffer.slice(0, boundary.index);
			this.buffer = this.buffer.slice(boundary.index + boundary.length);
			if (raw) output += this.transformEvent(parseSseEvent(raw));
			boundary = findEventBoundary(this.buffer);
		}
		return output;
	}

	finish(): string {
		let output = "";
		if (this.buffer) {
			output += this.transformEvent(parseSseEvent(this.buffer));
			this.buffer = "";
		}
		if (this.pending.size > 0) {
			throw new SseTunnelError("Anthropic stream ended before a native server-tool block completed");
		}
		return output;
	}

	private transformEvent(event: ParsedSseEvent): string {
		const parsed = parseJsonRecord(event.data);
		if (!parsed) return `${event.raw}\n\n`;

		if (parsed.type === "content_block_start") {
			const index = parsed.index;
			const contentBlock = parsed.content_block;
			if (
				typeof index === "number" &&
				isRecord(contentBlock) &&
				(contentBlock.type === "server_tool_use" || contentBlock.type === "web_search_tool_result")
			) {
				if (this.pending.has(index)) {
					throw new SseTunnelError(`Duplicate native server-tool block index ${index}`);
				}
				this.pending.set(index, {
					block: cloneReplayableBlock(contentBlock),
					partialJson: "",
				});
				return "";
			}
		}

		if (parsed.type === "content_block_delta" && typeof parsed.index === "number") {
			const pending = this.pending.get(parsed.index);
			if (pending) {
				const delta = parsed.delta;
				if (isRecord(delta) && delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
					if (pending.block.type !== "server_tool_use") {
						throw new SseTunnelError("Received server-tool input JSON for a web-search result block");
					}
					pending.partialJson += delta.partial_json;
					return "";
				}
				throw new SseTunnelError(`Unsupported delta for native server-tool block index ${parsed.index}`);
			}
		}

		if (parsed.type === "content_block_stop" && typeof parsed.index === "number") {
			const pending = this.pending.get(parsed.index);
			if (pending) {
				this.pending.delete(parsed.index);
				if (pending.block.type === "server_tool_use" && pending.partialJson) {
					try {
						pending.block.input = JSON.parse(pending.partialJson);
					} catch (error) {
						throw new SseTunnelError(
							`Could not parse streamed web_search input: ${error instanceof Error ? error.message : String(error)}`,
						);
					}
				}
				return syntheticThinkingEvents(parsed.index, encodeServerBlockMarker(pending.block));
			}
		}

		if (parsed.type === "message_stop" && this.pending.size > 0) {
			throw new SseTunnelError("Anthropic message stopped before a native server-tool block completed");
		}

		return `${event.raw}\n\n`;
	}
}

export function tunnelAnthropicSseBody(
	body: ReadableStream<Uint8Array>,
	signal?: AbortSignal,
): ReadableStream<Uint8Array> {
	const decoder = new TextDecoder();
	const encoder = new TextEncoder();
	const tunnel = new AnthropicSseTunnel();
	return body.pipeThrough(
		new TransformStream<Uint8Array, Uint8Array>({
			transform(chunk, controller) {
				if (signal?.aborted) throw new SseTunnelError("Anthropic response tunneling was cancelled");
				const output = tunnel.push(decoder.decode(chunk, { stream: true }));
				if (output) controller.enqueue(encoder.encode(output));
			},
			flush(controller) {
				const output = tunnel.push(decoder.decode()) + tunnel.finish();
				if (output) controller.enqueue(encoder.encode(output));
			},
		}),
	);
}

export function createReplaySafeFetch(baseFetch: typeof globalThis.fetch): typeof globalThis.fetch {
	return async (input, init) => {
		const response = await baseFetch(input, init);
		if (!response.body || !response.headers.get("content-type")?.toLowerCase().includes("text/event-stream")) {
			return response;
		}
		return new Response(tunnelAnthropicSseBody(response.body, init?.signal ?? undefined), {
			status: response.status,
			statusText: response.statusText,
			headers: response.headers,
		});
	};
}
