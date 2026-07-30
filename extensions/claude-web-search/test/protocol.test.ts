import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	decodeReplayMarker,
	encodePauseBoundaryMarker,
	encodeServerBlockMarker,
	ReplayMarkerError,
} from "../protocol.ts";

const serverUse = {
	type: "server_tool_use" as const,
	id: "srvtoolu_01",
	name: "web_search" as const,
	input: { query: "Pi Anthropic web search" },
	caller: { type: "direct" },
};

const searchResult = {
	type: "web_search_tool_result" as const,
	tool_use_id: "srvtoolu_01",
	caller: { type: "direct" },
	content: [
		{
			type: "web_search_result" as const,
			encrypted_content: "encrypted-result",
			title: "Result",
			url: "https://example.com/result",
			page_age: null,
		},
	],
};

describe("replay marker protocol", () => {
	it("round-trips supported Anthropic server blocks", () => {
		assert.deepEqual(decodeReplayMarker(encodeServerBlockMarker(serverUse)), {
			kind: "server_block",
			block: serverUse,
		});
		assert.deepEqual(decodeReplayMarker(encodeServerBlockMarker(searchResult)), {
			kind: "server_block",
			block: searchResult,
		});
	});

	it("round-trips pause boundaries", () => {
		assert.deepEqual(decodeReplayMarker(encodePauseBoundaryMarker()), { kind: "pause_boundary" });
	});

	it("ignores ordinary Anthropic signatures", () => {
		assert.equal(decodeReplayMarker("CAIS-anthropic-signature"), undefined);
		assert.equal(decodeReplayMarker(undefined), undefined);
	});

	it("rejects malformed and unsupported markers", () => {
		assert.throws(
			() => decodeReplayMarker("pi-arcweld:claude-web-search:v1:not+base64"),
			ReplayMarkerError,
		);
		assert.throws(
			() =>
				encodeServerBlockMarker({
					type: "server_tool_use",
					id: "srvtoolu_01",
					name: "code_execution",
					input: {},
				}),
			ReplayMarkerError,
		);
		assert.throws(
			() =>
				encodeServerBlockMarker({
					type: "web_search_tool_result",
					tool_use_id: "srvtoolu_01",
					content: [{ type: "web_search_result", title: "Missing encrypted content", url: "https://example.com" }],
				}),
			ReplayMarkerError,
		);
	});
});
