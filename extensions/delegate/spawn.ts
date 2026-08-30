/**
 * Child session construction and the nested delegate / delegate_result tools.
 *
 * Depth, trust, and the result holder live in closures. Module-level state is
 * only the shared ModelRuntime (plan M4 option A).
 */

import type { AgentSession, ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { Api, Model, Usage } from "@earendil-works/pi-ai";
import type { Static } from "typebox";
import {
	boundPayload,
	childToolNames,
	fallbackPayload,
	MAX_DEPTH,
	MAX_TURNS,
	normalizeWorkTools,
	prepareDelegateParams,
	prepareDelegateResult,
	WALL_CLOCK_MS,
	type DelegateDetails,
	type DelegateParams,
	type DelegateResult,
} from "./types.ts";
import { DelegateParamsSchema, DelegateResultSchema } from "./types.ts";
import { defaultAliasPath, formatKnownTargets, loadAliases, resolveTarget } from "./aliases.ts";
import { hopLabel, resultText } from "./ui.ts";

export type SpawnEnv = {
	cwd: string;
	agentDir: string;
	projectTrusted: boolean;
	signal?: AbortSignal;
	hasUI: boolean;
	setStatus?: (text: string | undefined) => void;
	aliasPath?: string;
};

type CapReason = "turns" | "wall" | "aborted";

let runtimePromise: Promise<ModelRuntime> | undefined;

export function sharedRuntime(): Promise<ModelRuntime> {
	runtimePromise ??= ModelRuntime.create();
	return runtimePromise;
}

/** Tests inject a runtime; production uses sharedRuntime(). */
export function setSharedRuntimeForTests(runtime: ModelRuntime | undefined): void {
	runtimePromise = runtime ? Promise.resolve(runtime) : undefined;
}

function addendum(params: DelegateParams, depth: number, workTools: readonly string[]): string {
	const nested =
		depth < MAX_DEPTH
			? "You may call delegate for one nested hop. The grandchild cannot spawn."
			: "You cannot call delegate. Finish this job yourself.";
	return [
		`You are a delegated worker (depth ${depth} of ${MAX_DEPTH}).`,
		"Do the job in the user message. Call delegate_result when finished and then stop.",
		nested,
		`Allowed work tools: ${workTools.join(", ")}.`,
		"Return file paths for bulky evidence. Do not dump transcripts.",
	].join("\n");
}

function brief(params: DelegateParams): string {
	return [`task: ${params.task}`, `scope: ${params.scope}`, `done_when: ${params.done_when}`].join("\n");
}

function collectUsage(session: AgentSession): Usage | undefined {
	let found = false;
	const acc: Usage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	for (const message of session.messages) {
		const usage = "usage" in message ? message.usage : undefined;
		if (!usage) continue;
		found = true;
		acc.input += usage.input;
		acc.output += usage.output;
		acc.cacheRead += usage.cacheRead;
		acc.cacheWrite += usage.cacheWrite;
		acc.totalTokens += usage.totalTokens;
		acc.cost.input += usage.cost.input;
		acc.cost.output += usage.cost.output;
		acc.cost.cacheRead += usage.cost.cacheRead;
		acc.cost.cacheWrite += usage.cost.cacheWrite;
		acc.cost.total += usage.cost.total;
	}
	return found ? acc : undefined;
}

function makeDelegateResultTool(hold: (payload: DelegateResult) => void): ToolDefinition {
	return {
		name: "delegate_result",
		label: "Delegate result",
		description:
			"Return the structured result of this delegated job and end the turn. Call this once when the job is done, blocked, or needs review.",
		promptSnippet: "Return the structured result of this delegated job and stop",
		promptGuidelines: [
			"Call delegate_result exactly once when the job is finished, blocked, or needs review.",
			"Do not keep working after delegate_result.",
		],
		parameters: DelegateResultSchema,
		prepareArguments: prepareDelegateResult,
		constrainedSampling: { type: "json_schema", strict: "prefer" },
		async execute(_toolCallId, params: Static<typeof DelegateResultSchema>) {
			const payload = boundPayload(params);
			hold(payload);
			return {
				content: [{ type: "text", text: `${payload.status}: ${payload.summary}` }],
				details: payload,
				terminate: true,
			};
		},
	};
}

function makeNestedDelegateTool(env: SpawnEnv, childDepth: number): ToolDefinition {
	return {
		name: "delegate",
		label: "Delegate",
		description:
			"Hand a scoped job to another model. The only return is a structured delegate_result payload. Nested depth is limited.",
		promptSnippet: "Hand a scoped job to another model; only a structured contract returns",
		parameters: DelegateParamsSchema,
		prepareArguments: prepareDelegateParams,
		executionMode: "sequential",
		async execute(_toolCallId, params: Static<typeof DelegateParamsSchema>, signal, _onUpdate, _ctx) {
			return runDelegatedJob({ ...env, signal: signal ?? env.signal }, params, childDepth);
		},
	};
}

export type CreateChildSessionOptions = {
	env: SpawnEnv;
	params: DelegateParams;
	depth: number;
	workTools: readonly string[];
	model?: Model<Api>;
	modelRuntime?: ModelRuntime;
	onResult: (payload: DelegateResult) => void;
};

export async function createChildSession(options: CreateChildSessionOptions): Promise<AgentSession> {
	const { env, params, depth, workTools, onResult } = options;
	const settingsManager = SettingsManager.create(env.cwd, env.agentDir, {
		projectTrusted: env.projectTrusted,
	});
	const loader = new DefaultResourceLoader({
		cwd: env.cwd,
		agentDir: env.agentDir,
		settingsManager,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		appendSystemPromptOverride: (base) => [...base, addendum(params, depth, workTools)],
	});
	await loader.reload();

	const customTools: ToolDefinition[] = [makeDelegateResultTool(onResult)];
	if (depth < MAX_DEPTH) customTools.push(makeNestedDelegateTool(env, depth + 1));

	const { session } = await createAgentSession({
		cwd: env.cwd,
		agentDir: env.agentDir,
		model: options.model,
		modelRuntime: options.modelRuntime ?? (await sharedRuntime()),
		settingsManager,
		resourceLoader: loader,
		sessionManager: SessionManager.inMemory(env.cwd),
		tools: childToolNames(workTools, depth),
		customTools,
	});
	return session;
}

async function resolveModel(
	to: string,
	aliasPath: string,
	runtime: ModelRuntime,
): Promise<{ ref: { provider: string; modelId: string; alias?: string }; model: Model<Api> }> {
	const aliases = loadAliases(aliasPath);
	const resolved = resolveTarget(to, aliases);
	const knownIds = runtime.getModels().map((model) => `${model.provider}/${model.id}`);
	if (!resolved.ok) {
		throw new Error(`${resolved.error}\n${formatKnownTargets(aliases, knownIds)}`);
	}
	const model = runtime.getModel(resolved.ref.provider, resolved.ref.modelId);
	if (!model) {
		throw new Error(
			`Model ${resolved.ref.provider}/${resolved.ref.modelId} is not in the child runtime (file-configured providers only in v1).\n${formatKnownTargets(aliases, knownIds)}`,
		);
	}
	if (!runtime.hasConfiguredAuth(model.provider)) {
		throw new Error(
			`No auth configured for provider "${model.provider}".\n${formatKnownTargets(aliases, knownIds)}`,
		);
	}
	return { ref: resolved.ref, model };
}

export async function runDelegatedJob(
	env: SpawnEnv,
	params: DelegateParams,
	depth: number,
): Promise<{
	content: [{ type: "text"; text: string }];
	details: DelegateDetails;
	usage?: Usage;
}> {
	if (depth > MAX_DEPTH) {
		throw new Error(`delegate depth ${depth} exceeds max ${MAX_DEPTH}`);
	}
	const workTools = normalizeWorkTools(params.tools);
	const runtime = await sharedRuntime();
	const aliasPath = env.aliasPath ?? defaultAliasPath();
	const { ref, model } = await resolveModel(params.to, aliasPath, runtime);
	const resolved = `${ref.provider}/${ref.modelId}`;
	const label = hopLabel(params.to, resolved);

	let payload: DelegateResult | undefined;
	const onResult = (next: DelegateResult): void => {
		if (!payload) payload = next;
	};

	env.setStatus?.(`delegate ${label}`);
	const started = Date.now();
	const session = await createChildSession({
		env,
		params,
		depth,
		workTools,
		model,
		modelRuntime: runtime,
		onResult,
	});

	let cap: CapReason | undefined;
	let turns = 0;
	let lastText: string | undefined;
	let usage: Usage | undefined;
	const unsubscribe = session.subscribe((event) => {
		if (event.type !== "turn_end") return;
		turns += 1;
		if (turns >= MAX_TURNS && !payload) {
			cap = "turns";
			void session.abort();
		}
	});
	const onParentAbort = (): void => {
		cap = "aborted";
		void session.abort();
	};
	env.signal?.addEventListener("abort", onParentAbort);
	const wall = setTimeout(() => {
		if (payload) return;
		cap = "wall";
		void session.abort();
	}, WALL_CLOCK_MS);

	try {
		await session.prompt(brief(params));
	} catch (error) {
		if (!payload && !cap) throw error;
	} finally {
		lastText = session.getLastAssistantText();
		usage = collectUsage(session);
		clearTimeout(wall);
		env.signal?.removeEventListener("abort", onParentAbort);
		unsubscribe();
		session.dispose();
		env.setStatus?.(undefined);
	}

	if (!payload) {
		if (cap === "turns") {
			payload = fallbackPayload("blocked", lastText ?? "Turn cap reached.", [
				`Child hit maxTurns (${MAX_TURNS}).`,
			]);
		} else if (cap === "wall") {
			payload = fallbackPayload("blocked", lastText ?? "Wall-clock cap reached.", [
				`Child hit the ${WALL_CLOCK_MS / 1000}s wall-clock cap.`,
			]);
		} else if (cap === "aborted" || env.signal?.aborted) {
			payload = fallbackPayload("blocked", "aborted by user", ["aborted by user"]);
		} else {
			payload = fallbackPayload("needs_review", lastText ?? "");
		}
	}

	const details: DelegateDetails = {
		to: params.to,
		resolved,
		depth,
		durationMs: Date.now() - started,
		result: payload,
	};
	return {
		content: [{ type: "text", text: resultText(details) }],
		details,
		usage,
	};
}

export { addendum, brief };
