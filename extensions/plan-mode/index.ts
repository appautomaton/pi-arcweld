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
import { isReadOnlyCommand } from "./commands.ts";
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
Plan mode is for understanding, not doing. Your work here is to read, reason, research, and
answer: learn how the code actually behaves, think problems through, and give the user clear,
well-grounded answers. Nothing changes while you are in plan mode, and that guarantee is what
lets the user explore with you freely.

So do not change anything here. Built-in write and edit are held back, except Markdown plan
documents under ${PLAN_DOCUMENT_GLOB}. The bash tool runs read-only commands only: search and
inspect freely with rg, grep, find, git log, git diff, and the like, while commands that would
mutate files or state are blocked. Your read and search tools, the questionnaire, and every other
installed tool stay available. Read before you assert, and use the questionnaire tool when a
missing decision would change your answer.

If the user is simply asking or getting oriented, just answer well. You do not need a plan or a
todo list for that.

When the user wants a concrete change, plan mode is where you design it. Weigh the approaches and
their trade-offs, then record the plan by calling update_todos as an ordered list of concrete,
verifiable steps, each "pending". That todo list, not prose, is the durable plan. It carries into
execution and tracks progress there. Do not start implementing here: present the plan and let the
user leave plan mode to carry it out. You may also save a fuller write-up under ${PLAN_DOCUMENT_GLOB}.`;
}

function planReminder(): string {
	return `[PLAN MODE: read-only. Write and edit are held back except ${PLAN_DOCUMENT_GLOB}, and bash runs only read-only commands.]`;
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
				reason: `Plan mode is read-only, so this edit was not applied. Record the change as a step in your update_todos plan instead, and it will run once the user leaves plan mode. Only Markdown plan documents under ${PLAN_DOCUMENT_GLOB} can be written here.`,
			};
		}

		if (isToolCallEventType("bash", event)) {
			if (isReadOnlyCommand(event.input.command)) return;
			return {
				block: true,
				reason: "Plan mode runs read-only shell commands only (search, inspect, read). This command looks like it could change files or state, so it was not run. Use a read-only command, or record the change in your update_todos plan to run after leaving plan mode.",
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

		// Offer the execute handoff only when an actionable plan is waiting: at least one
		// step the model recorded but could not carry out, since writes are blocked in plan
		// mode. Pure exploration and question-answering use only reads, so those todos are
		// already completed and nothing is pending. In that case plan mode stays quiet
		// rather than asking the user to "execute" an answer.
		const pending = latestTodos(ctx).filter((todo) => todo.status !== "completed");
		if (pending.length === 0) return;

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
