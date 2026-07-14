import assert from "node:assert/strict";
import test from "node:test";
import {
	asTodoItems,
	compactResult,
	normalizeTodos,
	reconstructFromEntries,
	reminderLine,
	summarize,
	type TodoItem,
	validate,
} from "../utils.ts";

const todo = (content: string, activeForm: string, status: TodoItem["status"]): TodoItem => ({
	content,
	activeForm,
	status,
});

function toolResult(toolName: string, details: unknown) {
	return { type: "message", message: { role: "toolResult", toolName, details } };
}

test("summarize counts each status", () => {
	const counts = summarize([
		todo("a", "a", "completed"),
		todo("b", "b", "in_progress"),
		todo("c", "c", "pending"),
		todo("d", "d", "pending"),
	]);
	assert.deepEqual(counts, { total: 4, pending: 2, inProgress: 1, completed: 1 });
});

test("normalizeTodos trims content and activeForm", () => {
	const [item] = normalizeTodos([todo("  build  ", "\tbuilding\n", "pending")]);
	assert.equal(item.content, "build");
	assert.equal(item.activeForm, "building");
});

test("compactResult summarizes the list state", () => {
	assert.equal(compactResult([]), "todos: empty");
	assert.equal(compactResult([todo("a", "a", "completed"), todo("b", "b", "completed")]), "todos: 2/2 done ✓");
	assert.equal(
		compactResult([todo("Run tests", "Running tests", "in_progress"), todo("Ship", "Shipping", "pending")]),
		"todos: 0/2 done · now: Running tests",
	);
});

test("validate nudges the single-in-progress discipline without throwing", () => {
	assert.equal(validate([todo("a", "a", "in_progress"), todo("b", "b", "in_progress")]), "note: keep exactly one item in_progress");
	assert.equal(validate([todo("a", "a", "pending"), todo("b", "b", "pending")]), "note: set the next item in_progress");
	assert.equal(validate([todo("a", "a", "in_progress"), todo("b", "b", "pending")]), "");
	assert.equal(validate([todo("a", "a", "completed")]), "");
	assert.equal(validate([]), "");
});

test("reminderLine is compact and summarizes pending overflow", () => {
	const line = reminderLine([
		todo("Run tests", "Running tests", "in_progress"),
		todo("Fix lint", "Fixing lint", "pending"),
		todo("Update docs", "Updating docs", "pending"),
		todo("Write README", "Writing README", "pending"),
		todo("Ship it", "Shipping it", "pending"),
	]);
	assert.match(line, /\[todos 0\/5\]/);
	assert.match(line, /in progress: Running tests/);
	assert.match(line, /pending: Fix lint, Update docs, Write README \(\+1\)/);
	assert.match(line, /Keep update_todos current/);
});

test("reminderLine reports no active item when none is in progress", () => {
	const line = reminderLine([todo("Fix lint", "Fixing lint", "pending")]);
	assert.match(line, /in progress: none/);
});

test("reconstructFromEntries takes the latest update_todos result and ignores others", () => {
	const first = [todo("old", "old", "completed")];
	const other = [todo("noise", "noise", "pending")];
	const latest = [todo("new", "new", "in_progress"), todo("next", "next", "pending")];
	const entries = [
		toolResult("update_todos", { todos: first, version: 1 }),
		toolResult("read", { todos: other }),
		toolResult("update_todos", { todos: latest, version: 2 }),
		{ type: "message", message: { role: "assistant", content: [] } },
	];
	assert.deepEqual(reconstructFromEntries(entries), latest);
});

test("reconstructFromEntries skips malformed details and keeps the last good list", () => {
	const good = [todo("keep", "keep", "pending")];
	const entries = [
		toolResult("update_todos", { todos: good, version: 1 }),
		toolResult("update_todos", { todos: [{ content: "bad" }], version: 2 }),
	];
	assert.deepEqual(reconstructFromEntries(entries), good);
});

test("asTodoItems rejects malformed shapes", () => {
	assert.equal(asTodoItems("nope"), undefined);
	assert.equal(asTodoItems([{ content: "a", activeForm: "a", status: "bogus" }]), undefined);
	assert.deepEqual(asTodoItems([{ content: "a", activeForm: "a", status: "pending" }]), [todo("a", "a", "pending")]);
});
