import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import todosExtension from "../index.ts";
import type { TodoItem } from "../utils.ts";

type Handler = (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown;
type ToolDef = {
	name: string;
	executionMode?: string;
	promptGuidelines?: string[];
	execute: (id: string, params: unknown, signal: unknown, onUpdate: unknown, ctx: ExtensionContext) => Promise<{ content: { type: string; text: string }[]; details: { todos: TodoItem[]; version: number } }>;
};

class FakePi {
	readonly tools = new Map<string, ToolDef>();
	readonly commands = new Map<string, Handler>();
	readonly handlers = new Map<string, Handler>();
	setActiveToolsCalls = 0;

	registerTool(def: ToolDef): void {
		this.tools.set(def.name, def);
	}
	registerCommand(name: string, opts: { handler: Handler }): void {
		this.commands.set(name, opts.handler);
	}
	registerFlag(): void {}
	registerShortcut(): void {}
	setActiveTools(): void {
		this.setActiveToolsCalls++;
	}
	on(event: string, handler: Handler): void {
		this.handlers.set(event, handler);
	}
	tool(name: string): ToolDef {
		const def = this.tools.get(name);
		assert.ok(def, `missing ${name} tool`);
		return def;
	}
	handler(name: string): Handler {
		const handler = this.handlers.get(name);
		assert.ok(handler, `missing ${name} handler`);
		return handler;
	}
}

function createContext(entries: unknown[], hasUI = false) {
	const statuses = new Map<string, string | undefined>();
	const widgets = new Map<string, unknown>();
	const theme = {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
		strikethrough: (text: string) => text,
	};
	const ctx = {
		cwd: "/tmp/todos",
		mode: "tui",
		hasUI,
		ui: {
			theme,
			notify: () => {},
			setStatus: (key: string, text: string | undefined) => statuses.set(key, text),
			setWidget: (key: string, content: unknown) => widgets.set(key, content),
		},
		sessionManager: {
			getBranch: () => entries,
			getEntries: () => entries,
			buildContextEntries: () => entries,
		},
	} as unknown as ExtensionContext;
	return { ctx, statuses, widgets };
}

const todo = (content: string, activeForm: string, status: TodoItem["status"]): TodoItem => ({
	content,
	activeForm,
	status,
});

function toolResultEntry(todos: TodoItem[], version: number) {
	return { type: "message", message: { role: "toolResult", toolName: "update_todos", details: { todos, version } } };
}

test("registers update_todos once and never toggles the active tool set", () => {
	const fake = new FakePi();
	todosExtension(fake as unknown as ExtensionAPI);

	const tool = fake.tool("update_todos");
	assert.equal(tool.executionMode, "sequential");
	assert.equal(tool.promptGuidelines?.length, 3);
	assert.ok(fake.commands.has("todos"));
	assert.equal(fake.setActiveToolsCalls, 0);
});

test("execute replaces the list, returns compact content, and carries full details", async () => {
	const fake = new FakePi();
	todosExtension(fake as unknown as ExtensionAPI);
	const tool = fake.tool("update_todos");
	const { ctx } = createContext([]);

	const first = await tool.execute(
		"c1",
		{ todos: [todo("Run tests", "Running tests", "in_progress"), todo("Ship", "Shipping", "pending")] },
		undefined,
		undefined,
		ctx,
	);
	assert.equal(first.content[0].text, "todos: 0/2 done · now: Running tests");
	assert.equal(first.details.todos.length, 2);
	assert.equal(first.details.version, 1);

	const second = await tool.execute(
		"c2",
		{ todos: [todo("Run tests", "Running tests", "completed")] },
		undefined,
		undefined,
		ctx,
	);
	// Whole-list-replace: the second call supersedes the first entirely.
	assert.equal(second.details.todos.length, 1);
	assert.equal(second.content[0].text, "todos: 1/1 done ✓");
	assert.equal(second.details.version, 2);
});

test("execute appends a soft advisory without erroring", async () => {
	const fake = new FakePi();
	todosExtension(fake as unknown as ExtensionAPI);
	const tool = fake.tool("update_todos");
	const { ctx } = createContext([]);

	const twoActive = await tool.execute(
		"c1",
		{ todos: [todo("a", "a", "in_progress"), todo("b", "b", "in_progress")] },
		undefined,
		undefined,
		ctx,
	);
	assert.match(twoActive.content[0].text, /keep exactly one item in_progress/);

	const noneActive = await tool.execute(
		"c2",
		{ todos: [todo("a", "a", "pending")] },
		undefined,
		undefined,
		ctx,
	);
	assert.match(noneActive.content[0].text, /set the next item in_progress/);
});

test("session_tree rebuilds the badge from the latest branch todo result", async () => {
	const fake = new FakePi();
	todosExtension(fake as unknown as ExtensionAPI);
	const entries = [
		toolResultEntry([todo("old", "old", "completed")], 1),
		toolResultEntry([todo("Run tests", "Running tests", "in_progress"), todo("Ship", "Shipping", "pending"), todo("Done", "Doing", "completed")], 2),
	];
	const { ctx, statuses } = createContext(entries, true);

	await fake.handler("session_tree")({}, ctx);
	const badge = statuses.get("todos");
	assert.ok(typeof badge === "string" && badge.includes("📋 1/3"), `badge was ${badge}`);
	assert.match(badge as string, /Running tests/);
});

test("empty list clears the badge and widget", async () => {
	const fake = new FakePi();
	todosExtension(fake as unknown as ExtensionAPI);
	const tool = fake.tool("update_todos");
	const { ctx, statuses, widgets } = createContext([], true);

	await tool.execute("c1", { todos: [] }, undefined, undefined, ctx);
	assert.equal(statuses.get("todos"), undefined);
	assert.equal(widgets.get("todos"), undefined);
});

test("the reminder fires only after quiet turns and resets on each write", async () => {
	const fake = new FakePi();
	todosExtension(fake as unknown as ExtensionAPI);
	const tool = fake.tool("update_todos");
	const before = fake.handler("before_agent_start");
	const { ctx } = createContext([]);

	await tool.execute("c1", { todos: [todo("Run tests", "Running tests", "in_progress")] }, undefined, undefined, ctx);

	for (let turn = 1; turn <= 5; turn++) {
		assert.equal(await before({}, ctx), undefined, `turn ${turn} should stay quiet`);
	}
	const fired = (await before({}, ctx)) as { message?: { content: string } } | undefined;
	assert.ok(fired?.message, "reminder should fire on the sixth quiet turn");
	assert.match(fired.message.content, /\[todos 0\/1\]/);

	// After firing it resets, so the next five turns are quiet again.
	for (let turn = 1; turn <= 5; turn++) {
		assert.equal(await before({}, ctx), undefined);
	}

	// A write resets the counter mid-cycle.
	await tool.execute("c2", { todos: [todo("Run tests", "Running tests", "in_progress")] }, undefined, undefined, ctx);
	assert.equal(await before({}, ctx), undefined);
});

test("no reminder while the list is empty or fully complete", async () => {
	const fake = new FakePi();
	todosExtension(fake as unknown as ExtensionAPI);
	const tool = fake.tool("update_todos");
	const before = fake.handler("before_agent_start");
	const { ctx } = createContext([]);

	await tool.execute("c1", { todos: [todo("a", "a", "completed")] }, undefined, undefined, ctx);
	for (let turn = 1; turn <= 8; turn++) {
		assert.equal(await before({}, ctx), undefined);
	}
});
