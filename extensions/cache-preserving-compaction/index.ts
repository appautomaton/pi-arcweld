import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
	Api,
	AssistantMessage,
	Context,
	Model,
	ProviderHeaders,
	SimpleStreamOptions,
	Tool,
} from "@earendil-works/pi-ai";
import { convertToLlm, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const SUMMARY_PROMPT = `This is a compaction checkpoint request for the conversation above.

Create a self-contained continuation summary that another coding agent can use to resume the work accurately.

Rules:
- Do not continue the task, answer conversation questions, modify files, or call tools.
- Return only the checkpoint summary.
- Pi will retain a recent tail of the conversation verbatim alongside this summary.
- Preserve durable goals, constraints, user corrections, decisions, verified progress, unresolved issues, and next steps.
- Preserve exact file paths, commands, identifiers, function names, numeric values, code fragments, and error messages when they matter.
- Reconcile prior summaries with newer information. Remove stale, superseded, duplicated, or contradictory details.
- Do not copy large tool outputs or file contents unless an exact fragment is essential.
- Write in the language currently used by the user, while keeping technical literals unchanged.

Use exactly this structure:

## Goal
[Current objective and intended outcome]

## Constraints & Preferences
- [Requirements, preferences, prohibitions, and user corrections]

## Progress
### Done
- [Completed and verified work]

### In Progress
- [Current work and its exact state]

### Blocked
- [Errors, missing information, and unresolved issues]

## Key Decisions
- **[Decision]**: [Reason and implications]

## Next Steps
1. [Concrete next action]

## Critical Context
- [Architecture, APIs, commands, values, and discoveries needed to continue]

<read-files>
[One exact path per line; leave empty if none]
</read-files>

<modified-files>
[One exact path per line; leave empty if none]
</modified-files>

Do not mention this checkpoint request.`;

export interface RequestSnapshot {
	modelKey: string;
	systemPrompt: string;
	messages: AgentMessage[];
	tools: Tool[];
	headers?: ProviderHeaders;
	payload?: unknown;
}

export interface CompactionDetails {
	extension: "cache-preserving-compaction";
	provider: string;
	model: string;
	cacheRead: number;
	cacheWrite: number;
	input: number;
	output: number;
}

interface StoredSessionState {
	snapshot: RequestSnapshot;
	latestAssistant?: AssistantMessage;
}

const SHARED_STATE_KEY = Symbol.for("pi-arcweld.cache-preserving-compaction");
const sharedRoot = globalThis as unknown as Record<symbol, unknown>;
const sharedSessions = (sharedRoot[SHARED_STATE_KEY] ??= new Map<string, StoredSessionState>()) as Map<
	string,
	StoredSessionState
>;

export function clone<T>(value: T): T {
	return structuredClone(value);
}

export function modelKey(model: Pick<Model<Api>, "provider" | "id"> | undefined): string | undefined {
	return model ? `${model.provider}/${model.id}` : undefined;
}

export function snapshotTools(pi: ExtensionAPI): Tool[] {
	const byName = new Map(pi.getAllTools().map((tool) => [tool.name, tool]));
	return pi.getActiveTools().map((name) => {
		const tool = byName.get(name);
		if (!tool) throw new Error(`Active tool definition not found: ${name}`);
		return {
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters,
		};
	});
}

export function summaryPrompt(customInstructions?: string): string {
	const focus = customInstructions?.trim();
	return focus ? `${SUMMARY_PROMPT}\n\nAdditional user focus:\n${focus}` : SUMMARY_PROMPT;
}

export function buildSummaryContext(
	snapshot: RequestSnapshot,
	latestAssistant: AssistantMessage,
	customInstructions?: string,
): Context {
	const messages = convertToLlm(snapshot.messages);
	if (
		(latestAssistant.stopReason === "stop" || latestAssistant.stopReason === "length") &&
		latestAssistant.content.length > 0
	) {
		messages.push(latestAssistant);
	}
	messages.push({
		role: "user",
		content: [{ type: "text", text: summaryPrompt(customInstructions) }],
		timestamp: Date.now(),
	});
	return {
		systemPrompt: snapshot.systemPrompt,
		messages,
		tools: snapshot.tools.length > 0 ? snapshot.tools : undefined,
	};
}

export function preserveToolPayload(previousPayload: unknown, payload: unknown): unknown {
	if (!previousPayload || typeof previousPayload !== "object" || !payload || typeof payload !== "object") {
		return payload;
	}
	const previous = previousPayload as Record<string, unknown>;
	const next = { ...(payload as Record<string, unknown>) };
	let changed = false;
	for (const key of ["tools", "tool_choice", "toolChoice", "toolConfig"]) {
		if (!(key in previous)) continue;
		next[key] = clone(previous[key]);
		changed = true;
	}
	return changed ? next : payload;
}

export function summaryText(response: AssistantMessage): string {
	return response.content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map((block) => block.text.trim())
		.filter(Boolean)
		.join("\n")
		.trim();
}

export default function cachePreservingCompaction(pi: ExtensionAPI) {
	let snapshot: RequestSnapshot | undefined;
	let latestAssistant: AssistantMessage | undefined;
	let pendingHeaders: ProviderHeaders | undefined;
	let summaryRequest = false;

	const clear = () => {
		snapshot = undefined;
		latestAssistant = undefined;
		pendingHeaders = undefined;
	};
	const forget = (ctx: { sessionManager: { getSessionId(): string } }) => {
		sharedSessions.delete(ctx.sessionManager.getSessionId());
		clear();
	};
	const remember = (ctx: { sessionManager: { getSessionId(): string } }) => {
		if (!snapshot) return;
		sharedSessions.set(ctx.sessionManager.getSessionId(), { snapshot: clone(snapshot), latestAssistant: clone(latestAssistant) });
	};

	pi.on("session_start", (_event, ctx) => {
		clear();
		const stored = sharedSessions.get(ctx.sessionManager.getSessionId());
		if (!stored) return;
		snapshot = clone(stored.snapshot);
		latestAssistant = clone(stored.latestAssistant);
	});
	pi.on("session_tree", (_event, ctx) => forget(ctx));
	pi.on("session_compact", (_event, ctx) => forget(ctx));
	pi.on("model_select", (_event, ctx) => forget(ctx));
	pi.on("input", (_event, ctx) => {
		if (!ctx.isIdle()) forget(ctx);
	});

	pi.on("context", (event, ctx) => {
		if (summaryRequest || !ctx.model) return;
		latestAssistant = undefined;
		try {
			snapshot = {
				modelKey: modelKey(ctx.model)!,
				systemPrompt: ctx.getSystemPrompt(),
				messages: clone(event.messages),
				tools: snapshotTools(pi),
			};
		} catch {
			forget(ctx);
		}
	});

	pi.on("before_provider_headers", (event) => {
		if (!summaryRequest) pendingHeaders = event.headers;
	});

	pi.on("before_provider_request", (event, ctx) => {
		if (summaryRequest) return;
		if (!snapshot || snapshot.modelKey !== modelKey(ctx.model)) return;
		try {
			snapshot.headers = pendingHeaders ? clone(pendingHeaders) : undefined;
			snapshot.payload = clone(event.payload);
			remember(ctx);
		} catch {
			forget(ctx);
		} finally {
			pendingHeaders = undefined;
		}
	});

	pi.on("message_end", (event, ctx) => {
		if (summaryRequest || event.message.role !== "assistant") return;
		latestAssistant = clone(event.message);
		remember(ctx);
	});

	pi.on("session_before_compact", async (event, ctx) => {
		try {
			const model = ctx.model;
			if (!model) throw new Error("no active model");
			if (!snapshot || snapshot.modelKey !== modelKey(model)) {
				throw new Error("the last provider request snapshot is unavailable");
			}
			if (!latestAssistant) throw new Error("the latest assistant response is unavailable");

			const provider = ctx.modelRegistry.getProvider(model.provider);
			if (!provider) throw new Error(`provider ${model.provider} is unavailable`);
			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
			if (!auth.ok) throw new Error(auth.error);

			const requestModel = auth.baseUrl ? { ...model, baseUrl: auth.baseUrl } : model;
			const options: SimpleStreamOptions = {
				apiKey: auth.apiKey,
				headers: snapshot.headers ?? auth.headers,
				env: auth.env,
				signal: event.signal,
				reasoning: ctx.thinkingLevel === "off" ? undefined : ctx.thinkingLevel,
				maxTokens: model.maxTokens,
				sessionId: ctx.sessionManager.getSessionId(),
				onPayload: (payload) => preserveToolPayload(snapshot!.payload, payload),
			};

			summaryRequest = true;
			let response: AssistantMessage;
			try {
				response = await provider
					.streamSimple(requestModel, buildSummaryContext(snapshot, latestAssistant, event.customInstructions), options)
					.result();
			} finally {
				summaryRequest = false;
			}

			if (event.signal.aborted) throw new Error("summary request was cancelled");
			if (response.stopReason !== "stop") {
				throw new Error(response.errorMessage || `summary stopped with reason ${response.stopReason}`);
			}
			if (response.content.some((block) => block.type === "toolCall")) {
				throw new Error("the summary response attempted to call a tool");
			}
			const summary = summaryText(response);
			if (!summary) throw new Error("the summary response was empty");

			const details: CompactionDetails = {
				extension: "cache-preserving-compaction",
				provider: model.provider,
				model: model.id,
				cacheRead: response.usage.cacheRead,
				cacheWrite: response.usage.cacheWrite,
				input: response.usage.input,
				output: response.usage.output,
			};

			if (ctx.hasUI && response.usage.cacheRead === 0) {
				ctx.ui.notify("Cache-preserving compaction completed, but the provider reported no cache read.", "warning");
			}

			return {
				compaction: {
					summary,
					firstKeptEntryId: event.preparation.firstKeptEntryId,
					tokensBefore: event.preparation.tokensBefore,
					usage: response.usage,
					details,
				},
			};
		} catch (error) {
			summaryRequest = false;
			const message = error instanceof Error ? error.message : String(error);
			if (ctx.hasUI && !event.signal.aborted) {
				ctx.ui.notify(`Cache-preserving compaction cancelled: ${message}`, "error");
			}
			return { cancel: true };
		}
	});
}
