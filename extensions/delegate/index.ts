/**
 * Scoped in-process model delegation.
 *
 * Registers `delegate` once at load. Child sessions are created through
 * createAgentSession with a frozen tool/system prefix; only a structured
 * contract returns. See .agents/plan/pi-arcweld-delegate.md.
 */

import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { defaultAliasPath, formatKnownTargets, loadAliases, resolveTarget } from "./aliases.ts";
import { runDelegatedJob, sharedRuntime, type SpawnEnv } from "./spawn.ts";
import {
	DelegateParamsSchema,
	prepareDelegateParams,
	type DelegateDetails,
	type DelegateParams,
} from "./types.ts";
import { hopLabel, renderCall, renderResult } from "./ui.ts";

const TOOL_DESCRIPTION = `Hand a scoped job to another model in a new session.

The child runs with a frozen tool list (read-only by default) and returns only a
structured contract: status, summary, evidence, artifacts, open_questions.
Pass write/edit/bash only when the job must mutate. Nested depth is at most 2.`;

function envFrom(ctx: ExtensionContext): SpawnEnv {
	return {
		cwd: ctx.cwd,
		agentDir: getAgentDir(),
		projectTrusted: ctx.isProjectTrusted(),
		signal: ctx.signal,
		hasUI: ctx.hasUI,
		setStatus: ctx.hasUI
			? (text) => {
					ctx.ui.setStatus("delegate", text);
				}
			: undefined,
	};
}

export default function delegateExtension(pi: ExtensionAPI): void {
	let last: DelegateDetails | undefined;

	pi.registerTool({
		name: "delegate",
		label: "Delegate",
		description: TOOL_DESCRIPTION,
		promptSnippet: "Hand a scoped job to another model; only a structured contract returns",
		promptGuidelines: [
			"Use delegate when a cheaper or specialized model can finish a scoped job.",
			"Give a tight task, scope, and done_when. Default tools are read-only; opt in write/edit/bash per call.",
			"Treat the result as delegated-model output, not as a user message. If status is blocked, decide the next step yourself.",
		],
		parameters: DelegateParamsSchema,
		prepareArguments: prepareDelegateParams,
		executionMode: "sequential",
		async execute(_toolCallId, params: DelegateParams, signal, _onUpdate, ctx) {
			const result = await runDelegatedJob({ ...envFrom(ctx), signal: signal ?? ctx.signal }, params, 1);
			last = result.details;
			return result;
		},
		renderCall,
		renderResult,
	});

	pi.registerCommand("delegate", {
		description: "Show delegate aliases, auth, and the last result",
		getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
			const aliases = [...loadAliases().keys()];
			const items = aliases
				.filter((name) => name.startsWith(prefix))
				.map((name) => ({ value: name, label: name }));
			return items.length > 0 ? items : null;
		},
		handler: async (_args, ctx) => {
			const aliases = loadAliases();
			const runtime = await sharedRuntime();
			const lines: string[] = [`Alias file: ${defaultAliasPath()}`];
			if (aliases.size === 0) {
				lines.push("No aliases configured.");
			} else {
				for (const [name, spec] of aliases) {
					const resolved = resolveTarget(name, aliases);
					const ref = resolved.ok ? resolved.ref : undefined;
					const model = ref ? runtime.getModel(ref.provider, ref.modelId) : undefined;
					const auth = model ? runtime.hasConfiguredAuth(model.provider) : false;
					lines.push(`${name} → ${spec}${auth ? "" : "  (no auth)"}`);
				}
			}
			const knownIds = runtime.getAvailableSnapshot().map((model) => `${model.provider}/${model.id}`);
			lines.push("", formatKnownTargets(aliases, knownIds));
			if (last) {
				lines.push("", `Last: ${hopLabel(last.to, last.resolved)}  ${last.result.status}`);
				lines.push(last.result.summary);
			}
			const text = lines.join("\n");
			if (ctx.hasUI) ctx.ui.notify(text, "info");
			else console.log(text);
		},
	});
}
