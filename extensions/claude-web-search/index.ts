import { hasApi } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateHead,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { formatHostedSearchResult, runHostedWebSearch } from "./hosted-search.ts";
import { getHostedWebSearchRoute } from "./payload.ts";

const WEB_SEARCH_TOOL_NAME = "WebSearch";

const webSearchParameters = Type.Object(
	{
		query: Type.String({
			minLength: 2,
			maxLength: 2_000,
			description: "The concrete web search query to execute.",
		}),
		allowed_domains: Type.Optional(
			Type.Array(Type.String({ minLength: 1 }), {
				maxItems: 20,
				description: "Only include results from these domains.",
			}),
		),
		blocked_domains: Type.Optional(
			Type.Array(Type.String({ minLength: 1 }), {
				maxItems: 20,
				description: "Exclude results from these domains.",
			}),
		),
	},
	{ additionalProperties: false },
);

function syncWebSearchAvailability(
	pi: ExtensionAPI,
	model: Parameters<typeof getHostedWebSearchRoute>[0],
): void {
	const active = pi.getActiveTools();
	const isActive = active.includes(WEB_SEARCH_TOOL_NAME);
	const shouldBeActive = Boolean(getHostedWebSearchRoute(model));
	if (shouldBeActive && !isActive) {
		pi.setActiveTools([...active, WEB_SEARCH_TOOL_NAME]);
	} else if (!shouldBeActive && isActive) {
		pi.setActiveTools(active.filter((name) => name !== WEB_SEARCH_TOOL_NAME));
	}
}

export default function claudeWebSearchExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: WEB_SEARCH_TOOL_NAME,
		label: "Web Search",
		description:
			"Search the public web through Anthropic-hosted search for supported Anthropic Messages Claude/Kimi models. Provide a specific non-empty query. The tool returns a concise synthesis plus source URLs; cite relevant returned sources in the final answer.",
		parameters: webSearchParameters,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const model = ctx.model;
			const route = getHostedWebSearchRoute(model);
			if (!model || !route || !hasApi(model, "anthropic-messages")) {
				const selected = model ? `${model.provider}/${model.id} (${model.api})` : "no selected model";
				throw new Error(`WebSearch requires a supported Anthropic Messages Claude/Kimi model; selected ${selected}`);
			}

			const result = await runHostedWebSearch(
				model,
				{
					query: params.query,
					allowedDomains: params.allowed_domains,
					blockedDomains: params.blocked_domains,
				},
				{
					complete: (searchModel, context, options) => ctx.modelRegistry.complete(searchModel, context, options),
					signal: signal ?? ctx.signal,
					onProgress(message) {
						onUpdate?.({
							content: [{ type: "text", text: message }],
							details: { query: params.query, status: message },
						});
					},
				},
			);

			const formatted = formatHostedSearchResult(result);
			const truncation = truncateHead(formatted, {
				maxBytes: DEFAULT_MAX_BYTES,
				maxLines: DEFAULT_MAX_LINES,
			});
			const text = truncation.truncated
				? `${truncation.content}\n\n[WebSearch output truncated to ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}).]`
				: truncation.content;

			return {
				content: [{ type: "text", text }],
				details: {
					query: result.query,
					sources: result.sources,
					warnings: result.errors,
					requestCount: result.requestCount,
					durationSeconds: result.durationSeconds,
					truncated: truncation.truncated,
				},
				usage: result.usage,
			};
		},
	});

	pi.on("session_start", (_event, ctx) => {
		syncWebSearchAvailability(pi, ctx.model);
	});
	pi.on("model_select", (event) => {
		syncWebSearchAvailability(pi, event.model);
	});

	pi.registerCommand("claude-web-search-status", {
		description: "Show isolated WebSearch support and cache behavior for the current model",
		handler: async (_args, ctx) => {
			const route = getHostedWebSearchRoute(ctx.model);
			if (route) {
				ctx.ui.notify(
					`Isolated WebSearch is enabled via ${route}; the main request keeps a stable ordinary tool schema and hosted search runs only on tool invocation`,
					"info",
				);
				return;
			}
			const selected = ctx.model ? `${ctx.model.provider}/${ctx.model.id} (${ctx.model.api})` : "no selected model";
			ctx.ui.notify(`Isolated WebSearch is unavailable for ${selected}`, "warning");
		},
	});
}
