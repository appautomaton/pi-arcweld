export const HOSTED_WEB_SEARCH_TOOL_TYPE = "web_search_20250305";
export const HOSTED_WEB_SEARCH_TOOL_NAME = "web_search";
export const HOSTED_WEB_SEARCH_MAX_USES = 8;

export type HostedWebSearchRoute = "anthropic" | "cli-proxy-api-anthropic";

export interface ModelIdentity {
	provider?: string;
	api?: string;
	id?: string;
}

export interface HostedWebSearchInput {
	query: string;
	allowedDomains?: string[];
	blockedDomains?: string[];
}

export interface HostedSearchPayloadOptions extends HostedWebSearchInput {
	assistantHistory?: Array<Record<string, unknown>>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function getHostedWebSearchRoute(model: ModelIdentity | undefined): HostedWebSearchRoute | undefined {
	if (model?.api !== "anthropic-messages") return undefined;
	if (model.provider === "anthropic" && model.id?.startsWith("claude-")) return "anthropic";
	if (
		model.provider === "cli-proxy-api-anthropic" &&
		(model.id?.startsWith("claude-") || model.id?.startsWith("kimi-"))
	) {
		return "cli-proxy-api-anthropic";
	}
	return undefined;
}

export function buildHostedSearchPayload(payload: unknown, options: HostedSearchPayloadOptions): unknown {
	if (!isRecord(payload)) throw new Error("Anthropic hosted-search payload must be an object");
	if (!Array.isArray(payload.messages) || payload.messages.length !== 1) {
		throw new Error("Isolated hosted-search payload must contain exactly one user message before continuation history");
	}

	const tool: Record<string, unknown> = {
		type: HOSTED_WEB_SEARCH_TOOL_TYPE,
		name: HOSTED_WEB_SEARCH_TOOL_NAME,
		max_uses: HOSTED_WEB_SEARCH_MAX_USES,
	};
	if (options.allowedDomains?.length) tool.allowed_domains = options.allowedDomains;
	if (options.blockedDomains?.length) tool.blocked_domains = options.blockedDomains;

	const assistantHistory = options.assistantHistory ?? [];
	return {
		...payload,
		messages: [payload.messages[0], ...assistantHistory],
		tools: [tool],
	};
}
