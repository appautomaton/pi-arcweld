import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadExtensions } from "../../build/pi-agent/runtime/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js";
import { visibleWidth } from "../../build/pi-agent/runtime/node_modules/@earendil-works/pi-tui/dist/index.js";

const loaded = await loadExtensions([fileURLToPath(new URL("../questionnaire.ts", import.meta.url))], process.cwd());
assert.deepEqual(loaded.errors, []);
const tool = loaded.extensions[0]!.tools.get("questionnaire")!.definition;
const theme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};

async function answer(questions: unknown[], interact: (component: any) => void) {
	return tool.execute("questionnaire-compatibility", { questions }, undefined, undefined, {
		mode: "tui",
		ui: {
			custom: async (factory: any) => new Promise((resolve) => {
				const component = factory({ terminal: { rows: 40, columns: 80 }, requestRender() {} }, theme, {}, resolve);
				interact(component);
			}),
		},
	} as any);
}

const question = {
	id: "scope",
	prompt: "请选择需要检查的范围。Choose the scope of this compatibility review.",
	options: [{ value: "all", label: "All extensions" }, { value: "search", label: "Search only" }],
};

test("questionnaire stays model-only and reports missing terminal UI as an error", async () => {
	assert.equal(tool.exposure, "model-only");
	const result = await tool.execute("non-tui", { questions: [question] }, undefined, undefined, { mode: "json" } as any);
	assert.equal(result.isError, true);
});

test("questionnaire renders with the current TUI and accepts a keyboard selection", { timeout: 1000 }, async () => {
	const result = await answer([question], (component) => {
		for (const width of [30, 80]) {
			component.invalidate();
			assert.ok(component.render(width).every((line: string) => visibleWidth(line) <= width));
		}
		component.handleInput("\u001b[B");
		component.handleInput("\r");
	});
	assert.equal((result.details as any).answers[0].value, "search");
	assert.equal((result.details as any).cancelled, false);
});

test("questionnaire accepts a typed answer and submits multiple questions", { timeout: 1000 }, async () => {
	const result = await answer([question, { id: "notes", prompt: "Any constraints?", options: [] }], (component) => {
		component.handleInput("\r");
		component.handleInput("\r");
		for (const character of "Keep it simple") component.handleInput(character);
		assert.ok(component.render(60).length > 0);
		component.handleInput("\r");
		component.handleInput("\r");
	});
	assert.deepEqual((result.details as any).answers.map((item: any) => item.value), ["all", "Keep it simple"]);
	assert.equal((result.details as any).cancelled, false);
});

test("questionnaire preserves cancellation", { timeout: 1000 }, async () => {
	const result = await answer([question], (component) => component.handleInput("\u001b"));
	assert.equal((result.details as any).cancelled, true);
});
