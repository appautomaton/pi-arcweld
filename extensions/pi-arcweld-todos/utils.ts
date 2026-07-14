/**
 * Pure schema and helpers for the update_todos tool.
 *
 * Nothing here touches Pi APIs or the terminal, so every function is directly
 * unit-testable. Rendering that needs a theme lives in index.ts.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";

/** How long the model may go without touching the list before we re-surface it. */
export const RESURFACE_AFTER_QUIET_TURNS = 6;

/** How many pending item names the compact reminder names before summarizing the rest. */
export const REMINDER_MAX_PENDING = 3;

/** Per-name character budget in the compact reminder, to keep it to one short line. */
export const REMINDER_NAME_MAX = 48;

export const TodoStatus = StringEnum(["pending", "in_progress", "completed"] as const);

export const TodoItemSchema = Type.Object({
	content: Type.String({
		description: "The task in imperative form, e.g. 'Add pagination to the results endpoint'.",
	}),
	activeForm: Type.String({
		description:
			"The same task in present-continuous form, e.g. 'Adding pagination to the results endpoint'. Shown live in the UI while this item is in progress.",
	}),
	status: TodoStatus,
});

export const UpdateTodosParams = Type.Object({
	todos: Type.Array(TodoItemSchema, {
		description:
			"The COMPLETE ordered todo list. This replaces the previous list entirely; include every item every time.",
	}),
});

export type TodoItem = Static<typeof TodoItemSchema>;
export type TodoStatusValue = TodoItem["status"];

/** Structured details attached to each update_todos tool result. Carries all session state. */
export interface TodoWriteDetails {
	todos: TodoItem[];
	version: number;
}

export interface TodoCounts {
	total: number;
	pending: number;
	inProgress: number;
	completed: number;
}

/** Trim item text so stored/rendered state never carries stray whitespace. */
export function normalizeTodos(todos: readonly TodoItem[]): TodoItem[] {
	return todos.map((todo) => ({
		content: todo.content.trim(),
		activeForm: todo.activeForm.trim(),
		status: todo.status,
	}));
}

export function summarize(todos: readonly TodoItem[]): TodoCounts {
	let pending = 0;
	let inProgress = 0;
	let completed = 0;
	for (const todo of todos) {
		if (todo.status === "completed") completed++;
		else if (todo.status === "in_progress") inProgress++;
		else pending++;
	}
	return { total: todos.length, pending, inProgress, completed };
}

/** The one item currently in progress, if any. */
export function activeTodo(todos: readonly TodoItem[]): TodoItem | undefined {
	return todos.find((todo) => todo.status === "in_progress");
}

/** A list is "active" while it holds at least one item that is not yet completed. */
export function isActive(todos: readonly TodoItem[]): boolean {
	return todos.length > 0 && todos.some((todo) => todo.status !== "completed");
}

/** Compact one-line result returned to the model. Full state travels in `details`, not here. */
export function compactResult(todos: readonly TodoItem[]): string {
	if (todos.length === 0) return "todos: empty";
	const { total, completed } = summarize(todos);
	if (completed === total) return `todos: ${total}/${total} done ✓`;
	const active = activeTodo(todos);
	const now = active ? ` · now: ${clip(active.activeForm, REMINDER_NAME_MAX)}` : "";
	return `todos: ${completed}/${total} done${now}`;
}

/**
 * Soft validation. Returns a short advisory (never throws) when the list breaks
 * the single-in-progress discipline, so the model can self-correct on its next call.
 */
export function validate(todos: readonly TodoItem[]): string {
	const { inProgress, pending } = summarize(todos);
	if (inProgress > 1) return "note: keep exactly one item in_progress";
	if (inProgress === 0 && pending > 0) return "note: set the next item in_progress";
	return "";
}

/**
 * The short reminder appended to the tail when the model has gone quiet with work
 * still open. Deliberately compact — the full guidance lives in the cached tool
 * description, so this is only a nudge.
 */
export function reminderLine(todos: readonly TodoItem[]): string {
	const { total, completed } = summarize(todos);
	const active = activeTodo(todos);
	const inProgress = active ? clip(active.activeForm, REMINDER_NAME_MAX) : "none";

	const pending = todos.filter((todo) => todo.status === "pending");
	const named = pending.slice(0, REMINDER_MAX_PENDING).map((todo) => clip(todo.content, REMINDER_NAME_MAX));
	const overflow = pending.length - named.length;
	let pendingPart = "";
	if (named.length > 0) {
		pendingPart = ` · pending: ${named.join(", ")}${overflow > 0 ? ` (+${overflow})` : ""}`;
	}

	return `[todos ${completed}/${total}] in progress: ${inProgress}${pendingPart}. Keep update_todos current as items complete.`;
}

/**
 * Rebuild the list from session entries: the latest update_todos tool result on the
 * branch wins (whole-list-replace). Duck-typed so it can run against real session
 * entries or test fixtures without importing Pi's message types.
 */
export function reconstructFromEntries(entries: readonly unknown[]): TodoItem[] {
	let todos: TodoItem[] = [];
	for (const entry of entries) {
		if (!isRecord(entry) || entry.type !== "message") continue;
		const message = entry.message;
		if (!isRecord(message) || message.role !== "toolResult" || message.toolName !== "update_todos") continue;
		const details = message.details;
		if (!isRecord(details)) continue;
		const parsed = asTodoItems(details.todos);
		if (parsed) todos = parsed;
	}
	return todos;
}

function clip(text: string, max: number): string {
	if (text.length <= max) return text;
	if (max <= 1) return text.slice(0, max);
	return `${text.slice(0, max - 1)}…`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isTodoStatus(value: unknown): value is TodoStatusValue {
	return value === "pending" || value === "in_progress" || value === "completed";
}

/** Narrow an unknown (deserialized) value into a TodoItem[], or undefined if malformed. */
export function asTodoItems(value: unknown): TodoItem[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const items: TodoItem[] = [];
	for (const raw of value) {
		if (
			!isRecord(raw) ||
			typeof raw.content !== "string" ||
			typeof raw.activeForm !== "string" ||
			!isTodoStatus(raw.status)
		) {
			return undefined;
		}
		items.push({ content: raw.content, activeForm: raw.activeForm, status: raw.status });
	}
	return items;
}
