import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	createHostedSearchObservingFetch,
	HostedSearchSseCollector,
	HostedSearchSseError,
} from "../hosted-search-sse.ts";

function event(name: string, data: unknown, newline = "\n"): string {
	return `event: ${name}${newline}data: ${JSON.stringify(data)}${newline}${newline}`;
}

function feedInChunks(collector: HostedSearchSseCollector, input: string, sizes: number[]): void {
	let offset = 0;
	for (const size of sizes) {
		collector.push(input.slice(offset, offset + size));
		offset += size;
	}
	collector.push(input.slice(offset));
	collector.finish();
}

function malformedKimiSearchStream(): string {
	return [
		event("content_block_start", {
			type: "content_block_start",
			index: 0,
			content_block: { type: "server_tool_use", id: null, name: "web_search" },
		}),
		event("content_block_delta", {
			type: "content_block_delta",
			index: 0,
			delta: { type: "input_json_delta", partial_json: '{"query":"Pi cache"}' },
		}),
		event("content_block_stop", { type: "content_block_stop", index: 0 }),
		event("content_block_start", {
			type: "content_block_start",
			index: 1,
			content_block: {
				type: "web_search_tool_result",
				tool_use_id: "mismatched-id",
				content: [
					{
						type: "web_search_result",
						encrypted_content: "opaque",
						title: "Pi cache behavior",
						url: "https://example.com/pi-cache",
						page_age: null,
					},
				],
			},
		}),
		event("content_block_stop", { type: "content_block_stop", index: 1 }),
		event("content_block_start", {
			type: "content_block_start",
			index: 2,
			content_block: { type: "text", text: "", citations: null },
		}),
		event("content_block_delta", {
			type: "content_block_delta",
			index: 2,
			delta: { type: "text_delta", text: "A concise synthesis." },
		}),
		event("content_block_stop", { type: "content_block_stop", index: 2 }),
		event("message_stop", { type: "message_stop" }),
	].join("");
}

describe("hosted-search SSE collector", () => {
	it("collects results across arbitrary chunks and repairs IDs only in memory", () => {
		const updates: number[] = [];
		const collector = new HostedSearchSseCollector((count) => updates.push(count));
		feedInChunks(collector, malformedKimiSearchStream(), [1, 2, 5, 13, 21, 34, 55]);
		const snapshot = collector.snapshot();
		assert.deepEqual(snapshot.text, ["A concise synthesis."]);
		assert.deepEqual(snapshot.sources, [
			{
				title: "Pi cache behavior",
				url: "https://example.com/pi-cache",
				pageAge: null,
			},
		]);
		assert.deepEqual(updates, [1]);
		const use = snapshot.content[0];
		const result = snapshot.content[1];
		assert.equal(use?.type, "server_tool_use");
		assert.match(String(use?.id), /^srvtoolu_pi_/);
		assert.deepEqual(use?.input, { query: "Pi cache" });
		assert.equal(result?.type, "web_search_tool_result");
		assert.equal(result?.tool_use_id, use?.id);
	});

	it("preserves thinking signatures and citation deltas for an in-memory pause continuation", () => {
		const input = [
			event("content_block_start", {
				type: "content_block_start",
				index: 0,
				content_block: { type: "thinking", thinking: "", signature: "" },
			}),
			event("content_block_delta", {
				type: "content_block_delta",
				index: 0,
				delta: { type: "thinking_delta", thinking: "searching" },
			}),
			event("content_block_delta", {
				type: "content_block_delta",
				index: 0,
				delta: { type: "signature_delta", signature: "signed" },
			}),
			event("content_block_stop", { type: "content_block_stop", index: 0 }),
			event("content_block_start", {
				type: "content_block_start",
				index: 1,
				content_block: { type: "text", text: "", citations: [] },
			}),
			event("content_block_delta", {
				type: "content_block_delta",
				index: 1,
				delta: { type: "citations_delta", citation: { type: "web_search_result_location", url: "https://example.com" } },
			}),
			event("content_block_stop", { type: "content_block_stop", index: 1 }),
		].join("");
		const collector = new HostedSearchSseCollector();
		feedInChunks(collector, input, [7, 19]);
		assert.deepEqual(collector.snapshot().content, [
			{ type: "thinking", thinking: "searching", signature: "signed" },
			{
				type: "text",
				text: "",
				citations: [{ type: "web_search_result_location", url: "https://example.com" }],
			},
		]);
	});

	it("passes the provider response body through byte-for-byte while observing it", async () => {
		const input = malformedKimiSearchStream();
		const collector = new HostedSearchSseCollector();
		const baseFetch: typeof globalThis.fetch = async () =>
			new Response(input, { headers: { "content-type": "text/event-stream" } });
		const response = await createHostedSearchObservingFetch(baseFetch, collector)("https://example.test");
		assert.equal(await response.text(), input);
		assert.equal(collector.snapshot().sources.length, 1);
	});

	it("fails clearly for incomplete or out-of-order server blocks", () => {
		const incomplete = new HostedSearchSseCollector();
		incomplete.push(
			event("content_block_start", {
				type: "content_block_start",
				index: 0,
				content_block: { type: "server_tool_use", id: "srv", name: "web_search" },
			}),
		);
		assert.throws(() => incomplete.finish(), HostedSearchSseError);

		const orphan = new HostedSearchSseCollector();
		assert.throws(
			() =>
				feedInChunks(
					orphan,
					event("content_block_start", {
						type: "content_block_start",
						index: 0,
						content_block: { type: "web_search_tool_result", content: [] },
					}) + event("content_block_stop", { type: "content_block_stop", index: 0 }),
					[],
				),
			/no preceding server-tool call/,
		);
	});
});
