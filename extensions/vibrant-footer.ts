/**
 * Powerline footer for pi, best-effort of the Claude 3p status line.
 *
 * Row 1 is a run of chips joined by a powerline arrow. Row 2 is the working
 * path, one theme hue per character, then the branch. Chip backgrounds are
 * theme tokens used as backgrounds through theme.style(); the glyph color is
 * toolPendingBg, which is the dark panel on a dark theme and the light wash
 * on a light one. No hex lives here, so pastel-aurora and pastel-aurora-light
 * both re-skin the bar.
 *
 * What Claude shows that pi's session does not carry is left out: there is no
 * prompt-cache expiry time, so a cold cache is a snowflake after five idle
 * minutes, not a countdown. Misses are turns whose prompt was mostly re-billed
 * instead of read from cache.
 *
 * Runtime: symlink from ~/.pi/agent/extensions/vibrant-footer.ts
 * Toggle:  /vibrant-footer
 */

import { basename, isAbsolute, relative, resolve, sep as pathSep } from "node:path";
import type { Usage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

type ThemeLike = {
	appearance?: "light" | "dark";
	colors?: Record<string, unknown>;
	style?(text: string, options: { fg?: unknown; bg?: unknown; bold?: boolean }): string;
	fg(color: string, text: string): string;
	bold(text: string): string;
};

type FooterLike = {
	getGitBranch(): string | null;
	getExtensionStatuses(): ReadonlyMap<string, string>;
	onBranchChange(listener: () => void): () => void;
	getAvailableProviderCount?(): number;
};

type IconSet = {
	arrow: string;
	bulb: string;
	snow: string;
	miss: string;
	bolt: string;
	branch: string;
};

const NERD_ICONS: IconSet = {
	arrow: "\u{e0b0}",
	bulb: "\u{f0eb}",
	snow: "\u{2744}",
	miss: "\u{2715}",
	bolt: "\u{f0e7}",
	branch: "\u{f126} ",
};

const UNICODE_ICONS: IconSet = {
	arrow: "▶",
	bulb: "◆",
	snow: "❄",
	miss: "✕",
	bolt: "↑",
	branch: "⎇ ",
};

/** Hue cycle for the path, in the same order as the Claude pastel row. */
const PATH_RAMP = [
	"error",
	"warning",
	"syntaxString",
	"success",
	"syntaxType",
	"mdLink",
	"syntaxKeyword",
	"syntaxOperator",
] as const;

const CACHE_IDLE_MS = 5 * 60 * 1000;
const MISS_NOISE_TOKENS = 1024;
const CHIP_INK = "toolPendingBg";

function hasNerdFonts(): boolean {
	if (process.env.POWERLINE_NERD_FONTS === "0") return false;
	if (process.env.POWERLINE_NERD_FONTS === "1") return true;
	if (process.env.GHOSTTY_RESOURCES_DIR) return true;
	const term = (process.env.TERM_PROGRAM || process.env.TERM || "").toLowerCase();
	return term !== "linux" && term !== "dumb";
}

function getIcons(): IconSet {
	return hasNerdFonts() ? NERD_ICONS : UNICODE_ICONS;
}

type Totals = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	cacheHitRate: number | undefined;
	missCount: number;
	lastRequestMs: number | undefined;
	sawCache: boolean;
	tpsLast: number | undefined;
	tpsMed: number | undefined;
};

type EntryLike = {
	id?: string;
	type: string;
	usage?: Usage;
	message?: {
		role?: string;
		usage?: Usage;
		timestamp?: number;
		durationMs?: number;
	};
};

function emptyTotals(): Totals {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0,
		cacheHitRate: undefined,
		missCount: 0,
		lastRequestMs: undefined,
		sawCache: false,
		tpsLast: undefined,
		tpsMed: undefined,
	};
}

function addUsage(totals: Totals, usage: Usage | undefined): void {
	if (!usage) return;
	totals.input += usage.input;
	totals.output += usage.output;
	totals.cacheRead += usage.cacheRead;
	totals.cacheWrite += usage.cacheWrite;
	totals.cost += usage.cost.total;
}

function collectUsage(entries: readonly EntryLike[]): Totals {
	const totals = emptyTotals();
	let previous: { prompt: number; reported: boolean } | undefined;
	const rates: number[] = [];

	for (const entry of entries) {
		if (entry.type === "usage") {
			addUsage(totals, entry.usage);
			continue;
		}
		if (entry.type === "message" && entry.message?.role === "toolResult") {
			addUsage(totals, entry.message.usage);
			continue;
		}
		if (entry.type === "branch_summary" || entry.type === "compaction") {
			addUsage(totals, entry.usage);
			continue;
		}
		if (entry.type !== "message" || entry.message?.role !== "assistant") continue;

		const message = entry.message;
		const usage = message.usage;
		addUsage(totals, usage);
		if (!usage) continue;

		const prompt = usage.input + usage.cacheRead + usage.cacheWrite;
		totals.cacheHitRate = prompt > 0 ? (usage.cacheRead / prompt) * 100 : undefined;
		if (usage.cacheRead > 0 || usage.cacheWrite > 0) totals.sawCache = true;
		if (previous && prompt > 0 && (usage.cacheRead + usage.cacheWrite > 0 || previous.reported)) {
			const missed = Math.min(previous.prompt, prompt) - usage.cacheRead;
			if (missed > MISS_NOISE_TOKENS) totals.missCount += 1;
		}
		if (prompt > 0) {
			previous = {
				prompt,
				reported: Boolean(previous?.reported || usage.cacheRead || usage.cacheWrite),
			};
		}
		if (typeof message.timestamp === "number") totals.lastRequestMs = message.timestamp;
		if (message.durationMs && usage.output > 0) {
			const rate = usage.output / (message.durationMs / 1000);
			if (rate > 0.5 && rate < 20000) rates.push(rate);
		}
	}

	const recent = rates.slice(-5).sort((a, b) => a - b);
	totals.tpsLast = rates.length > 0 ? rates[rates.length - 1] : undefined;
	totals.tpsMed = recent.length > 0 ? recent[Math.floor(recent.length / 2)] : undefined;
	return totals;
}

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

function formatCwd(cwd: string, home: string | undefined, mode: "full" | "abbrev" | "base"): string {
	if (mode === "base") return basename(cwd) || cwd;
	let display = cwd;
	if (home) {
		const resolvedCwd = resolve(cwd);
		const resolvedHome = resolve(home);
		const relativeToHome = relative(resolvedHome, resolvedCwd);
		const inside =
			relativeToHome === "" ||
			(relativeToHome !== ".." && !relativeToHome.startsWith(`..${pathSep}`) && !isAbsolute(relativeToHome));
		if (inside) display = relativeToHome === "" ? "~" : `~${pathSep}${relativeToHome}`;
	}
	if (mode === "abbrev" && display.length > 42) return `…${display.slice(-41)}`;
	return display;
}

function sanitizeStatusText(text: string): string {
	return text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
}

function thinkingLabel(level: string): { text: string; on: boolean } {
	switch (level) {
		case "max":
			return { text: "MAX", on: true };
		case "xhigh":
			return { text: "xhi", on: true };
		case "high":
			return { text: "hi", on: true };
		case "medium":
			return { text: "med", on: true };
		case "low":
			return { text: "lo", on: true };
		case "minimal":
			return { text: "min", on: true };
		default:
			return { text: "", on: false };
	}
}

function contextToken(percent: number | null): string {
	if (percent === null || percent < 50) return "success";
	if (percent < 80) return "warning";
	return "error";
}

type Segment = { id: string; token: string; text: string };

function paintChip(theme: ThemeLike, token: string, text: string): string {
	const background = theme.colors?.[token];
	const ink = theme.colors?.[CHIP_INK];
	if (theme.style && background && ink) return theme.style(` ${text} `, { fg: ink, bg: background, bold: true });
	return theme.bold(theme.fg(token, ` ${text} `));
}

function paintArrow(theme: ThemeLike, from: string, to: string | undefined, glyph: string): string {
	const foreground = theme.colors?.[from];
	const background = to ? theme.colors?.[to] : undefined;
	if (theme.style && foreground) {
		return to && background ? theme.style(glyph, { fg: foreground, bg: background }) : theme.style(glyph, { fg: foreground });
	}
	return theme.fg(from, glyph);
}

function segmentWidth(segments: readonly Segment[], arrow: string): number {
	let width = 0;
	for (const segment of segments) width += visibleWidth(` ${segment.text} `) + visibleWidth(arrow);
	return width;
}

function fitSegments(segments: readonly Segment[], arrow: string, width: number): Segment[] {
	const chosen = [...segments];
	const dropOrder = ["tps", "cost", "traffic", "cache"];
	while (segmentWidth(chosen, arrow) > width && chosen.length > 2) {
		const id = dropOrder.find((name) => chosen.some((segment) => segment.id === name));
		if (!id) break;
		const index = chosen.findIndex((segment) => segment.id === id);
		chosen.splice(index, 1);
	}
	return chosen;
}

function renderPowerline(theme: ThemeLike, segments: readonly Segment[], icons: IconSet, width: number): string {
	const chosen = fitSegments(segments, icons.arrow, width);
	let line = "";
	for (let index = 0; index < chosen.length; index++) {
		const segment = chosen[index]!;
		line += paintChip(theme, segment.token, segment.text);
		line += paintArrow(theme, segment.token, chosen[index + 1]?.token, icons.arrow);
	}
	return truncateToWidth(line, width, theme.fg("dim", "…"));
}

function colorPath(theme: ThemeLike, path: string, now: number): string {
	const chars = Array.from(path);
	let leafAt = 0;
	for (let index = 0; index < chars.length; index++) if (chars[index] === "/") leafAt = index + 1;
	const shift = Math.floor((((now / 1000) % 90) * PATH_RAMP.length) / 90);
	let line = "";
	for (let index = 0; index < chars.length; index++) {
		const token = PATH_RAMP[(shift + index) % PATH_RAMP.length]!;
		const glyph = index >= leafAt ? theme.bold(chars[index]!) : chars[index]!;
		line += theme.fg(token, glyph);
	}
	return line;
}

function padBetween(left: string, right: string, width: number): string {
	const gap = Math.max(1, width - visibleWidth(left) - visibleWidth(right));
	return left + " ".repeat(gap) + right;
}

function mergeRow(left: string, right: string, width: number, theme: ThemeLike): string {
	if (!right) return truncateToWidth(left, width, theme.fg("dim", "…"));
	const rightBudget = Math.max(0, width - Math.min(20, width) - 2);
	const fittedRight = truncateToWidth(right, rightBudget, theme.fg("dim", "…"));
	const leftBudget = Math.max(0, width - visibleWidth(fittedRight) - 2);
	const fittedLeft = truncateToWidth(left, leftBudget, theme.fg("dim", "…"));
	if (!fittedLeft) return truncateToWidth(fittedRight, width, theme.fg("dim", "…"));
	if (!fittedRight) return truncateToWidth(fittedLeft, width, theme.fg("dim", "…"));
	return padBetween(fittedLeft, fittedRight, width);
}

function usingSubscription(ctx: ExtensionContext): boolean {
	try {
		return ctx.model ? ctx.modelRegistry.isUsingOAuth(ctx.model) : false;
	} catch {
		return false;
	}
}

function buildSegments(
	theme: ThemeLike,
	ctx: ExtensionContext,
	footer: FooterLike,
	totals: Totals,
	icons: IconSet,
	now: number,
): Segment[] {
	const segments: Segment[] = [];
	const thinking = thinkingLabel(readThinking(ctx));
	const providers = footer.getAvailableProviderCount?.() ?? 0;
	const provider = providers > 1 ? ctx.model?.provider : undefined;
	const model = ctx.model?.id ?? "no-model";
	const modelText = [provider, model, thinking.text].filter(Boolean).join("·") + (thinking.on ? icons.bulb : "");
	segments.push({ id: "model", token: "syntaxKeyword", text: modelText });

	const context = ctx.getContextUsage();
	const percent = context?.percent ?? null;
	segments.push({
		id: "context",
		token: contextToken(percent),
		text: percent === null ? "?" : `${percent.toFixed(0)}%`,
	});

	const cold = totals.sawCache && totals.lastRequestMs !== undefined && now - totals.lastRequestMs > CACHE_IDLE_MS;
	if (totals.cacheHitRate !== undefined || totals.missCount > 0 || cold) {
		let text = totals.cacheHitRate !== undefined ? `${totals.cacheHitRate.toFixed(0)}%` : "";
		if (cold) text += icons.snow;
		if (totals.missCount > 0) text += `${icons.miss}${totals.missCount}`;
		segments.push({ id: "cache", token: cold ? "error" : "syntaxType", text });
	}

	if (totals.input || totals.output || totals.cacheRead || totals.cacheWrite) {
		const fresh = formatTokens(totals.input + totals.cacheWrite);
		const cached = totals.cacheRead > 0 ? `${formatTokens(totals.cacheRead)}│` : "";
		segments.push({
			id: "traffic",
			token: "mdLink",
			text: `${icons.bolt}${cached}${fresh}│${formatTokens(totals.output)}`,
		});
	}

	if (totals.tpsLast !== undefined) {
		const last = Math.round(totals.tpsLast).toString();
		const median =
			totals.tpsMed !== undefined && Math.round(totals.tpsMed) !== Math.round(totals.tpsLast)
				? `·${Math.round(totals.tpsMed)}`
				: "";
		segments.push({ id: "tps", token: "mdHeading", text: `${last}${median}` });
	}

	if (totals.cost > 0) {
		const suffix = usingSubscription(ctx) ? " sub" : "";
		segments.push({ id: "cost", token: "syntaxOperator", text: `$${totals.cost.toFixed(3)}${suffix}` });
	}

	return segments;
}

function readThinking(ctx: ExtensionContext): string {
	return ctx.thinkingLevel || "off";
}

function renderPathRow(
	theme: ThemeLike,
	ctx: ExtensionContext,
	footer: FooterLike,
	icons: IconSet,
	now: number,
	width: number,
): string {
	const mode = width < 60 ? "base" : width < 100 ? "abbrev" : "full";
	const path = formatCwd(ctx.cwd, process.env.HOME || process.env.USERPROFILE, mode);
	const branch = footer.getGitBranch();
	const sessionName = ctx.sessionManager.getSessionName();
	let left = colorPath(theme, path, now);
	if (branch) left += ` ${theme.bold(theme.fg("success", `${icons.branch}${branch}`))}`;
	if (sessionName) left += theme.fg("dim", ` · ${sessionName}`);

	const statuses = Array.from(footer.getExtensionStatuses().entries())
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([, text]) => sanitizeStatusText(text))
		.filter(Boolean)
		.join(theme.fg("dim", " · "));
	return mergeRow(left, statuses, width, theme);
}

export default function (pi: ExtensionAPI) {
	let enabled = true;
	let cached: { key: string; totals: Totals } | undefined;

	const snapshot = (ctx: ExtensionContext): Totals => {
		const manager = ctx.sessionManager;
		const entries = manager.getEntries() as readonly EntryLike[];
		const last = entries[entries.length - 1];
		const key = `${manager.getSessionId()}:${manager.getLeafId()}:${entries.length}:${last?.id ?? ""}`;
		if (cached?.key === key) return cached.totals;
		const totals = collectUsage(entries);
		cached = { key, totals };
		return totals;
	};

	const applyFooter = (ctx: ExtensionContext) => {
		if (ctx.mode !== "tui") return;
		if (!enabled) {
			ctx.ui.setFooter(undefined);
			return;
		}

		ctx.ui.setFooter((tui, theme, footerData) => {
			const footer = footerData as FooterLike;
			const unsubBranch = footer.onBranchChange(() => tui.requestRender());
			const timer = setInterval(() => tui.requestRender(), 10_000);
			return {
				dispose() {
					unsubBranch();
					clearInterval(timer);
				},
				invalidate() {},
				render(width: number): string[] {
					const now = Date.now();
					const icons = getIcons();
					const face = theme as ThemeLike;
					return [
						renderPowerline(face, buildSegments(face, ctx, footer, snapshot(ctx), icons, now), icons, width),
						renderPathRow(face, ctx, footer, icons, now, width),
					];
				},
			};
		});
	};

	pi.on("session_start", async (_event, ctx) => {
		cached = undefined;
		applyFooter(ctx);
	});

	pi.on("model_select", async (_event, ctx) => {
		if (enabled) applyFooter(ctx);
	});

	pi.on("thinking_level_select", async (_event, ctx) => {
		if (enabled) applyFooter(ctx);
	});

	pi.registerCommand("vibrant-footer", {
		description: "Toggle the powerline status bar",
		handler: async (_args, ctx) => {
			enabled = !enabled;
			applyFooter(ctx);
			ctx.ui.notify(enabled ? "Powerline status bar on" : "Default footer restored", "info");
		},
	});
}
