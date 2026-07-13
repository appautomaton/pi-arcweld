/**
 * Cache-safe local plan mode.
 *
 * Plan mode never changes Pi's active tool set or rewrites provider context. It
 * guards only built-in file mutation and model bash calls; other installed
 * tools retain their own policy.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";
import {
	CONFIG_DIR_NAME,
	isToolCallEventType,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import { isPlanDocumentPath } from "./paths.ts";
import { extractTodoItems, markCompletedSteps, type TodoItem } from "./utils.ts";

const PLAN_MODE_CONTEXT_TYPE = "plan-mode-context";
const PLAN_MODE_ENDED_TYPE = "plan-mode-ended";
const PLAN_DOCUMENT_GLOB = `${CONFIG_DIR_NAME}/plans/*.md`;

interface PlanModeState {
	enabled: boolean;
	todos?: TodoItem[];
	executing?: boolean;
	episode?: number;
}

interface PlanContextDetails {
	episode: number;
	kind: "full" | "reminder" | "ended";
}

function isAssistantMessage(message: AgentMessage): message is AssistantMessage {
	return message.role === "assistant" && Array.isArray(message.content);
}

function getTextContent(message: AssistantMessage): string {
	return message.content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isTodoItem(value: unknown): value is TodoItem {
	return (
		isRecord(value) &&
		typeof value.step === "number" &&
		Number.isSafeInteger(value.step) &&
		typeof value.text === "string" &&
		typeof value.completed === "boolean"
	);
}

function isPlanModeState(value: unknown): value is PlanModeState {
	return (
		isRecord(value) &&
		typeof value.enabled === "boolean" &&
		(value.todos === undefined || (Array.isArray(value.todos) && value.todos.every(isTodoItem))) &&
		(value.executing === undefined || typeof value.executing === "boolean") &&
		(value.episode === undefined || (typeof value.episode === "number" && Number.isSafeInteger(value.episode)))
	);
}

function isPlanContextDetails(value: unknown): value is PlanContextDetails {
	return (
		isRecord(value) &&
		typeof value.episode === "number" &&
		Number.isSafeInteger(value.episode) &&
		(value.kind === "full" || value.kind === "reminder" || value.kind === "ended")
	);
}

function latestPlanModeState(entries: readonly unknown[]): PlanModeState | undefined {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (!isRecord(entry) || entry.type !== "custom" || entry.customType !== "plan-mode") continue;
		if (isPlanModeState(entry.data)) return entry.data;
	}
	return undefined;
}

function sameTodoItems(left: TodoItem[], right: TodoItem[]): boolean {
	return (
		left.length === right.length &&
		left.every(
			(item, index) =>
				item.step === right[index]?.step &&
				item.text === right[index]?.text &&
				item.completed === right[index]?.completed,
		)
	);
}

function planInstructions(): string {
	return `[PLAN MODE ACTIVE]
You are in plan mode: a local exploration mode for safe code analysis.

Restrictions enforced by this extension:
- Built-in write and edit are blocked, except Markdown plan documents under ${PLAN_DOCUMENT_GLOB}
- The model bash tool is blocked
- Other installed tools retain their own policy

Use the questionnaire tool when missing user input would materially affect the plan.

Create a detailed numbered plan under a "Plan:" header:

Plan:
1. First step description
2. Second step description
...

You may save the plan to ${PLAN_DOCUMENT_GLOB} if useful.
Do not attempt local file changes outside that directory; present the plan and let the user leave plan mode to execute it.`;
}

function planReminder(): string {
	return `[PLAN MODE ACTIVE — built-in write/edit are limited to ${PLAN_DOCUMENT_GLOB}; model bash is blocked.]`;
}

function planEnded(): string {
	return "[PLAN MODE ENDED — local file and model-bash restrictions are no longer active]";
}

export default function planModeExtension(pi: ExtensionAPI): void {
	let planModeEnabled = false;
	let executionMode = false;
	let todoItems: TodoItem[] = [];
	let episode = 0;

	pi.registerFlag("plan", {
		description: "Start in plan mode (local exploration)",
		type: "boolean",
		default: false,
	});

	function updateStatus(ctx: ExtensionContext): void {
		if (executionMode && todoItems.length > 0) {
			const completed = todoItems.filter((item) => item.completed).length;
			ctx.ui.setStatus("plan-mode", ctx.ui.theme.fg("accent", `📋 ${completed}/${todoItems.length}`));
		} else if (planModeEnabled) {
			ctx.ui.setStatus("plan-mode", ctx.ui.theme.fg("warning", "⏸ plan"));
		} else {
			ctx.ui.setStatus("plan-mode", undefined);
		}

		if (executionMode && todoItems.length > 0) {
			const lines = todoItems.map((item) => {
				if (item.completed) {
					return ctx.ui.theme.fg("success", "☑ ") + ctx.ui.theme.fg("muted", ctx.ui.theme.strikethrough(item.text));
				}
				return `${ctx.ui.theme.fg("muted", "☐ ")}${item.text}`;
			});
			ctx.ui.setWidget("plan-todos", lines);
		} else {
			ctx.ui.setWidget("plan-todos", undefined);
		}
	}

	function persistState(): void {
		pi.appendEntry("plan-mode", {
			enabled: planModeEnabled,
			todos: todoItems,
			executing: executionMode,
			episode,
		} satisfies PlanModeState);
	}

	function beginPlanMode(): void {
		planModeEnabled = true;
		executionMode = false;
		todoItems = [];
		episode++;
	}

	function announcePlanModeEnded(): void {
		pi.sendMessage(
			{
				customType: PLAN_MODE_ENDED_TYPE,
				content: planEnded(),
				display: false,
				details: { episode, kind: "ended" } satisfies PlanContextDetails,
			},
			{ triggerTurn: false },
		);
	}

	function togglePlanMode(ctx: ExtensionContext): void {
		if (planModeEnabled) {
			planModeEnabled = false;
			executionMode = false;
			todoItems = [];
			announcePlanModeEnded();
			ctx.ui.notify("Plan mode disabled. Local restrictions removed.");
		} else {
			beginPlanMode();
			ctx.ui.notify(`Plan mode enabled. Plan documents may be saved to ${PLAN_DOCUMENT_GLOB}.`);
		}
		updateStatus(ctx);
		persistState();
	}

	function hasFullPlanInstructions(ctx: ExtensionContext): boolean {
		return ctx.sessionManager.buildContextEntries().some((entry) => {
			if (entry.type !== "custom_message" || entry.customType !== PLAN_MODE_CONTEXT_TYPE) return false;
			return isPlanContextDetails(entry.details) && entry.details.episode === episode && entry.details.kind === "full";
		});
	}

	pi.registerCommand("plan", {
		description: "Toggle plan mode (local exploration)",
		handler: async (_args, ctx) => togglePlanMode(ctx),
	});

	pi.registerCommand("todos", {
		description: "Show current plan todo list",
		handler: async (_args, ctx) => {
			if (todoItems.length === 0) {
				ctx.ui.notify("No todos. Create a plan first with /plan", "info");
				return;
			}
			const list = todoItems.map((item, index) => `${index + 1}. ${item.completed ? "✓" : "○"} ${item.text}`).join("\n");
			ctx.ui.notify(`Plan Progress:\n${list}`, "info");
		},
	});

	pi.registerShortcut(Key.ctrlAlt("p"), {
		description: "Toggle plan mode",
		handler: async (ctx) => togglePlanMode(ctx),
	});

	pi.on("tool_call", async (event, ctx) => {
		if (!planModeEnabled) return;

		if (isToolCallEventType("write", event) || isToolCallEventType("edit", event)) {
			if (await isPlanDocumentPath(event.input.path, ctx.cwd, CONFIG_DIR_NAME)) return;
			return {
				block: true,
				reason: `Plan mode: local file modification blocked. Only canonical, non-symlinked Markdown plan documents under ${PLAN_DOCUMENT_GLOB} may be changed.`,
			};
		}

		if (isToolCallEventType("bash", event)) {
			return {
				block: true,
				reason: "Plan mode: the model bash tool is blocked. Use Pi's dedicated read and search tools for exploration, or leave plan mode to execute commands.",
			};
		}
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		if (planModeEnabled) {
			const fullInstructions = !hasFullPlanInstructions(ctx);
			return {
				message: {
					customType: PLAN_MODE_CONTEXT_TYPE,
					content: fullInstructions ? planInstructions() : planReminder(),
					display: false,
					details: { episode, kind: fullInstructions ? "full" : "reminder" } satisfies PlanContextDetails,
				},
			};
		}

		if (executionMode && todoItems.length > 0) {
			const remaining = todoItems.filter((item) => !item.completed);
			const todoList = remaining.map((item) => `${item.step}. ${item.text}`).join("\n");
			return {
				message: {
					customType: "plan-execution-context",
					content: `[EXECUTING PLAN - Full tool access enabled]\n\nRemaining steps:\n${todoList}\n\nExecute each step in order.\nAfter completing a step, include a [DONE:n] tag in your response.`,
					display: false,
				},
			};
		}
	});

	pi.on("turn_end", async (event, ctx) => {
		if (!executionMode || todoItems.length === 0 || !isAssistantMessage(event.message)) return;
		if (markCompletedSteps(getTextContent(event.message), todoItems) === 0) return;
		updateStatus(ctx);
		persistState();
	});

	pi.on("agent_end", async (event, ctx) => {
		if (executionMode && todoItems.length > 0) {
			if (!todoItems.every((item) => item.completed)) return;

			const completedList = todoItems.map((item) => `~~${item.text}~~`).join("\n");
			pi.sendMessage(
				{ customType: "plan-complete", content: `**Plan Complete!** ✓\n\n${completedList}`, display: true },
				{ triggerTurn: false },
			);
			executionMode = false;
			todoItems = [];
			updateStatus(ctx);
			persistState();
			return;
		}

		if (!planModeEnabled || !ctx.hasUI) return;

		const lastAssistant = [...event.messages].reverse().find(isAssistantMessage);
		if (lastAssistant) {
			const extracted = extractTodoItems(getTextContent(lastAssistant));
			if (extracted.length > 0 && !sameTodoItems(todoItems, extracted)) {
				todoItems = extracted;
				persistState();
			}
		}

		if (todoItems.length === 0) return;

		const todoListText = todoItems.map((item) => `${item.step}. ☐ ${item.text}`).join("\n");
		const planTodoListMessage = {
			customType: "plan-todo-list",
			content: `**Plan Steps (${todoItems.length}):**\n\n${todoListText}`,
			display: true,
		};
		const choice = await ctx.ui.select("Plan mode - what next?", [
			"Execute the plan (track progress)",
			"Stay in plan mode",
			"Refine the plan",
		]);

		if (choice?.startsWith("Execute")) {
			const firstTodoItem = todoItems[0];
			if (!firstTodoItem) return;

			planModeEnabled = false;
			executionMode = true;
			announcePlanModeEnded();
			updateStatus(ctx);
			persistState();

			const remainingList = todoItems.map((item) => `${item.step}. ${item.text}`).join("\n");
			const executionMessage = `Execute the plan.\n\nRemaining steps:\n${remainingList}\n\nStart with: ${firstTodoItem.text}\nAfter completing a step, include a [DONE:n] tag in your response.`;
			pi.sendMessage(planTodoListMessage, { deliverAs: "followUp" });
			pi.sendMessage(
				{ customType: "plan-mode-execute", content: executionMessage, display: true },
				{ triggerTurn: true, deliverAs: "followUp" },
			);
		} else if (choice === "Stay in plan mode") {
			pi.sendMessage(planTodoListMessage, { triggerTurn: false, deliverAs: "followUp" });
		} else if (choice === "Refine the plan") {
			const refinement = await ctx.ui.editor("Refine the plan:", "");
			if (refinement?.trim()) {
				pi.sendMessage(planTodoListMessage, { deliverAs: "followUp" });
				pi.sendUserMessage(refinement.trim(), { deliverAs: "followUp" });
			}
		}
	});

	pi.on("session_start", async (_event, ctx) => {
		const storedState = latestPlanModeState(ctx.sessionManager.getEntries());
		if (pi.getFlag("plan") === true) {
			episode = (storedState?.episode ?? 0) + 1;
			planModeEnabled = true;
			executionMode = false;
			todoItems = [];
			persistState();
		} else if (storedState) {
			planModeEnabled = storedState.enabled;
			executionMode = storedState.executing ?? false;
			todoItems = storedState.todos ?? [];
			episode = storedState.episode ?? (planModeEnabled ? 1 : 0);
		}

		if (executionMode && todoItems.length > 0) {
			const entries = ctx.sessionManager.getEntries();
			let executeIndex = -1;
			for (let index = entries.length - 1; index >= 0; index--) {
				const entry = entries[index];
				if (entry.type === "custom_message" && entry.customType === "plan-mode-execute") {
					executeIndex = index;
					break;
				}
			}

			const messages: AssistantMessage[] = [];
			for (let index = executeIndex + 1; index < entries.length; index++) {
				const entry = entries[index];
				if (entry.type === "message" && isAssistantMessage(entry.message)) messages.push(entry.message);
			}
			markCompletedSteps(messages.map(getTextContent).join("\n"), todoItems);
		}

		updateStatus(ctx);
	});
}
