import assert from "node:assert/strict";
import test from "node:test";
import { extractTodoItems, markCompletedSteps, type TodoItem } from "../utils.ts";

test("extracts only the contiguous numbered list under Plan", () => {
	const items = extractTodoItems(`Plan:
1. **Inspect** the current implementation
2. Add regression tests

## Risks
1. This is not another plan step
`);

	assert.deepEqual(items, [
		{ step: 1, text: "Inspect the current implementation", completed: false },
		{ step: 2, text: "Regression tests", completed: false },
	]);
});

test("stops extraction when numbering is not contiguous", () => {
	const items = extractTodoItems(`Plan:
1. First task
3. Skipped number
`);

	assert.deepEqual(items, [{ step: 1, text: "First task", completed: false }]);
});

test("marks only newly completed steps", () => {
	const items: TodoItem[] = [
		{ step: 1, text: "First", completed: false },
		{ step: 2, text: "Second", completed: true },
	];

	assert.equal(markCompletedSteps("[DONE:1] [DONE:1] [DONE:2] [DONE:99]", items), 1);
	assert.deepEqual(items, [
		{ step: 1, text: "First", completed: true },
		{ step: 2, text: "Second", completed: true },
	]);
});
