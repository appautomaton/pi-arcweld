import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	buildHostedSearchPayload,
	getHostedWebSearchRoute,
	HOSTED_WEB_SEARCH_MAX_USES,
	HOSTED_WEB_SEARCH_TOOL_NAME,
	HOSTED_WEB_SEARCH_TOOL_TYPE,
} from "../payload.ts";

const cpaClaude = { provider: "cli-proxy-api-anthropic", api: "anthropic-messages", id: "claude-opus-5" };

function basePayload(text = "Perform a web search for the query: Pi") {
	return {
		model: cpaClaude.id,
		max_tokens: 8192,
		stream: true,
		system: [{ type: "text", text: "fixed", cache_control: { type: "ephemeral" } }],
		messages: [{ role: "user", content: [{ type: "text", text, cache_control: { type: "ephemeral" } }] }],
	};
}

describe("isolated hosted-search payload", () => {
	it("supports only the intended Anthropic Messages Claude/Kimi routes", () => {
		assert.equal(getHostedWebSearchRoute(cpaClaude), "cli-proxy-api-anthropic");
		assert.equal(
			getHostedWebSearchRoute({ provider: "cli-proxy-api-anthropic", api: "anthropic-messages", id: "kimi-k3" }),
			"cli-proxy-api-anthropic",
		);
		assert.equal(
			getHostedWebSearchRoute({ provider: "anthropic", api: "anthropic-messages", id: "claude-sonnet-5" }),
			"anthropic",
		);
		assert.equal(getHostedWebSearchRoute({ provider: "anthropic", api: "anthropic-messages", id: "other" }), undefined);
		assert.equal(getHostedWebSearchRoute({ provider: "kimi-coding", api: "anthropic-messages", id: "kimi" }), undefined);
		assert.equal(getHostedWebSearchRoute({ provider: "cli-proxy-api-anthropic", api: "openai-completions", id: "kimi-k3" }), undefined);
	});

	it("replaces the isolated request tool list without mutating its stable prefix", () => {
		const original = basePayload();
		const rewritten = buildHostedSearchPayload(original, { query: "Pi" }) as typeof original & {
			tools: Array<Record<string, unknown>>;
		};
		assert.notEqual(rewritten, original);
		assert.deepEqual(rewritten.system, original.system);
		assert.deepEqual(rewritten.messages, original.messages);
		assert.equal((original as Record<string, unknown>).tools, undefined);
		assert.deepEqual(rewritten.tools, [
			{
				type: HOSTED_WEB_SEARCH_TOOL_TYPE,
				name: HOSTED_WEB_SEARCH_TOOL_NAME,
				max_uses: HOSTED_WEB_SEARCH_MAX_USES,
			},
		]);
	});

	it("keeps the tool schema byte-stable across different queries", () => {
		const first = buildHostedSearchPayload(basePayload("Perform a web search for the query: alpha"), {
			query: "alpha",
		}) as Record<string, unknown>;
		const second = buildHostedSearchPayload(basePayload("Perform a web search for the query: beta"), {
			query: "beta",
		}) as Record<string, unknown>;
		assert.equal(JSON.stringify(first.system), JSON.stringify(second.system));
		assert.equal(JSON.stringify(first.tools), JSON.stringify(second.tools));
		assert.notEqual(JSON.stringify(first.messages), JSON.stringify(second.messages));
	});

	it("adds domain filters only to the isolated hosted tool", () => {
		const rewritten = buildHostedSearchPayload(basePayload(), {
			query: "Pi",
			allowedDomains: ["example.com"],
		}) as { tools: Array<Record<string, unknown>> };
		assert.deepEqual(rewritten.tools[0]?.allowed_domains, ["example.com"]);
		assert.equal(rewritten.tools[0]?.blocked_domains, undefined);
	});

	it("appends in-memory pause history after the single user message", () => {
		const assistant = {
			role: "assistant",
			content: [{ type: "server_tool_use", id: "srv_1", name: "web_search", input: { query: "Pi" } }],
		};
		const rewritten = buildHostedSearchPayload(basePayload(), {
			query: "Pi",
			assistantHistory: [assistant],
		}) as { messages: Array<Record<string, unknown>> };
		assert.equal(rewritten.messages.length, 2);
		assert.deepEqual(rewritten.messages[1], assistant);
	});

	it("fails closed when called with a non-isolated base payload", () => {
		assert.throws(() => buildHostedSearchPayload({}, { query: "Pi" }), /exactly one user message/);
		assert.throws(
			() => buildHostedSearchPayload({ messages: [{ role: "user" }, { role: "assistant" }] }, { query: "Pi" }),
			/exactly one user message/,
		);
	});
});
