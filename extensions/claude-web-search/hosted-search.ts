import type { AnthropicOptions } from "@earendil-works/pi-ai/api/anthropic-messages";
import type { AssistantMessage, Context, Model, Usage } from "@earendil-works/pi-ai";
import { buildHostedSearchPayload, type HostedWebSearchInput } from "./payload.ts";
import {
	createHostedSearchObservingFetch,
	HostedSearchSseCollector,
	type HostedSearchSource,
} from "./hosted-search-sse.ts";

const SEARCH_SYSTEM_PROMPT =
	"You execute web searches for another assistant. Use the provided web_search server tool for the requested query. Return a concise factual synthesis grounded only in the search results.";
const SEARCH_USER_PREFIX = "Perform a web search for the query: ";
const MAX_QUERY_LENGTH = 2_000;
const MAX_DOMAINS = 20;
const MAX_PAUSE_CONTINUATIONS = 8;
const SEARCH_MAX_TOKENS = 8_192;
const SEARCH_TIMEOUT_MS = 120_000;

export type HostedSearchComplete = (
	model: Model<"anthropic-messages">,
	context: Context,
	options: AnthropicOptions,
) => Promise<AssistantMessage>;

export interface RunHostedSearchOptions {
	complete: HostedSearchComplete;
	fetch?: typeof globalThis.fetch;
	signal?: AbortSignal;
	onProgress?: (message: string) => void;
	maxPauseContinuations?: number;
}

export interface HostedSearchResult {
	query: string;
	text: string[];
	sources: HostedSearchSource[];
	errors: string[];
	requestCount: number;
	durationSeconds: number;
	usage: Usage;
}

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

function normalizeDomains(values: string[] | undefined, field: string): string[] | undefined {
	if (!values?.length) return undefined;
	if (values.length > MAX_DOMAINS) throw new Error(`${field} accepts at most ${MAX_DOMAINS} domains`);
	const normalized = [...new Set(values.map((value) => value.trim().toLowerCase()).filter(Boolean))];
	for (const domain of normalized) {
		if (/\s/.test(domain)) throw new Error(`${field} contains an invalid domain: ${domain}`);
	}
	return normalized.length > 0 ? normalized : undefined;
}

export function normalizeHostedSearchInput(input: HostedWebSearchInput): HostedWebSearchInput {
	const query = input.query.trim();
	if (query.length < 2) throw new Error("WebSearch query must contain at least 2 characters");
	if (query.length > MAX_QUERY_LENGTH) {
		throw new Error(`WebSearch query must not exceed ${MAX_QUERY_LENGTH} characters`);
	}
	const allowedDomains = normalizeDomains(input.allowedDomains, "allowed_domains");
	const blockedDomains = normalizeDomains(input.blockedDomains, "blocked_domains");
	if (allowedDomains?.length && blockedDomains?.length) {
		throw new Error("WebSearch cannot use allowed_domains and blocked_domains together");
	}
	return { query, ...(allowedDomains ? { allowedDomains } : {}), ...(blockedDomains ? { blockedDomains } : {}) };
}

function mergeUniqueText(target: string[], incoming: string[]): void {
	const seen = new Set(target);
	for (const text of incoming) {
		if (!seen.has(text)) {
			seen.add(text);
			target.push(text);
		}
	}
}

function mergeUniqueSources(target: Map<string, HostedSearchSource>, incoming: HostedSearchSource[]): void {
	for (const source of incoming) {
		if (!target.has(source.url)) target.set(source.url, source);
	}
}

export async function runHostedWebSearch(
	model: Model<"anthropic-messages">,
	input: HostedWebSearchInput,
	options: RunHostedSearchOptions,
): Promise<HostedSearchResult> {
	const normalized = normalizeHostedSearchInput(input);
	const maxPauseContinuations = options.maxPauseContinuations ?? MAX_PAUSE_CONTINUATIONS;
	if (!Number.isInteger(maxPauseContinuations) || maxPauseContinuations < 0) {
		throw new Error("maxPauseContinuations must be a non-negative integer");
	}

	const startedAt = performance.now();
	const assistantHistory: Array<Record<string, unknown>> = [];
	const text: string[] = [];
	const sources = new Map<string, HostedSearchSource>();
	const errors: string[] = [];
	let usage = emptyUsage();
	let requestCount = 0;

	while (true) {
		options.signal?.throwIfAborted();
		requestCount++;
		options.onProgress?.(requestCount === 1 ? `Searching the web for: ${normalized.query}` : "Continuing hosted web search…");
		const collector = new HostedSearchSseCollector((count) => {
			options.onProgress?.(`Received hosted search result batch ${count}`);
		});
		const fetch = createHostedSearchObservingFetch(options.fetch ?? globalThis.fetch, collector, options.signal);
		const context: Context = {
			systemPrompt: SEARCH_SYSTEM_PROMPT,
			messages: [
				{
					role: "user",
					content: `${SEARCH_USER_PREFIX}${normalized.query}`,
					timestamp: Date.now(),
				},
			],
			tools: [],
		};

		const result = await options.complete(model, context, {
			signal: options.signal,
			fetch,
			maxTokens: Math.min(model.maxTokens, SEARCH_MAX_TOKENS),
			thinkingEnabled: false,
			cacheRetention: "short",
			timeoutMs: SEARCH_TIMEOUT_MS,
			maxRetries: 1,
			onPayload(payload) {
				return buildHostedSearchPayload(payload, {
					...normalized,
					assistantHistory,
				});
			},
		});

		usage = addUsage(usage, result.usage);
		if (result.stopReason === "error" || result.stopReason === "aborted") {
			throw new Error(result.errorMessage || `Hosted web search ${result.stopReason}`);
		}

		const snapshot = collector.snapshot();
		mergeUniqueText(text, snapshot.text);
		mergeUniqueSources(sources, snapshot.sources);
		for (const error of snapshot.errors) if (!errors.includes(error)) errors.push(error);

		if (result.rawStopReason !== "pause_turn") break;
		if (snapshot.content.length === 0) {
			throw new Error("Hosted web search paused without replayable assistant content");
		}
		if (assistantHistory.length >= maxPauseContinuations) {
			throw new Error(`Hosted web search exceeded ${maxPauseContinuations} pause_turn continuations`);
		}
		assistantHistory.push({ role: "assistant", content: snapshot.content });
	}

	if (text.length === 0 && sources.size === 0) {
		const suffix = errors.length > 0 ? `: ${errors.join(", ")}` : "";
		throw new Error(`Hosted web search returned no usable results${suffix}`);
	}

	return {
		query: normalized.query,
		text,
		sources: [...sources.values()],
		errors,
		requestCount,
		durationSeconds: (performance.now() - startedAt) / 1_000,
		usage,
	};
}

function escapeMarkdownLabel(value: string): string {
	return value.replace(/[\\[\]]/g, "\\$&").replace(/\s+/g, " ").trim();
}

export function formatHostedSearchResult(result: HostedSearchResult): string {
	const sections = [`Web search results for query: "${result.query}"`];
	if (result.text.length > 0) sections.push(result.text.join("\n\n"));
	if (result.sources.length > 0) {
		sections.push(
			["Sources:", ...result.sources.map((source) => `- [${escapeMarkdownLabel(source.title)}](${source.url})`)].join(
				"\n",
			),
		);
	}
	if (result.errors.length > 0) sections.push(`Search warnings: ${result.errors.join(", ")}`);
	return sections.join("\n\n");
}
