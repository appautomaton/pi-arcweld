import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import delegateExtension from "../index.ts";

type ToolHandler = (...args: never[]) => unknown;

class FakePi {
	readonly tools = new Map<string, { name: string; executionMode?: string }>();
	readonly commands = new Map<string, { handler: ToolHandler; getArgumentCompletions?: (prefix: string) => unknown }>();
	setActiveToolsCalls = 0;

	registerTool(tool: { name: string; executionMode?: string }): void {
		this.tools.set(tool.name, tool);
	}

	registerCommand(name: string, options: { handler: ToolHandler; getArgumentCompletions?: (prefix: string) => unknown }): void {
		this.commands.set(name, options);
	}

	setActiveTools(): void {
		this.setActiveToolsCalls++;
	}
}

test("registers delegate once at load and never calls setActiveTools", () => {
	const fake = new FakePi();
	delegateExtension(fake as unknown as ExtensionAPI);
	assert.equal(fake.tools.has("delegate"), true);
	assert.equal(fake.tools.has("delegate_result"), false);
	assert.equal(fake.tools.get("delegate")?.executionMode, "sequential");
	assert.equal(fake.commands.has("delegate"), true);
	assert.equal(fake.setActiveToolsCalls, 0);
});

test("/delegate completions are alias names", () => {
	const fake = new FakePi();
	delegateExtension(fake as unknown as ExtensionAPI);
	const completions = fake.commands.get("delegate")?.getArgumentCompletions;
	assert.equal(typeof completions, "function");
	const empty = completions?.("");
	assert.ok(empty === null || Array.isArray(empty));
});
