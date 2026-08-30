import { keyHint, type Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { DelegateDetails, DelegateParams } from "./types.ts";

export function hopLabel(to: string, resolved: string): string {
	return to === resolved ? to : `${to} → ${resolved}`;
}

export function formatCost(total: number | undefined): string | undefined {
	if (total === undefined || Number.isNaN(total)) return undefined;
	if (total === 0) return "$0";
	if (total < 0.01) return `$${total.toFixed(4)}`;
	return `$${total.toFixed(3)}`;
}

export function formatDuration(ms: number): string {
	if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
	return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
}

export function collapsedCallLine(args: Partial<DelegateParams>, theme: Theme): string {
	const to = typeof args.to === "string" ? args.to : "?";
	const tools = Array.isArray(args.tools) ? args.tools.join(",") : "read-only";
	const task = typeof args.task === "string" ? args.task : "";
	const snippet = task.length > 48 ? `${task.slice(0, 47)}…` : task;
	return (
		theme.fg("toolTitle", theme.bold("delegate ")) +
		theme.fg("accent", to) +
		theme.fg("muted", `  ${tools}`) +
		(snippet ? theme.fg("dim", `  “${snippet}”`) : "")
	);
}

export function collapsedResultLine(details: DelegateDetails | undefined, theme: Theme): string {
	if (!details) return theme.fg("muted", "delegate (no result)");
	const { result, durationMs } = details;
	const bits = [result.status, `${result.artifacts.length} file${result.artifacts.length === 1 ? "" : "s"}`];
	bits.push(formatDuration(durationMs));
	return theme.fg(result.status === "done" ? "success" : "warning", bits.join(" · "));
}

export function renderCall(args: Record<string, unknown>, theme: Theme): Text {
	return new Text(collapsedCallLine(args as Partial<DelegateParams>, theme), 0, 0);
}

export function renderResult(
	result: { content: Array<{ type: string; text?: string }>; details?: unknown },
	options: { expanded?: boolean; isPartial?: boolean },
	theme: Theme,
): Text {
	if (options.isPartial) return new Text(theme.fg("warning", "delegating…"), 0, 0);
	const details = result.details as DelegateDetails | undefined;
	if (!options.expanded) {
		const hint = ` (${keyHint("app.tools.expand", "to expand")})`;
		return new Text(collapsedResultLine(details, theme) + theme.fg("dim", hint), 0, 0);
	}
	if (!details) {
		const first = result.content[0];
		return new Text(first?.type === "text" ? (first.text ?? "") : "", 0, 0);
	}
	const payload = details.result;
	const lines = [
		theme.fg("toolTitle", theme.bold(hopLabel(details.to, details.resolved))),
		theme.fg("muted", `${payload.status} · ${formatDuration(details.durationMs)} · depth ${details.depth}`),
		theme.fg("text", payload.summary),
	];
	if (payload.evidence.length > 0) {
		lines.push("", theme.fg("accent", "evidence"));
		for (const item of payload.evidence) lines.push(theme.fg("dim", `  ${item}`));
	}
	if (payload.artifacts.length > 0) {
		lines.push("", theme.fg("accent", "artifacts"));
		for (const item of payload.artifacts) lines.push(theme.fg("dim", `  ${item}`));
	}
	if (payload.open_questions.length > 0) {
		lines.push("", theme.fg("accent", "open questions"));
		for (const item of payload.open_questions) lines.push(theme.fg("dim", `  ${item}`));
	}
	return new Text(lines.join("\n"), 0, 0);
}

export function resultText(details: DelegateDetails): string {
	const payload = details.result;
	const lines = [
		`[delegated ${hopLabel(details.to, details.resolved)}] ${payload.status}`,
		payload.summary,
	];
	if (payload.artifacts.length > 0) lines.push(`artifacts: ${payload.artifacts.join(", ")}`);
	if (payload.open_questions.length > 0) lines.push(`open_questions: ${payload.open_questions.join("; ")}`);
	return lines.join("\n");
}
