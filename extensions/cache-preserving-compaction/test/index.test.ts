import assert from "node:assert/strict";
import test from "node:test";
import type { AssistantMessage, Provider, Tool, Usage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import extension, {
	buildSummaryContext,
	preserveToolPayload,
	summaryPrompt,
	summaryText,
	type RequestSnapshot,
} from "../index.ts";

const usage = (overrides: Partial<Usage> = {}): Usage => ({
	input: 3,
	output: 2,
	cacheRead: 100,
	cacheWrite: 0,
	totalTokens: 105,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	...overrides,
});

function assistant(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "summary" }],
		api: "openai-completions",
		provider: "test-provider",
		model: "test-model",
		usage: usage(),
		stopReason: "stop",
		timestamp: Date.now(),
		...overrides,
	};
}

function streamResult(message: AssistantMessage) {
	return { result: async () => message };
}

type Handler = (event: any, ctx: ExtensionContext) => Promise<unknown> | unknown;

class FakePi {
	readonly handlers = new Map<string, Handler>();
	readonly tools: Tool[] = [
		{ name: "read", description: "read", parameters: { type: "object", properties: {} } as Tool["parameters"] },
	];

	on(event: string, handler: Handler): void {
		this.handlers.set(event, handler);
	}
	getActiveTools(): string[] {
		return this.tools.map((tool) => tool.name);
	}
	getAllTools() {
		return this.tools.map((tool) => ({ ...tool, sourceInfo: {} }));
	}
	handler(name: string): Handler {
		const handler = this.handlers.get(name);
		assert.ok(handler, `missing ${name} handler`);
		return handler;
	}
}

function createContext(provider: Provider, notifications: string[] = [], sessionId = "session-1"): ExtensionContext {
	const model = {
		id: "test-model",
		name: "Test Model",
		api: "openai-completions" as const,
		provider: "test-provider",
		baseUrl: "http://example.invalid/v1",
		reasoning: true,
		input: ["text"] as const,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 32768,
	};
	return {
		hasUI: true,
		thinkingLevel: "high",
		model,
		ui: { notify: (message: string) => notifications.push(message) },
		sessionManager: { getSessionId: () => sessionId },
		isIdle: () => true,
		getSystemPrompt: () => "system",
		modelRegistry: {
			getProvider: () => provider,
			getApiKeyAndHeaders: async () => ({
				ok: true,
				apiKey: "key",
				headers: { authorization: "Bearer key" },
				baseUrl: "http://resolved.invalid/v1",
			}),
		},
	} as unknown as ExtensionContext;
}

function compactionEvent(customInstructions?: string) {
	return {
		preparation: { firstKeptEntryId: "keep-1", tokensBefore: 180000 },
		branchEntries: [],
		customInstructions,
		reason: "threshold",
		willRetry: false,
		signal: new AbortController().signal,
	};
}

test("builds an append-only structured checkpoint request", () => {
	const snapshot: RequestSnapshot = {
		modelKey: "test-provider/test-model",
		systemPrompt: "system",
		messages: [{ role: "user", content: [{ type: "text", text: "work" }], timestamp: 1 }],
		tools: [{ name: "read", description: "read", parameters: { type: "object", properties: {} } as Tool["parameters"] }],
	};
	const context = buildSummaryContext(snapshot, assistant({ content: [{ type: "text", text: "done" }] }), "keep cache data");
	assert.equal(context.systemPrompt, "system");
	assert.equal(context.messages.length, 3);
	assert.equal(context.messages[0].role, "user");
	assert.equal(context.messages[1].role, "assistant");
	assert.equal(context.messages[2].role, "user");
	assert.match(JSON.stringify(context.messages[2]), /Additional user focus/);
	assert.match(JSON.stringify(context.messages[2]), /keep cache data/);
	assert.deepEqual(context.tools, snapshot.tools);
});

test("preserves provider-added tool declarations without rewriting the request", () => {
	const previous = {
		messages: ["old"],
		tools: [{ type: "web_search" }],
		tool_choice: "auto",
		toolConfig: { tools: [{ toolSpec: { name: "read" } }], toolChoice: { auto: {} } },
	};
	const next = { messages: ["new"], tools: [{ type: "function" }], max_tokens: 10 };
	assert.deepEqual(preserveToolPayload(previous, next), {
		messages: ["new"],
		tools: [{ type: "web_search" }],
		tool_choice: "auto",
		toolConfig: { tools: [{ toolSpec: { name: "read" } }], toolChoice: { auto: {} } },
		max_tokens: 10,
	});
	assert.equal(preserveToolPayload({ messages: [] }, next), next);
});

test("keeps the prompt structured and extracts only response text", () => {
	assert.match(summaryPrompt(), /## Goal/);
	assert.match(summaryPrompt(), /Do not continue the task/);
	assert.equal(
		summaryText(assistant({ content: [{ type: "thinking", thinking: "hidden" }, { type: "text", text: " checkpoint " }] })),
		"checkpoint",
	);
});

test("replays the last native request and returns a Pi compaction result", async () => {
	let receivedModel: any;
	let receivedContext: any;
	let receivedOptions: any;
	const provider = {
		streamSimple(model: any, context: any, options: any) {
			receivedModel = model;
			receivedContext = context;
			receivedOptions = options;
			return streamResult(assistant());
		},
	} as unknown as Provider;
	const fake = new FakePi();
	extension(fake as unknown as ExtensionAPI);
	const ctx = createContext(provider);

	await fake.handler("context")(
		{ messages: [{ role: "user", content: [{ type: "text", text: "work" }], timestamp: 1 }] },
		ctx,
	);
	await fake.handler("before_provider_headers")({ headers: { "x-session-affinity": "session-1" } }, ctx);
	await fake.handler("before_provider_request")(
		{ payload: { messages: ["native"], tools: [{ type: "function", function: { name: "read" } }] } },
		ctx,
	);
	await fake.handler("message_end")({ message: assistant({ content: [{ type: "text", text: "done" }] }) }, ctx);

	const result = (await fake.handler("session_before_compact")(compactionEvent(), ctx)) as any;
	assert.equal(receivedModel.baseUrl, "http://resolved.invalid/v1");
	assert.equal(receivedContext.systemPrompt, "system");
	assert.equal(receivedContext.messages.at(-1).role, "user");
	assert.equal(receivedOptions.sessionId, "session-1");
	assert.equal(receivedOptions.maxTokens, 32768);
	assert.equal(receivedOptions.toolChoice, undefined);
	assert.deepEqual(receivedOptions.headers, { "x-session-affinity": "session-1" });
	assert.deepEqual(receivedOptions.onPayload({ tools: [] }).tools, [
		{ type: "function", function: { name: "read" } },
	]);
	assert.equal(result.compaction.summary, "summary");
	assert.equal(result.compaction.firstKeptEntryId, "keep-1");
	assert.equal(result.compaction.tokensBefore, 180000);
	assert.equal(result.compaction.usage.cacheRead, 100);
});

test("restores the exact request snapshot across an in-process resume", async () => {
	let receivedContext: any;
	const provider = {
		streamSimple(_model: any, context: any) {
			receivedContext = context;
			return streamResult(assistant());
		},
	} as unknown as Provider;
	const sessionId = "resume-session";

	const first = new FakePi();
	extension(first as unknown as ExtensionAPI);
	const firstContext = createContext(provider, [], sessionId);
	await first.handler("session_start")({ reason: "startup" }, firstContext);
	await first.handler("context")(
		{ messages: [{ role: "user", content: [{ type: "text", text: "work" }], timestamp: 1 }] },
		firstContext,
	);
	await first.handler("before_provider_request")({ payload: { messages: ["native"], tools: [] } }, firstContext);
	await first.handler("message_end")({ message: assistant({ content: [], stopReason: "aborted" }) }, firstContext);

	const resumed = new FakePi();
	extension(resumed as unknown as ExtensionAPI);
	const resumedContext = createContext(provider, [], sessionId);
	await resumed.handler("session_start")({ reason: "resume" }, resumedContext);
	const result = (await resumed.handler("session_before_compact")(compactionEvent(), resumedContext)) as any;

	assert.equal(result.compaction.summary, "summary");
	assert.equal(receivedContext.messages.length, 2);
	assert.equal(receivedContext.messages[0].role, "user");
	assert.equal(receivedContext.messages[1].role, "user");
});

test("clears an in-flight snapshot when user input changes the pending request", async () => {
	let calls = 0;
	const provider = {
		streamSimple() {
			calls++;
			return streamResult(assistant());
		},
	} as unknown as Provider;
	const fake = new FakePi();
	extension(fake as unknown as ExtensionAPI);
	const ctx = createContext(provider) as any;
	ctx.isIdle = () => false;
	await fake.handler("context")({ messages: [] }, ctx);
	await fake.handler("input")({ source: "interactive", text: "steer" }, ctx);
	await fake.handler("message_end")({ message: assistant() }, ctx);
	assert.deepEqual(await fake.handler("session_before_compact")(compactionEvent(), ctx), { cancel: true });
	assert.equal(calls, 0);
});

test("cancels instead of falling back when no reusable request exists", async () => {
	let calls = 0;
	const provider = {
		streamSimple() {
			calls++;
			return streamResult(assistant());
		},
	} as unknown as Provider;
	const fake = new FakePi();
	extension(fake as unknown as ExtensionAPI);
	const notifications: string[] = [];
	const result = await fake.handler("session_before_compact")(compactionEvent(), createContext(provider, notifications));
	assert.deepEqual(result, { cancel: true });
	assert.equal(calls, 0);
	assert.match(notifications[0] ?? "", /snapshot is unavailable/);
});

test("rejects tool calls, truncated summaries, and empty summaries", async () => {
	const responses = [
		assistant({ content: [{ type: "toolCall", id: "t1", name: "read", arguments: {} }], stopReason: "toolUse" }),
		assistant({ stopReason: "length" }),
		assistant({ content: [] }),
	];
	for (const response of responses) {
		const provider = { streamSimple: () => streamResult(response) } as unknown as Provider;
		const fake = new FakePi();
		extension(fake as unknown as ExtensionAPI);
		const ctx = createContext(provider);
		await fake.handler("context")({ messages: [] }, ctx);
		await fake.handler("before_provider_request")({ payload: {} }, ctx);
		await fake.handler("message_end")({ message: assistant() }, ctx);
		assert.deepEqual(await fake.handler("session_before_compact")(compactionEvent(), ctx), { cancel: true });
	}
});
