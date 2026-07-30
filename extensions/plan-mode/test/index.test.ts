import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import test from "node:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import planModeExtension from "../index.ts";

type EventHandler = (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown;
type CommandHandler = (args: string, ctx: ExtensionContext) => Promise<void> | void;

class FakePi {
	readonly handlers = new Map<string, EventHandler>();
	readonly commands = new Map<string, CommandHandler>();
	readonly entries: Array<{ customType: string; data: unknown }> = [];
	readonly messages: Array<{
		customType: string;
		content: unknown;
		display: boolean | undefined;
		details: unknown;
		options: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" } | undefined;
	}> = [];
	readonly userMessages: Array<{
		text: string;
		options: { deliverAs?: "steer" | "followUp" } | undefined;
	}> = [];
	readonly flags = new Map<string, boolean | string>();
	setActiveToolsCalls = 0;

	on(event: string, handler: unknown): void {
		this.handlers.set(event, handler as EventHandler);
	}

	registerFlag(name: string, options: { default?: boolean | string }): void {
		if (options.default !== undefined) this.flags.set(name, options.default);
	}

	getFlag(name: string): boolean | string | undefined {
		return this.flags.get(name);
	}

	registerCommand(name: string, options: { handler: CommandHandler }): void {
		this.commands.set(name, options.handler);
	}

	registerShortcut(): void {}

	appendEntry(customType: string, data: unknown): void {
		this.entries.push({ customType, data });
	}

	sendMessage(
		message: { customType: string; content: unknown; display?: boolean; details?: unknown },
		options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
	): void {
		this.messages.push({
			customType: message.customType,
			content: message.content,
			display: message.display,
			details: message.details,
			options,
		});
	}

	sendUserMessage(text: string, options?: { deliverAs?: "steer" | "followUp" }): void {
		this.userMessages.push({ text, options });
	}

	setActiveTools(): void {
		this.setActiveToolsCalls++;
	}

	handler(name: string): EventHandler {
		const handler = this.handlers.get(name);
		assert.ok(handler, `missing ${name} handler`);
		return handler;
	}

	command(name: string): CommandHandler {
		const handler = this.commands.get(name);
		assert.ok(handler, `missing ${name} command`);
		return handler;
	}
}

function createContext(cwd: string, entries: unknown[], contextEntries: unknown[] = entries): ExtensionContext {
	return {
		cwd,
		hasUI: false,
		ui: {
			theme: {
				fg: (_color: string, text: string) => text,
				strikethrough: (text: string) => text,
			},
			notify: () => {},
			setStatus: () => {},
			setWidget: () => {},
		},
		sessionManager: {
			getEntries: () => entries,
			buildContextEntries: () => contextEntries,
		},
	} as unknown as ExtensionContext;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function messageFrom(result: unknown): { content: string; details: { episode: number; kind: string } } {
	assert.ok(isRecord(result) && isRecord(result.message));
	const content = result.message.content;
	const details = result.message.details;
	if (typeof content !== "string") throw new TypeError("Expected string message content");
	if (!isRecord(details) || typeof details.episode !== "number" || typeof details.kind !== "string") {
		throw new TypeError("Expected plan-context details");
	}
	return { content, details: { episode: details.episode, kind: details.kind } };
}

async function withProject(run: (cwd: string) => Promise<void>): Promise<void> {
	const cwd = await mkdtemp(join(tmpdir(), "pi-arcweld-plan-mode-"));
	try {
		await run(cwd);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
}

test("keeps tool inventory stable while blocking only built-in local mutations and model bash", async () => {
	await withProject(async (cwd) => {
		const fake = new FakePi();
		planModeExtension(fake as unknown as ExtensionAPI);
		assert.equal(fake.handlers.has("context"), false);

		const context = createContext(cwd, []);
		await fake.command("plan")("", context);

		const toolCall = fake.handler("tool_call");
		const readOnlyBash = await toolCall({ toolName: "bash", input: { command: "rg -n foo src/" } }, context);
		assert.equal(readOnlyBash, undefined);

		const mutatingBash = await toolCall({ toolName: "bash", input: { command: "rm -rf build" } }, context);
		assert.ok(isRecord(mutatingBash) && mutatingBash.block === true);

		const write = await toolCall({ toolName: "write", input: { path: ".pi/plans/plan.md", content: "Plan\n" } }, context);
		assert.equal(write, undefined);

		const unrelated = await toolCall({ toolName: "deploy", input: {} }, context);
		assert.equal(unrelated, undefined);
		assert.equal(fake.setActiveToolsCalls, 0);
	});
});

test("restores full instructions when the active context does not contain the current episode", async () => {
	await withProject(async (cwd) => {
		const state = { type: "custom", customType: "plan-mode", data: { enabled: true, episode: 7 } };
		const entries: unknown[] = [state];
		const contextEntries: unknown[] = [state];
		const fake = new FakePi();
		planModeExtension(fake as unknown as ExtensionAPI);
		const context = createContext(cwd, entries, contextEntries);

		await fake.handler("session_start")({}, context);
		const full = messageFrom(await fake.handler("before_agent_start")({}, context));
		assert.equal(full.details.episode, 7);
		assert.equal(full.details.kind, "full");
		assert.match(full.content, /record the plan by calling update_todos/);

		contextEntries.push({
			type: "custom_message",
			customType: "plan-mode-context",
			details: { episode: 7, kind: "full" },
		});
		const reminder = messageFrom(await fake.handler("before_agent_start")({}, context));
		assert.equal(reminder.details.kind, "reminder");
	});
});

test("re-appends full instructions when compaction removes the current episode context", async () => {
	await withProject(async (cwd) => {
		const state = { type: "custom", customType: "plan-mode", data: { enabled: true, episode: 3 } };
		const compactedInstruction = {
			type: "custom_message",
			customType: "plan-mode-context",
			details: { episode: 3, kind: "full" },
		};
		const fake = new FakePi();
		planModeExtension(fake as unknown as ExtensionAPI);
		const context = createContext(cwd, [state, compactedInstruction], [state]);

		await fake.handler("session_start")({}, context);
		const message = messageFrom(await fake.handler("before_agent_start")({}, context));
		assert.equal(message.details.kind, "full");
	});
});

test("an explicit plan flag starts a new episode over persisted disabled state", async () => {
	await withProject(async (cwd) => {
		const state = { type: "custom", customType: "plan-mode", data: { enabled: false, episode: 4 } };
		const fake = new FakePi();
		planModeExtension(fake as unknown as ExtensionAPI);
		fake.flags.set("plan", true);
		const context = createContext(cwd, [state]);

		await fake.handler("session_start")({}, context);
		const message = messageFrom(await fake.handler("before_agent_start")({}, context));
		assert.equal(message.details.episode, 5);
		assert.equal(message.details.kind, "full");
	});
});

function todoResult(todos: Array<{ content: string; status: string }>): unknown {
	return { type: "message", message: { role: "toolResult", toolName: "update_todos", details: { todos, version: 1 } } };
}

function createHandoffContext(
	entries: unknown[],
	selectChoice: string | undefined,
	onSelect?: () => void,
): { ctx: ExtensionContext; calls: { select: number }; notifications: string[] } {
	const calls = { select: 0 };
	const notifications: string[] = [];
	const ctx = {
		cwd: "/tmp/plan-mode",
		hasUI: true,
		ui: {
			theme: { fg: (_color: string, text: string) => text, strikethrough: (text: string) => text },
			notify: (message: string) => notifications.push(message),
			setStatus: () => {},
			setWidget: () => {},
			select: async () => {
				calls.select++;
				onSelect?.();
				return selectChoice;
			},
			editor: async () => undefined,
		},
		sessionManager: {
			getEntries: () => entries,
			buildContextEntries: () => entries,
			getBranch: () => entries,
		},
	} as unknown as ExtensionContext;
	return { ctx, calls, notifications };
}

test("does not offer the handoff when the recorded plan is already complete", async () => {
	const fake = new FakePi();
	planModeExtension(fake as unknown as ExtensionAPI);
	const entries = [todoResult([{ content: "Review docs", status: "completed" }])];
	const { ctx, calls } = createHandoffContext(entries, "Execute the plan");

	await fake.command("plan")("", ctx); // enter plan mode
	await fake.handler("agent_settled")({}, ctx);

	assert.equal(calls.select, 0);
});

test("offers the handoff when the plan still has pending steps", async () => {
	const fake = new FakePi();
	planModeExtension(fake as unknown as ExtensionAPI);
	const entries = [todoResult([{ content: "Add caching", status: "pending" }])];
	const { ctx, calls } = createHandoffContext(entries, "Stay in plan mode");

	await fake.command("plan")("", ctx);
	await fake.handler("agent_settled")({}, ctx);

	assert.equal(calls.select, 1);
});

test("executes through one transparent settled custom message without a follow-up queue", async () => {
	const fake = new FakePi();
	planModeExtension(fake as unknown as ExtensionAPI);
	const entries = [todoResult([{ content: "Add caching", status: "pending" }])];
	const { ctx, calls } = createHandoffContext(entries, "Execute the plan");

	await fake.command("plan")("", ctx);
	assert.equal(fake.handlers.has("agent_end"), false);
	await fake.handler("agent_settled")({}, ctx);

	assert.equal(calls.select, 1);
	assert.deepEqual(fake.userMessages, []);
	const executeMessages = fake.messages.filter((message) => message.customType === "plan-mode-execute");
	assert.equal(executeMessages.length, 1);
	assert.equal(executeMessages[0].display, true);
	assert.deepEqual(executeMessages[0].options, { triggerTurn: true });
	assert.match(String(executeMessages[0].content), /\[PLAN EXECUTION HANDOFF\]/);
	assert.match(String(executeMessages[0].content), /Add caching/);

	await fake.handler("agent_settled")({}, ctx);
	assert.equal(calls.select, 1);
	assert.equal(fake.messages.filter((message) => message.customType === "plan-mode-execute").length, 1);
});

test("revalidates the todo list before execution and skips a plan completed while the dialog was open", async () => {
	const fake = new FakePi();
	planModeExtension(fake as unknown as ExtensionAPI);
	const entries = [todoResult([{ content: "Add caching", status: "pending" }])];
	const { ctx, notifications } = createHandoffContext(entries, "Execute the plan", () => {
		entries.push(todoResult([{ content: "Add caching", status: "completed" }]));
	});

	await fake.command("plan")("", ctx);
	await fake.handler("agent_settled")({}, ctx);

	assert.equal(fake.messages.some((message) => message.customType === "plan-mode-execute"), false);
	assert.equal(fake.userMessages.length, 0);
	assert.ok(notifications.some((message) => message.includes("already complete")));
});
