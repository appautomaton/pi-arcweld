/** Pure utility functions for plan mode. */

export interface TodoItem {
	step: number;
	text: string;
	completed: boolean;
}

export function cleanStepText(text: string): string {
	let cleaned = text
		.replace(/\*{1,2}([^*]+)\*{1,2}/g, "$1")
		.replace(/`([^`]+)`/g, "$1")
		.replace(
			/^(Use|Run|Execute|Create|Write|Read|Check|Verify|Update|Modify|Add|Remove|Delete|Install)\s+(the\s+)?/i,
			"",
		)
		.replace(/\s+/g, " ")
		.trim();

	if (cleaned.length > 0) {
		cleaned = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
	}
	if (cleaned.length > 50) {
		cleaned = `${cleaned.slice(0, 47)}...`;
	}
	return cleaned;
}

export function extractTodoItems(message: string): TodoItem[] {
	const headerMatch = message.match(/\*{0,2}Plan:\*{0,2}\s*\r?\n/i);
	if (!headerMatch || headerMatch.index === undefined) return [];

	const items: TodoItem[] = [];
	const lines = message.slice(headerMatch.index + headerMatch[0].length).split(/\r?\n/);
	let expectedStep = 1;
	let foundStep = false;

	for (const line of lines) {
		if (!line.trim()) continue;
		if (/^\s{0,3}#{1,6}\s/.test(line)) break;

		const match = line.match(/^\s*(\d+)[.)]\s+(.+)$/);
		if (!match) {
			if (foundStep) break;
			continue;
		}

		const step = Number(match[1]);
		if (!Number.isSafeInteger(step) || step !== expectedStep) break;

		const text = match[2].trim();
		if (text.length <= 5 || text.startsWith("`") || text.startsWith("/") || text.startsWith("-")) break;

		const cleaned = cleanStepText(text);
		if (cleaned.length <= 3) break;

		items.push({ step, text: cleaned, completed: false });
		foundStep = true;
		expectedStep++;
	}

	return items;
}

export function extractDoneSteps(message: string): number[] {
	const steps: number[] = [];
	for (const match of message.matchAll(/\[DONE:(\d+)\]/gi)) {
		const step = Number(match[1]);
		if (Number.isSafeInteger(step)) steps.push(step);
	}
	return steps;
}

/** Marks only newly completed steps and returns that count. */
export function markCompletedSteps(text: string, items: TodoItem[]): number {
	let marked = 0;
	for (const step of extractDoneSteps(text)) {
		const item = items.find((todo) => todo.step === step);
		if (item && !item.completed) {
			item.completed = true;
			marked++;
		}
	}
	return marked;
}
