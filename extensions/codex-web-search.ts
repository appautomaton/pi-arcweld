import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type CodexWebSearchRoute = "openai-codex-oauth" | "cli-proxy-api";

interface ModelIdentity {
	provider?: string;
	api?: string;
	id?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function getCodexWebSearchRoute(model: ModelIdentity | undefined): CodexWebSearchRoute | undefined {
	if (model?.provider === "openai-codex" && model.api === "openai-codex-responses") {
		return "openai-codex-oauth";
	}
	if (model?.provider === "cli-proxy-api" && model.api === "openai-responses" && model.id?.startsWith("gpt-")) {
		return "cli-proxy-api";
	}
	return undefined;
}

export function injectCodexWebSearch(payload: unknown, model: ModelIdentity | undefined): unknown {
	if (!getCodexWebSearchRoute(model) || !isRecord(payload)) return payload;
	if (payload.tools !== undefined && !Array.isArray(payload.tools)) return payload;

	const tools = payload.tools ?? [];
	if (tools.some((tool) => isRecord(tool) && tool.type === "web_search")) return payload;

	return {
		...payload,
		tools: [...tools, { type: "web_search" }],
	};
}

export default function codexWebSearchExtension(pi: ExtensionAPI) {
	pi.on("before_provider_request", (event, ctx) => {
		const payload = injectCodexWebSearch(event.payload, ctx.model);
		if (payload !== event.payload) return payload;
	});

	pi.registerCommand("codex-web-search-status", {
		description: "Show whether Codex web_search is injected for the current model",
		handler: async (_args, ctx) => {
			const route = getCodexWebSearchRoute(ctx.model);
			if (route === "openai-codex-oauth") {
				ctx.ui.notify("Codex web_search is enabled for the built-in OpenAI Codex OAuth provider", "info");
				return;
			}
			if (route === "cli-proxy-api") {
				ctx.ui.notify("Codex web_search is enabled for this CPA-backed GPT Responses model", "info");
				return;
			}
			const selected = ctx.model ? `${ctx.model.provider}/${ctx.model.id} (${ctx.model.api})` : "no selected model";
			ctx.ui.notify(`Codex web_search is not injected for ${selected}`, "warning");
		},
	});
}
