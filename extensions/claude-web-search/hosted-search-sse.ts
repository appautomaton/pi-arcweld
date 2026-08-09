let collectorSequence = 0;

interface ParsedSseEvent {
	data: string;
}

interface PendingBlock {
	block: Record<string, unknown>;
	partialJson: string;
}

export interface HostedSearchSource {
	title: string;
	url: string;
	pageAge?: string | null;
}

export interface HostedSearchSnapshot {
	content: Array<Record<string, unknown>>;
	text: string[];
	sources: HostedSearchSource[];
	errors: string[];
}

export class HostedSearchSseError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "HostedSearchSseError";
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneRecord(value: Record<string, unknown>): Record<string, unknown> {
	return structuredClone(value);
}

function findEventBoundary(text: string): { index: number; length: number } | undefined {
	const candidates = [
		{ index: text.indexOf("\r\n\r\n"), length: 4 },
		{ index: text.indexOf("\n\n"), length: 2 },
		{ index: text.indexOf("\r\r"), length: 2 },
	]
		.filter(({ index }) => index >= 0)
		.sort((left, right) => left.index - right.index || right.length - left.length);
	return candidates[0];
}

function parseSseEvent(raw: string): ParsedSseEvent {
	const data: string[] = [];
	for (const line of raw.split(/\r\n|\r|\n/)) {
		if (!line || line.startsWith(":")) continue;
		const separator = line.indexOf(":");
		const field = separator === -1 ? line : line.slice(0, separator);
		let value = separator === -1 ? "" : line.slice(separator + 1);
		if (value.startsWith(" ")) value = value.slice(1);
		if (field === "data") data.push(value);
	}
	return { data: data.join("\n") };
}

function parseJsonRecord(data: string): Record<string, unknown> | undefined {
	try {
		const parsed: unknown = JSON.parse(data);
		return isRecord(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

function appendString(block: Record<string, unknown>, key: string, delta: unknown): void {
	if (typeof delta !== "string") return;
	block[key] = `${typeof block[key] === "string" ? block[key] : ""}${delta}`;
}

export class HostedSearchSseCollector {
	private buffer = "";
	private readonly pending = new Map<number, PendingBlock>();
	private readonly completed = new Map<number, Record<string, unknown>>();
	private readonly repairScope = (++collectorSequence).toString(36);
	private readonly serverToolIds: string[] = [];
	private serverResultCount = 0;
	private repairCount = 0;

	constructor(private readonly onResultCount?: (count: number) => void) {}

	push(chunk: string): void {
		this.buffer += chunk;
		let boundary = findEventBoundary(this.buffer);
		while (boundary) {
			const raw = this.buffer.slice(0, boundary.index);
			this.buffer = this.buffer.slice(boundary.index + boundary.length);
			if (raw) this.consume(parseSseEvent(raw));
			boundary = findEventBoundary(this.buffer);
		}
	}

	finish(): void {
		if (this.buffer) {
			this.consume(parseSseEvent(this.buffer));
			this.buffer = "";
		}
		if (this.pending.size > 0) {
			throw new HostedSearchSseError("Hosted-search stream ended before a content block completed");
		}
	}

	snapshot(): HostedSearchSnapshot {
		const content = [...this.completed.entries()]
			.sort(([left], [right]) => left - right)
			.map(([, block]) => cloneRecord(block));
		const text: string[] = [];
		const sources: HostedSearchSource[] = [];
		const errors: string[] = [];

		for (const block of content) {
			if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
				text.push(block.text.trim());
				continue;
			}
			if (block.type !== "web_search_tool_result") continue;
			if (Array.isArray(block.content)) {
				for (const item of block.content) {
					if (!isRecord(item) || item.type !== "web_search_result") continue;
					if (typeof item.url !== "string" || !item.url.trim()) continue;
					sources.push({
						title: typeof item.title === "string" && item.title.trim() ? item.title.trim() : item.url,
						url: item.url.trim(),
						...(typeof item.page_age === "string" || item.page_age === null ? { pageAge: item.page_age } : {}),
					});
				}
			} else if (isRecord(block.content) && typeof block.content.error_code === "string") {
				errors.push(block.content.error_code);
			}
		}

		return { content, text, sources, errors };
	}

	private normalizeCompletedBlock(block: Record<string, unknown>, index: number, partialJson: string): void {
		if (block.type === "server_tool_use") {
			if (typeof block.id !== "string" || !block.id.trim()) {
				block.id = `srvtoolu_pi_${this.repairScope}_${index}_${++this.repairCount}`;
			}
			if (partialJson) {
				try {
					block.input = JSON.parse(partialJson);
				} catch (error) {
					throw new HostedSearchSseError(
						`Could not parse hosted web-search input: ${error instanceof Error ? error.message : String(error)}`,
					);
				}
			} else if (!("input" in block) || block.input == null) {
				block.input = {};
			}
			this.serverToolIds.push(block.id as string);
			return;
		}

		if (block.type === "web_search_tool_result") {
			const expectedId = this.serverToolIds[this.serverResultCount++];
			if (!expectedId) {
				throw new HostedSearchSseError("Hosted web-search result had no preceding server-tool call");
			}
			block.tool_use_id = expectedId;
			this.onResultCount?.(this.serverResultCount);
		}
	}

	private consume(event: ParsedSseEvent): void {
		const parsed = parseJsonRecord(event.data);
		if (!parsed) return;

		if (parsed.type === "content_block_start") {
			const index = parsed.index;
			const contentBlock = parsed.content_block;
			if (typeof index !== "number" || !isRecord(contentBlock)) return;
			if (this.pending.has(index) || this.completed.has(index)) {
				throw new HostedSearchSseError(`Duplicate hosted-search content block index ${index}`);
			}
			this.pending.set(index, { block: cloneRecord(contentBlock), partialJson: "" });
			return;
		}

		if (parsed.type === "content_block_delta" && typeof parsed.index === "number") {
			const pending = this.pending.get(parsed.index);
			if (!pending || !isRecord(parsed.delta)) return;
			switch (parsed.delta.type) {
				case "input_json_delta":
					if (typeof parsed.delta.partial_json === "string") pending.partialJson += parsed.delta.partial_json;
					break;
				case "text_delta":
					appendString(pending.block, "text", parsed.delta.text);
					break;
				case "thinking_delta":
					appendString(pending.block, "thinking", parsed.delta.thinking);
					break;
				case "signature_delta":
					appendString(pending.block, "signature", parsed.delta.signature);
					break;
				case "citations_delta": {
					const citations = Array.isArray(pending.block.citations) ? pending.block.citations : [];
					if (parsed.delta.citation !== undefined) citations.push(parsed.delta.citation);
					pending.block.citations = citations;
					break;
				}
			}
			return;
		}

		if (parsed.type === "content_block_stop" && typeof parsed.index === "number") {
			const pending = this.pending.get(parsed.index);
			if (!pending) return;
			this.pending.delete(parsed.index);
			this.normalizeCompletedBlock(pending.block, parsed.index, pending.partialJson);
			this.completed.set(parsed.index, pending.block);
			return;
		}

		if (parsed.type === "message_stop" && this.pending.size > 0) {
			throw new HostedSearchSseError("Hosted-search message stopped before a content block completed");
		}
	}
}

export function createHostedSearchObservingFetch(
	baseFetch: typeof globalThis.fetch,
	collector: HostedSearchSseCollector,
	signal?: AbortSignal,
): typeof globalThis.fetch {
	return async (input, init) => {
		const response = await baseFetch(input, init);
		if (!response.body || !response.headers.get("content-type")?.toLowerCase().includes("text/event-stream")) {
			return response;
		}

		const decoder = new TextDecoder();
		const observed = response.body.pipeThrough(
			new TransformStream<Uint8Array, Uint8Array>({
				transform(chunk, controller) {
					if (signal?.aborted) throw new HostedSearchSseError("Hosted web search was cancelled");
					collector.push(decoder.decode(chunk, { stream: true }));
					controller.enqueue(chunk);
				},
				flush() {
					collector.push(decoder.decode());
					collector.finish();
				},
			}),
		);

		return new Response(observed, {
			status: response.status,
			statusText: response.statusText,
			headers: response.headers,
		});
	};
}
