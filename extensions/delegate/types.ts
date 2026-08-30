/**
 * Shared schemas and payload bounds for delegate / delegate_result.
 *
 * Pure: no Pi session APIs, so unit tests do not need a runtime.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import { DEFAULT_MAX_BYTES, truncateHead } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";

export const MAX_DEPTH = 2;
export const MAX_TURNS = 20;
export const WALL_CLOCK_MS = 5 * 60 * 1000;
export const MAX_LIST_ITEMS = 20;
export const MAX_SUMMARY_LINES = 80;
export const MAX_SUMMARY_BYTES = 8 * 1024;

export const DEFAULT_WORK_TOOLS = ["read", "grep", "find", "ls"] as const;
export const WORK_TOOLS = ["read", "grep", "find", "ls", "write", "edit", "bash"] as const;
export type WorkTool = (typeof WORK_TOOLS)[number];

export const DelegateStatus = StringEnum(["done", "blocked", "needs_review"] as const);

export const DelegateParamsSchema = Type.Object({
	to: Type.String({
		description: 'Alias (e.g. "flash") or explicit provider/model id (e.g. "cli-proxy-api-google/gemini-3.7-flash-high")',
	}),
	task: Type.String({ description: "What the delegated model should do" }),
	scope: Type.String({ description: "Paths, invariants, and what not to touch" }),
	done_when: Type.String({ description: "Acceptance check for a done result" }),
	tools: Type.Optional(
		Type.Array(Type.String(), {
			description: `Work tools to give the child. Default: ${DEFAULT_WORK_TOOLS.join(", ")}. write/edit/bash only if opted in.`,
		}),
	),
});

export const DelegateResultSchema = Type.Object({
	status: DelegateStatus,
	summary: Type.String({ description: "What happened, short" }),
	evidence: Type.Array(Type.String(), {
		description: "Pointers such as path:lines or command → outcome",
	}),
	artifacts: Type.Array(Type.String(), {
		description: "Paths written or worth reading",
	}),
	open_questions: Type.Array(Type.String(), {
		description: "Only when blocked, otherwise empty",
	}),
});

export type DelegateParams = Static<typeof DelegateParamsSchema>;
export type DelegateResult = Static<typeof DelegateResultSchema>;
export type DelegateStatusName = DelegateResult["status"];

export type DelegateDetails = {
	to: string;
	resolved: string;
	depth: number;
	durationMs: number;
	result: DelegateResult;
};

export function isWorkTool(name: string): name is WorkTool {
	return (WORK_TOOLS as readonly string[]).includes(name);
}

export function normalizeWorkTools(tools: readonly string[] | undefined): WorkTool[] {
	if (!tools || tools.length === 0) return [...DEFAULT_WORK_TOOLS];
	const unknown = tools.filter((name) => !isWorkTool(name));
	if (unknown.length > 0) {
		throw new Error(`Unknown work tool(s): ${unknown.join(", ")}. Allowed: ${WORK_TOOLS.join(", ")}`);
	}
	return [...new Set(tools)] as WorkTool[];
}

/** Allowlist for the child session. `delegate_result` is always present; `delegate` only below max depth. */
export function childToolNames(workTools: readonly string[], depth: number): string[] {
	const names = [...workTools, "delegate_result"];
	if (depth < MAX_DEPTH) names.push("delegate");
	return names;
}

function capList(items: readonly string[] | undefined): string[] {
	return (items ?? []).slice(0, MAX_LIST_ITEMS);
}

export function boundPayload(payload: DelegateResult): DelegateResult {
	const truncated = truncateHead(payload.summary ?? "", {
		maxLines: MAX_SUMMARY_LINES,
		maxBytes: Math.min(MAX_SUMMARY_BYTES, DEFAULT_MAX_BYTES),
	});
	return {
		status: payload.status,
		summary: truncated.content,
		evidence: capList(payload.evidence),
		artifacts: capList(payload.artifacts),
		open_questions: capList(payload.open_questions),
	};
}

export function fallbackPayload(
	status: DelegateStatusName,
	summary: string,
	openQuestions: readonly string[] = [],
): DelegateResult {
	return boundPayload({
		status,
		summary: summary.trim() || "(no child output)",
		evidence: [],
		artifacts: [],
		open_questions: [...openQuestions],
	});
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

export function prepareDelegateParams(args: unknown): DelegateParams {
	const o = isRecord(args) ? args : {};
	const tools = Array.isArray(o.tools) ? o.tools.filter((item): item is string => typeof item === "string") : undefined;
	return {
		to: typeof o.to === "string" ? o.to : "",
		task: typeof o.task === "string" ? o.task : "",
		scope: typeof o.scope === "string" ? o.scope : "",
		done_when: typeof o.done_when === "string" ? o.done_when : "",
		...(tools ? { tools } : {}),
	};
}

export function prepareDelegateResult(args: unknown): DelegateResult {
	const o = isRecord(args) ? args : {};
	const status =
		o.status === "done" || o.status === "blocked" || o.status === "needs_review" ? o.status : "needs_review";
	const strings = (value: unknown): string[] =>
		Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
	return boundPayload({
		status,
		summary: typeof o.summary === "string" ? o.summary : "",
		evidence: strings(o.evidence),
		artifacts: strings(o.artifacts),
		open_questions: strings(o.open_questions),
	});
}
