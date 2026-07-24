/**
 * Always-on todo tool for Pi.
 *
 * Registers `update_todos` once at load and never toggles it, so the provider
 * prompt prefix (tools, then system, then earlier messages) stays byte-stable.
 * All evolving state rides in the conversation tail: the list lives in each tool
 * result's `details`, and a short reminder is appended via before_agent_start only
 * after the model has gone quiet. Nothing here rewrites the system prompt or filters
 * prior messages, so the prompt cache is preserved.
 */

import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, Text, truncateToWidth } from "@earendil-works/pi-tui";
import type { Static } from "typebox";
import {
	activeTodo,
	compactResult,
	isActive,
	normalizeTodos,
	reconstructFromEntries,
	reminderLine,
	RESURFACE_AFTER_QUIET_TURNS,
	summarize,
	type TodoItem,
	type TodoWriteDetails,
	UpdateTodosParams,
	validate,
} from "./utils.ts";

const TODO_REMINDER_TYPE = "todos-reminder";

/** Longest activeForm shown inline in the footer badge before truncation. */
const BADGE_ACTIVE_WIDTH = 32;

/** Item rows shown in the persistent widget before collapsing the rest into "+N more". */
const WIDGET_MAX_ROWS = 12;

const TOOL_DESCRIPTION = `Replace the shared ordered todo state for multi-step work.

Send the complete current list on every call; omitted items are deleted and position is identity.
Keep exactly one item in_progress while work remains, update statuses immediately, and never
complete partial, blocked, or failed work. Finish successful work with one all-completed update;
the UI hides completed lists automatically. Use an empty list only to discard the state. Report
outcomes in the normal assistant response, not in the todo list.`;

/** One themed line per item, shared by the widget, the overlay, and the expanded tool result. */
function formatLine(todo: TodoItem, theme: Theme): string {
	switch (todo.status) {
		case "in_progress":
			return theme.fg("warning", "◐ ") + theme.fg("text", todo.activeForm);
		case "completed":
			return theme.fg("success", "☑ ") + theme.fg("muted", theme.strikethrough(todo.content));
		default:
			return theme.fg("dim", "☐ ") + theme.fg("text", todo.content);
	}
}

/** Header rule of the form `─── Todos 2/5 ───────`, sized to the available width. */
function headerLine(label: string, width: number, theme: Theme): string {
	const dashes = Math.max(0, width - 3 - label.length);
	return truncateToWidth(
		theme.fg("borderMuted", "───") + theme.fg("accent", label) + theme.fg("borderMuted", "─".repeat(dashes)),
		width,
	);
}

/** Persistent progress widget. A component factory, so it is exempt from the 10-line widget cap. */
class TodoWidget {
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(
		private readonly todos: readonly TodoItem[],
		private readonly theme: Theme,
	) {}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
		const { total, completed } = summarize(this.todos);
		const lines = [headerLine(` Todos ${completed}/${total} `, width, this.theme)];

		const rows = this.todos.slice(0, WIDGET_MAX_ROWS);
		for (const todo of rows) {
			lines.push(truncateToWidth(`  ${formatLine(todo, this.theme)}`, width));
		}
		const overflow = this.todos.length - rows.length;
		if (overflow > 0) {
			lines.push(truncateToWidth(`  ${this.theme.fg("dim", `+${overflow} more`)}`, width));
		}

		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}
}

/** Full-list overlay for the /todos command. Escape or Ctrl+C closes it. */
class TodoOverlay {
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(
		private readonly todos: readonly TodoItem[],
		private readonly theme: Theme,
		private readonly onClose: () => void,
	) {}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) this.onClose();
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
		const th = this.theme;
		const lines = ["", headerLine(" Todos ", width, th), ""];

		if (this.todos.length === 0) {
			lines.push(truncateToWidth(`  ${th.fg("dim", "No todos yet. Ask the agent to plan the work.")}`, width));
		} else {
			const { total, completed } = summarize(this.todos);
			lines.push(truncateToWidth(`  ${th.fg("muted", `${completed}/${total} completed`)}`, width), "");
			for (const todo of this.todos) {
				lines.push(truncateToWidth(`  ${formatLine(todo, th)}`, width));
			}
		}

		lines.push("", truncateToWidth(`  ${th.fg("dim", "Press Escape to close")}`, width), "");
		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}
}

export default function todosExtension(pi: ExtensionAPI): void {
	let todos: TodoItem[] = [];
	let version = 0;
	let quietTurns = 0;

	function refreshUi(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		const th = ctx.ui.theme;

		const { total, completed } = summarize(todos);
		if (total === 0 || completed === total) {
			ctx.ui.setStatus("todos", undefined);
			ctx.ui.setWidget("todos", undefined);
			return;
		}

		const active = activeTodo(todos);
		const now = active ? ` ${th.fg("muted", truncateToWidth(active.activeForm, BADGE_ACTIVE_WIDTH))}` : "";
		ctx.ui.setStatus("todos", `${th.fg("accent", `📋 ${completed}/${total}`)}${now}`);

		const snapshot = todos;
		ctx.ui.setWidget("todos", (_tui, theme) => new TodoWidget(snapshot, theme));
	}

	function reconstructState(ctx: ExtensionContext): void {
		todos = reconstructFromEntries(ctx.sessionManager.getBranch());
		refreshUi(ctx);
	}

	pi.registerTool({
		name: "update_todos",
		label: "Todos",
		description: TOOL_DESCRIPTION,
		promptSnippet: "Track and update the shared todo list for multi-step work",
		promptGuidelines: [
			"Use update_todos for non-trivial work (generally 3+ meaningful steps), multiple requested tasks, or an explicit planning request; skip it for trivial or conversational work.",
			"Each update_todos call must send the complete current list. While work remains, keep exactly one item in_progress and update the list immediately after each completed step or scope change.",
			"Never mark partial, blocked, or failed work completed. On success, send one final all-completed update; do not clear it merely to hide it, because completed lists leave the live UI automatically.",
		],
		parameters: UpdateTodosParams,
		executionMode: "sequential",

		async execute(_toolCallId, params: Static<typeof UpdateTodosParams>, _signal, _onUpdate, ctx) {
			todos = normalizeTodos(params.todos);
			version++;
			quietTurns = 0;
			refreshUi(ctx);

			const advisory = validate(todos);
			const text = advisory ? `${compactResult(todos)} ${advisory}` : compactResult(todos);
			return {
				content: [{ type: "text", text }],
				details: { todos: [...todos], version } as TodoWriteDetails,
			};
		},

		renderCall(args, theme) {
			const count = Array.isArray(args.todos) ? args.todos.length : 0;
			return new Text(
				theme.fg("toolTitle", theme.bold("update_todos ")) +
					theme.fg("muted", `${count} item${count === 1 ? "" : "s"}`),
				0,
				0,
			);
		},

		renderResult(result, { expanded }, theme) {
			const details = result.details as TodoWriteDetails | undefined;
			if (!details) {
				const first = result.content[0];
				return new Text(first?.type === "text" ? first.text : "", 0, 0);
			}
			if (!expanded) {
				return new Text(theme.fg("success", "✓ ") + theme.fg("muted", compactResult(details.todos)), 0, 0);
			}
			if (details.todos.length === 0) {
				return new Text(theme.fg("dim", "No todos"), 0, 0);
			}
			return new Text(details.todos.map((todo) => formatLine(todo, theme)).join("\n"), 0, 0);
		},
	});

	pi.registerCommand("todos", {
		description: "Show the current todo list",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/todos requires interactive mode", "error");
				return;
			}
			const snapshot = todos;
			await ctx.ui.custom<void>((_tui, theme, _kb, done) => new TodoOverlay(snapshot, theme, () => done()));
		},
	});

	// Re-surface the list into the tail only after the model has gone quiet with work
	// still open. Cache-safe: this is an appended custom_message, never a prompt rewrite.
	pi.on("before_agent_start", async () => {
		quietTurns++;
		if (!isActive(todos) || quietTurns < RESURFACE_AFTER_QUIET_TURNS) return;
		quietTurns = 0;
		return {
			message: {
				customType: TODO_REMINDER_TYPE,
				content: reminderLine(todos),
				display: false,
				details: { version },
			},
		};
	});

	// State lives only in tool-result details, so both session load and branch
	// navigation rebuild it from the active branch.
	pi.on("session_start", async (_event, ctx) => reconstructState(ctx));
	pi.on("session_tree", async (_event, ctx) => reconstructState(ctx));
}
