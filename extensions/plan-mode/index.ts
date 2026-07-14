/**
 * Cache-safe local plan mode.
 *
 * Plan mode is a policy layer only. It never changes Pi's active tool set or
 * rewrites provider context. It guards built-in file mutation and the model bash
 * tool; every other installed tool retains its own policy. Progress tracking is
 * not this extension's job: the model records its plan by calling the update_todos
 * tool (see pi-arcweld-todos), which tracks execution in every mode.
 */

import {
	CONFIG_DIR_NAME,
	isToolCallEventType,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import { isPlanDocumentPath } from "./paths.ts";

const PLAN_MODE_STATE_TYPE = "plan-mode";
const PLAN_MODE_CONTEXT_TYPE = "plan-mode-context";
const PLAN_MODE_ENDED_TYPE = "plan-mode-ended";
const PLAN_DOCUMENT_GLOB = `${CONFIG_DIR_NAME}/plans/*.md`;

interface PlanModeState {
	enabled: boolean;
	episode: number;
}

interface PlanContextDetails {
	episode: number;
	kind: "full" | "reminder" | "ended";
}

/** Minimal view of an update_todos result. The only contract shared with pi-arcweld-todos. */
interface PlanTodo {
	content: string;
	status: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isPlanModeState(value: unknown): value is PlanModeState {
	return (
		isRecord(value) &&
		typeof value.enabled === "boolean" &&
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
		if (!isRecord(entry) || entry.type !== "custom" || entry.customType !== PLAN_MODE_STATE_TYPE) continue;
		if (isPlanModeState(entry.data)) return entry.data;
	}
	return undefined;
}

/** Latest update_todos list on the active branch, read structurally without importing the todos extension. */
function latestTodos(ctx: ExtensionContext): PlanTodo[] {
	let todos: PlanTodo[] = [];
	for (const entry of ctx.sessionManager.getBranch()) {
		if (!isRecord(entry) || entry.type !== "message") continue;
		const message = (entry as { message?: unknown }).message;
		if (!isRecord(message) || message.role !== "toolResult" || message.toolName !== "update_todos") continue;
		const details = message.details;
		if (isRecord(details) && Array.isArray(details.todos)) todos = details.todos as PlanTodo[];
	}
	return todos;
}

function planInstructions(): string {
	return `[PLAN MODE]
You are in plan mode. Explore the code freely and think hard before proposing any change.

Restrictions enforced by this extension while plan mode is active:
- Built-in write and edit are blocked, except Markdown plan documents under ${PLAN_DOCUMENT_GLOB}.
- The model bash tool is blocked. Use Pi's read and search tools to investigate.
- Other installed tools keep their own policy.

Do the real work of planning:
- Read the relevant code and learn how it behaves today, rather than assuming.
- Use the questionnaire tool when a missing decision would materially change the plan.
- Weigh the approaches and their trade-offs before you commit to one.

When you have a plan, record it by calling the update_todos tool as an ordered list of
concrete, verifiable steps, each with status "pending". That todo list, not prose in this
reply, is the durable plan: it carries into execution and tracks progress there. You may
also save a fuller write-up under ${PLAN_DOCUMENT_GLOB} if it helps.

Do not implement yet. Present your plan and let the user leave plan mode to execute it.`;
}

function planReminder(): string {
	return `[PLAN MODE: built-in write and edit are limited to ${PLAN_DOCUMENT_GLOB}, and the model bash tool is blocked. Record the plan with update_todos.]`;
}

function planEnded(): string {
	return "[PLAN MODE ENDED: local file and model-bash restrictions are no longer active.]";
}

export default function planModeExtension(pi: ExtensionAPI): void {
	let planModeEnabled = false;
	let episode = 0;

	pi.registerFlag("plan", {
		description: "Start in plan mode (local exploration)",
		type: "boolean",
		default: false,
	});

	function updateStatus(ctx: ExtensionContext): void {
		ctx.ui.setStatus("plan-mode", planModeEnabled ? ctx.ui.theme.fg("warning", "⏸ plan") : undefined);
	}

	function persistState(): void {
		pi.appendEntry(PLAN_MODE_STATE_TYPE, { enabled: planModeEnabled, episode } satisfies PlanModeState);
	}

	function beginPlanMode(): void {
		planModeEnabled = true;
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
		if (!planModeEnabled) return;
		const fullInstructions = !hasFullPlanInstructions(ctx);
		return {
			message: {
				customType: PLAN_MODE_CONTEXT_TYPE,
				content: fullInstructions ? planInstructions() : planReminder(),
				display: false,
				details: { episode, kind: fullInstructions ? "full" : "reminder" } satisfies PlanContextDetails,
			},
		};
	});

	pi.on("agent_end", async (_event, ctx) => {
		if (!planModeEnabled || !ctx.hasUI) return;

		const todos = latestTodos(ctx);
		if (todos.length === 0) return;

		const choice = await ctx.ui.select("Plan mode - what next?", [
			"Execute the plan",
			"Stay in plan mode",
			"Refine the plan",
		]);

		if (choice === "Execute the plan") {
			planModeEnabled = false;
			announcePlanModeEnded();
			updateStatus(ctx);
			persistState();
			pi.sendUserMessage(
				"Leave plan mode and execute the plan you recorded in the todo list. Set the first item in_progress and begin.",
				{ deliverAs: "followUp" },
			);
		} else if (choice === "Refine the plan") {
			const refinement = await ctx.ui.editor("Refine the plan:", "");
			if (refinement?.trim()) {
				pi.sendUserMessage(refinement.trim(), { deliverAs: "followUp" });
			}
		}
	});

	pi.on("session_start", async (_event, ctx) => {
		const storedState = latestPlanModeState(ctx.sessionManager.getEntries());
		if (pi.getFlag("plan") === true) {
			episode = (storedState?.episode ?? 0) + 1;
			planModeEnabled = true;
			persistState();
		} else if (storedState) {
			planModeEnabled = storedState.enabled;
			episode = storedState.episode ?? (planModeEnabled ? 1 : 0);
		}

		updateStatus(ctx);
	});
}
