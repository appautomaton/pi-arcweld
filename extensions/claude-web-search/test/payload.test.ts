import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	getClaudeWebSearchRoute,
	injectClaudeWebSearch,
	prepareClaudeWebSearchPayload,
	restoreClaudeReplayPayload,
} from "../payload.ts";
import { encodePauseBoundaryMarker, encodeServerBlockMarker, ReplayMarkerError } from "../protocol.ts";

const model = { provider: "cli-proxy-api-anthropic", api: "anthropic-messages", id: "claude-opus-5" };
const serverUse = {
	type: "server_tool_use" as const,
	id: "srvtoolu_01",
	name: "web_search" as const,
	input: { query: "Chrome DevTools MCP" },
	caller: { type: "direct" },
};
const searchResult = {
	type: "web_search_tool_result" as const,
	tool_use_id: "srvtoolu_01",
	caller: { type: "direct" },
	content: [
		{
			type: "web_search_result" as const,
			encrypted_content: "encrypted-content",
			title: "Chrome DevTools MCP",
			url: "https://example.com/chrome-devtools",
		},
	],
};

function marker(signature: string) {
	return { type: "thinking", thinking: "", signature };
}

describe("Claude web-search payload rewriting", () => {
	it("identifies only the supported Anthropic routes", () => {
		assert.equal(getClaudeWebSearchRoute(model), "cli-proxy-api-anthropic");
		assert.equal(
			getClaudeWebSearchRoute({ provider: "anthropic", api: "anthropic-messages", id: "claude-sonnet-5" }),
			"anthropic",
		);
		assert.equal(getClaudeWebSearchRoute({ provider: "kimi-coding", api: "anthropic-messages", id: "kimi" }), undefined);
	});

	it("restores server blocks in exact order and injects native search once", () => {
		const payload = {
			model: model.id,
			messages: [
				{ role: "user", content: [{ type: "text", text: "Search, then inspect locally" }] },
				{
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "", signature: "thinking-a" },
						marker(encodeServerBlockMarker(serverUse)),
						marker(encodeServerBlockMarker(searchResult)),
						{ type: "thinking", thinking: "", signature: "thinking-b" },
						{ type: "tool_use", id: "toolu_bash", name: "bash", input: { command: "pwd" } },
					],
				},
			],
			tools: [{ name: "bash", input_schema: { type: "object" } }],
		};

		const rewritten = prepareClaudeWebSearchPayload(payload, model) as typeof payload;
		assert.notEqual(rewritten, payload);
		assert.deepEqual(rewritten.messages[1]?.content, [
			{ type: "thinking", thinking: "", signature: "thinking-a" },
			serverUse,
			searchResult,
			{ type: "thinking", thinking: "", signature: "thinking-b" },
			{ type: "tool_use", id: "toolu_bash", name: "bash", input: { command: "pwd" } },
		]);
		assert.deepEqual(rewritten.tools.at(-1), { type: "web_search_20250305", name: "web_search" });
	});

	it("expands pause boundaries into consecutive assistant messages", () => {
		const payload = {
			messages: [
				{
					role: "assistant",
					content: [
						marker(encodeServerBlockMarker(serverUse)),
						marker(encodePauseBoundaryMarker()),
						marker(encodeServerBlockMarker(searchResult)),
						{ type: "text", text: "Finished" },
					],
				},
			],
		};
		const restored = restoreClaudeReplayPayload(payload);
		assert.equal(restored.changed, true);
		assert.deepEqual((restored.payload as typeof payload).messages, [
			{ role: "assistant", content: [serverUse] },
			{ role: "assistant", content: [searchResult, { type: "text", text: "Finished" }] },
		]);
	});

	it("does not duplicate an existing native search declaration", () => {
		const payload = { tools: [{ type: "web_search_20260209", name: "web_search" }] };
		const injected = injectClaudeWebSearch(payload, model);
		assert.equal(injected.changed, false);
		assert.equal(injected.payload, payload);
	});

	it("leaves ineligible provider payloads untouched", () => {
		const payload = { messages: [], tools: [] };
		const result = prepareClaudeWebSearchPayload(payload, {
			provider: "kimi-coding",
			api: "anthropic-messages",
			id: "kimi",
		});
		assert.equal(result, payload);
	});

	it("fails closed for malformed marker placement", () => {
		assert.throws(
			() =>
				restoreClaudeReplayPayload({
					messages: [{ role: "assistant", content: [marker(encodePauseBoundaryMarker())] }],
				}),
			ReplayMarkerError,
		);
		assert.throws(
			() =>
				restoreClaudeReplayPayload({
					messages: [{ role: "user", content: [marker(encodeServerBlockMarker(serverUse))] }],
				}),
			ReplayMarkerError,
		);
	});
});
