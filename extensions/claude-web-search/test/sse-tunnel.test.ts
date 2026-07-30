import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decodeReplayMarker } from "../protocol.ts";
import { AnthropicSseTunnel, SseTunnelError } from "../sse-tunnel.ts";

function event(name: string, data: unknown, newline = "\n"): string {
	return `event: ${name}${newline}data: ${JSON.stringify(data)}${newline}${newline}`;
}

function parseEvents(text: string): Array<Record<string, unknown>> {
	return text
		.split(/\r?\n\r?\n/)
		.filter(Boolean)
		.map((raw) => {
			const data = raw
				.split(/\r?\n/)
				.filter((line) => line.startsWith("data:"))
				.map((line) => line.slice(5).trimStart())
				.join("\n");
			return JSON.parse(data) as Record<string, unknown>;
		});
}

function tunnelInChunks(input: string, sizes: number[]): string {
	const tunnel = new AnthropicSseTunnel();
	let offset = 0;
	let output = "";
	for (const size of sizes) {
		output += tunnel.push(input.slice(offset, offset + size));
		offset += size;
	}
	output += tunnel.push(input.slice(offset));
	output += tunnel.finish();
	return output;
}

describe("Anthropic SSE replay tunnel", () => {
	it("preserves a mixed native-search and client-tool response across arbitrary chunks", () => {
		const input = [
			event("content_block_start", {
				type: "content_block_start",
				index: 0,
				content_block: { type: "thinking", thinking: "", signature: "" },
			}),
			event("content_block_delta", {
				type: "content_block_delta",
				index: 0,
				delta: { type: "signature_delta", signature: "thinking-a" },
			}),
			event("content_block_stop", { type: "content_block_stop", index: 0 }),
			event("content_block_start", {
				type: "content_block_start",
				index: 1,
				content_block: {
					type: "server_tool_use",
					id: "srvtoolu_01",
					name: "web_search",
					input: {},
					caller: { type: "direct" },
				},
			}),
			event("content_block_delta", {
				type: "content_block_delta",
				index: 1,
				delta: { type: "input_json_delta", partial_json: '{"query":"Chrome' },
			}),
			event("content_block_delta", {
				type: "content_block_delta",
				index: 1,
				delta: { type: "input_json_delta", partial_json: ' DevTools"}' },
			}),
			event("content_block_stop", { type: "content_block_stop", index: 1 }),
			event("content_block_start", {
				type: "content_block_start",
				index: 2,
				content_block: {
					type: "web_search_tool_result",
					tool_use_id: "srvtoolu_01",
					caller: { type: "direct" },
					content: [
						{
							type: "web_search_result",
							encrypted_content: "encrypted",
							title: "Chrome DevTools",
							url: "https://example.com/chrome",
						},
					],
				},
			}),
			event("content_block_stop", { type: "content_block_stop", index: 2 }),
			event("content_block_start", {
				type: "content_block_start",
				index: 3,
				content_block: { type: "tool_use", id: "toolu_bash", name: "bash", input: {} },
			}),
		].join("");

		const output = tunnelInChunks(input, [1, 2, 5, 13, 21, 34, 55]);
		const events = parseEvents(output);
		assert.equal(events.filter((entry) => entry.type === "content_block_start").length, 4);
		const markerDeltas = events.filter(
			(entry) =>
				entry.type === "content_block_delta" &&
				typeof entry.delta === "object" &&
				entry.delta !== null &&
				(entry.delta as { type?: string }).type === "signature_delta" &&
				(entry.delta as { signature?: string }).signature?.startsWith("pi-arcweld:"),
		);
		assert.equal(markerDeltas.length, 2);

		const decoded = markerDeltas.map((entry) =>
			decodeReplayMarker((entry.delta as { signature: string }).signature),
		);
		assert.deepEqual(decoded[0], {
			kind: "server_block",
			block: {
				type: "server_tool_use",
				id: "srvtoolu_01",
				name: "web_search",
				input: { query: "Chrome DevTools" },
				caller: { type: "direct" },
			},
		});
		assert.equal(decoded[1]?.kind, "server_block");
		if (decoded[1]?.kind === "server_block") {
			assert.equal(decoded[1].block.type, "web_search_tool_result");
		}
		assert.equal(events.at(-1)?.type, "content_block_start");
		assert.equal(events.at(-1)?.index, 3);
	});

	it("handles CRLF and result-error blocks", () => {
		const input =
			event(
				"content_block_start",
				{
					type: "content_block_start",
					index: 0,
					content_block: {
						type: "web_search_tool_result",
						tool_use_id: "srvtoolu_02",
						content: { type: "web_search_tool_result_error", error_code: "unavailable" },
					},
				},
				"\r\n",
			) + event("content_block_stop", { type: "content_block_stop", index: 0 }, "\r\n");
		const output = tunnelInChunks(input, [3, 8, 17]);
		const marker = parseEvents(output).find((entry) => entry.type === "content_block_delta");
		assert.ok(marker);
		const decoded = decodeReplayMarker((marker.delta as { signature: string }).signature);
		assert.equal(decoded?.kind, "server_block");
		if (decoded?.kind === "server_block" && decoded.block.type === "web_search_tool_result") {
			assert.deepEqual(decoded.block.content, { type: "web_search_tool_result_error", error_code: "unavailable" });
		}
	});

	it("forwards unrelated SSE events semantically unchanged", () => {
		const input = event("message_start", { type: "message_start", message: { id: "msg_01" } });
		assert.deepEqual(parseEvents(tunnelInChunks(input, [4, 7])), [
			{ type: "message_start", message: { id: "msg_01" } },
		]);
	});

	it("fails if a native block never completes", () => {
		const tunnel = new AnthropicSseTunnel();
		tunnel.push(
			event("content_block_start", {
				type: "content_block_start",
				index: 0,
				content_block: { type: "server_tool_use", id: "srvtoolu_01", name: "web_search", input: {} },
			}),
		);
		assert.throws(() => tunnel.finish(), SseTunnelError);
	});
});
