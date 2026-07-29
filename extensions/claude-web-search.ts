import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const CLAUDE_WEB_SEARCH_TOOL_TYPE = "web_search_20250305";
const CLAUDE_WEB_SEARCH_TOOL_TYPES = new Set([
	"web_search_20250305",
	"web_search_20260209",
	"web_search_20260318",
]);

export type ClaudeWebSearchRoute = "anthropic" | "cli-proxy-api-anthropic";

interface ModelIdentity {
	provider?: string;
	api?: string;
	id?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function getClaudeWebSearchRoute(model: ModelIdentity | undefined): ClaudeWebSearchRoute | undefined {
	if (model?.api !== "anthropic-messages") return undefined;
	if (model.provider === "anthropic") return "anthropic";
	if (model.provider === "cli-proxy-api-anthropic") return "cli-proxy-api-anthropic";
	return undefined;
}

export function injectClaudeWebSearch(payload: unknown, model: ModelIdentity | undefined): unknown {
	if (!getClaudeWebSearchRoute(model) || !isRecord(payload)) return payload;
	if (payload.tools !== undefined && !Array.isArray(payload.tools)) return payload;

	const tools = payload.tools ?? [];
	if (
		tools.some(
			(tool) =>
				isRecord(tool) &&
				typeof tool.type === "string" &&
				CLAUDE_WEB_SEARCH_TOOL_TYPES.has(tool.type),
		)
	) {
		return payload;
	}

	return {
		...payload,
		tools: [...tools, { type: CLAUDE_WEB_SEARCH_TOOL_TYPE, name: "web_search" }],
	};
}

export default function claudeWebSearchExtension(pi: ExtensionAPI) {
	pi.on("before_provider_request", (event, ctx) => {
		const payload = injectClaudeWebSearch(event.payload, ctx.model);
		if (payload !== event.payload) return payload;
	});

	pi.registerCommand("claude-web-search-status", {
		description: "Show whether Claude web_search is injected for the current model",
		handler: async (_args, ctx) => {
			const route = getClaudeWebSearchRoute(ctx.model);
			if (route === "anthropic") {
				ctx.ui.notify("Claude web_search is enabled for the built-in Anthropic provider", "info");
				return;
			}
			if (route === "cli-proxy-api-anthropic") {
				ctx.ui.notify("Claude web_search is enabled for this CPA Anthropic model", "info");
				return;
			}
			const selected = ctx.model ? `${ctx.model.provider}/${ctx.model.id} (${ctx.model.api})` : "no selected model";
			ctx.ui.notify(`Claude web_search is not injected for ${selected}`, "warning");
		},
	});
}
