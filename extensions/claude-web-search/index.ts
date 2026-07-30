import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getClaudeWebSearchRoute, prepareClaudeWebSearchPayload } from "./payload.ts";
import { replaySafeAnthropicStream } from "./provider.ts";

const PROVIDERS = ["anthropic", "cli-proxy-api-anthropic"] as const;

export default function claudeWebSearchExtension(pi: ExtensionAPI) {
	for (const provider of PROVIDERS) {
		pi.registerProvider(provider, {
			api: "anthropic-messages",
			streamSimple(model, context, options) {
				if (model.api !== "anthropic-messages") {
					throw new Error(`Replay-safe Claude web search cannot stream API ${model.api}`);
				}
				return replaySafeAnthropicStream(model as Model<"anthropic-messages">, context, options);
			},
		});
	}

	pi.on("before_provider_request", (event, ctx) => {
		const payload = prepareClaudeWebSearchPayload(event.payload, ctx.model);
		if (payload !== event.payload) return payload;
	});

	pi.registerCommand("claude-web-search-status", {
		description: "Show whether replay-safe Claude web_search is enabled for the current model",
		handler: async (_args, ctx) => {
			const route = getClaudeWebSearchRoute(ctx.model);
			if (route === "anthropic") {
				ctx.ui.notify("Replay-safe Claude web_search is enabled for the built-in Anthropic provider", "info");
				return;
			}
			if (route === "cli-proxy-api-anthropic") {
				ctx.ui.notify("Replay-safe Claude web_search is enabled for this CPA Anthropic model", "info");
				return;
			}
			const selected = ctx.model ? `${ctx.model.provider}/${ctx.model.id} (${ctx.model.api})` : "no selected model";
			ctx.ui.notify(`Claude web_search is not injected for ${selected}`, "warning");
		},
	});
}
