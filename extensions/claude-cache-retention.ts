import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const TARGET_PROVIDER = "cli-proxy-api-anthropic";

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as JsonObject)
		: undefined;
}

function forceBlockToOneHour(block: unknown): number {
	const cacheControl = asObject(asObject(block)?.cache_control);
	if (!cacheControl || cacheControl.type !== "ephemeral" || cacheControl.ttl === "1h") return 0;

	cacheControl.ttl = "1h";
	return 1;
}

export function forceOneHourPromptCacheTtl(payload: unknown): number {
	const request = asObject(payload);
	if (!request) return 0;

	let updated = forceBlockToOneHour(request);

	for (const section of [request.tools, request.system]) {
		if (!Array.isArray(section)) continue;
		for (const block of section) updated += forceBlockToOneHour(block);
	}

	if (Array.isArray(request.messages)) {
		for (const message of request.messages) {
			updated += forceBlockToOneHour(message);
			const content = asObject(message)?.content;
			if (!Array.isArray(content)) continue;
			for (const block of content) updated += forceBlockToOneHour(block);
		}
	}

	return updated;
}

export default function (pi: ExtensionAPI) {
	pi.on("before_provider_request", (event, ctx) => {
		const model = ctx.model;
		if (model?.provider !== TARGET_PROVIDER || model.api !== "anthropic-messages") return;

		return forceOneHourPromptCacheTtl(event.payload) > 0 ? event.payload : undefined;
	});
}
