import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { McpManager } from "./manager.js";

export const CAPABILITY_SNAPSHOT_MESSAGE_TYPE = "mcp-capability-snapshot";
export const RUNTIME_UPDATE_MESSAGE_TYPE = "mcp-runtime-update";
const SESSION_STATE_ENTRY_TYPE = "mcp-session-snapshot";

export interface ReportedRuntime {
	sessionEnabled: boolean;
	fingerprint?: string;
}

export interface McpSessionState {
	summary: string;
	runtime: Record<string, ReportedRuntime>;
}

export function restoreSessionState(ctx: ExtensionContext): McpSessionState | undefined {
	let restored: McpSessionState | undefined;
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "custom" || entry.customType !== SESSION_STATE_ENTRY_TYPE) continue;
		const state = parseSessionState(entry.data);
		if (state) restored = state;
	}
	return restored;
}

export function persistSessionState(pi: ExtensionAPI, summary: string, runtime: Record<string, ReportedRuntime>): void {
	pi.appendEntry<McpSessionState>(SESSION_STATE_ENTRY_TYPE, {
		summary,
		runtime: cloneRuntime(runtime),
	});
}

export function activeContextHasCapabilitySnapshot(ctx: ExtensionContext, summary: string): boolean {
	if (!summary) return true;
	return ctx.sessionManager.buildContextEntries().some((entry) => isCapabilitySnapshot(entry, summary));
}

export function capabilitySnapshotMessage(summary: string) {
	return {
		customType: CAPABILITY_SNAPSHOT_MESSAGE_TYPE,
		content: summary,
		display: false,
	};
}

export function runtimeUpdateMessage(content: string) {
	return {
		customType: RUNTIME_UPDATE_MESSAGE_TYPE,
		content,
		display: false,
	};
}

export function snapshotRuntime(manager: McpManager): Record<string, ReportedRuntime> {
	const fingerprints = manager.catalogFingerprints();
	return Object.fromEntries(manager.status().map((status) => [status.name, {
		sessionEnabled: status.sessionEnabled,
		fingerprint: fingerprints[status.name]?.signature,
	}]));
}

export function collectRuntimeUpdate(manager: McpManager, reported: Record<string, ReportedRuntime>): string | undefined {
	const notes: string[] = [];
	const fingerprints = manager.catalogFingerprints();
	for (const status of manager.status()) {
		const previous = reported[status.name] ?? { sessionEnabled: status.sessionEnabled };
		if (previous.sessionEnabled !== status.sessionEnabled) {
			notes.push(status.sessionEnabled
				? `${status.name} is enabled for this session; its catalog may still be loading.`
				: `${status.name} is disabled for this session; calls will fail until the user enables it.`);
			previous.sessionEnabled = status.sessionEnabled;
		}
		const fingerprint = fingerprints[status.name];
		if (fingerprint?.ready && fingerprint.signature && fingerprint.signature !== previous.fingerprint) {
			notes.push(`${status.name}'s catalog changed; ${fingerprint.toolCount} tools are currently available.`);
			previous.fingerprint = fingerprint.signature;
		}
		reported[status.name] = previous;
	}
	if (notes.length === 0) return undefined;
	return `MCP runtime update (authoritative after the capability snapshot):\n${notes.map((note) => `- ${note}`).join("\n")}\nUse mcp status, search, list, or describe for current details.`;
}

function isCapabilitySnapshot(entry: SessionEntry, summary: string): boolean {
	return entry.type === "custom_message"
		&& entry.customType === CAPABILITY_SNAPSHOT_MESSAGE_TYPE
		&& entry.content === summary;
}

function parseSessionState(value: unknown): McpSessionState | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const candidate = value as { summary?: unknown; runtime?: unknown };
	if (typeof candidate.summary !== "string" || !candidate.runtime || typeof candidate.runtime !== "object" || Array.isArray(candidate.runtime)) return undefined;
	const runtime: Record<string, ReportedRuntime> = {};
	for (const [name, item] of Object.entries(candidate.runtime)) {
		if (!item || typeof item !== "object" || Array.isArray(item)) return undefined;
		const state = item as { sessionEnabled?: unknown; fingerprint?: unknown };
		if (typeof state.sessionEnabled !== "boolean") return undefined;
		if (state.fingerprint !== undefined && typeof state.fingerprint !== "string") return undefined;
		runtime[name] = {
			sessionEnabled: state.sessionEnabled,
			...(state.fingerprint === undefined ? {} : { fingerprint: state.fingerprint }),
		};
	}
	return { summary: candidate.summary, runtime };
}

function cloneRuntime(runtime: Record<string, ReportedRuntime>): Record<string, ReportedRuntime> {
	return Object.fromEntries(Object.entries(runtime).map(([name, state]) => [name, { ...state }]));
}
