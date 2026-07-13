import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component, type TUI } from "@earendil-works/pi-tui";
import type { ServerStatus } from "./manager.js";

export interface McpPanelActions {
	enable(server: string): Promise<void>;
	disable(server: string): Promise<void>;
	reconnect(server: string): Promise<void>;
	setDefault(server: string, enabled: boolean): Promise<void>;
}

export interface McpPanelRegistration {
	setRefresh(refresh: (() => void) | undefined): void;
}

export async function openMcpControlPanel(
	ctx: ExtensionCommandContext,
	configPath: string,
	getStatuses: () => ServerStatus[],
	actions: McpPanelActions,
	registration: McpPanelRegistration,
): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("/mcp requires TUI mode. Use /mcp status for a text report.", "error");
		return;
	}
	try {
		await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
			const panel = new McpControlPanel(tui, theme, done, configPath, getStatuses, actions);
			registration.setRefresh(() => panel.refresh());
			return panel;
		});
	} finally {
		registration.setRefresh(undefined);
	}
}

export class McpControlPanel implements Component {
	private selected = 0;
	private busy = false;
	private confirmingDefault: { server: string; enabled: boolean } | undefined;
	private notice: { text: string; type: "info" | "error" } | undefined;
	private disposed = false;

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly done: () => void,
		private readonly configPath: string,
		private readonly getStatuses: () => ServerStatus[],
		private readonly actions: McpPanelActions,
	) {}

	refresh(): void {
		if (!this.disposed) this.tui.requestRender();
	}

	dispose(): void {
		this.disposed = true;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const statuses = this.getStatuses();
		this.selected = statuses.length === 0 ? 0 : Math.min(this.selected, statuses.length - 1);
		return renderMcpPanel(width, this.theme, statuses, this.selected, this.configPath, {
			busy: this.busy,
			confirmingDefault: this.confirmingDefault,
			notice: this.notice,
		});
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
			if (this.confirmingDefault) {
				this.confirmingDefault = undefined;
				this.notice = undefined;
				this.refresh();
				return;
			}
			this.done();
			return;
		}

		if (this.busy) return;
		const statuses = this.getStatuses();
		if (statuses.length === 0) return;
		this.selected = Math.min(this.selected, statuses.length - 1);
		const selected = statuses[this.selected];

		if (this.confirmingDefault) {
			if (matchesKey(data, "n")) {
				this.confirmingDefault = undefined;
				this.notice = undefined;
				this.refresh();
			} else if (matchesKey(data, "y")) {
				const pending = this.confirmingDefault;
				this.confirmingDefault = undefined;
				void this.run(`Saving default for ${pending.server}…`, () => this.actions.setDefault(pending.server, pending.enabled),
					`Default for ${pending.server} is now ${pending.enabled ? "enabled" : "disabled"}`);
			}
			return;
		}

		if (matchesKey(data, Key.up)) {
			this.selected = (this.selected - 1 + statuses.length) % statuses.length;
			this.notice = undefined;
			this.refresh();
			return;
		}
		if (matchesKey(data, Key.down)) {
			this.selected = (this.selected + 1) % statuses.length;
			this.notice = undefined;
			this.refresh();
			return;
		}
		if (matchesKey(data, Key.enter) || matchesKey(data, Key.space)) {
			if (selected.sessionEnabled) {
				void this.run(`Disabling ${selected.name}…`, () => this.actions.disable(selected.name), `${selected.name} is disabled for this session`);
			} else {
				void this.run(`Enabling ${selected.name}…`, () => this.actions.enable(selected.name), `${selected.name} is enabled for this session`);
			}
			return;
		}
		if (matchesKey(data, "r")) {
			if (!selected.sessionEnabled) {
				this.notice = { text: "Enable this server for the session before reconnecting", type: "error" };
				this.refresh();
				return;
			}
			void this.run(`Reconnecting ${selected.name}…`, () => this.actions.reconnect(selected.name), `${selected.name} reconnected`);
			return;
		}
		if (matchesKey(data, "d")) {
			this.confirmingDefault = { server: selected.name, enabled: !selected.configuredEnabled };
			this.notice = undefined;
			this.refresh();
		}
	}

	private async run(pendingText: string, action: () => Promise<void>, successText: string): Promise<void> {
		this.busy = true;
		this.notice = { text: pendingText, type: "info" };
		this.refresh();
		try {
			await action();
			this.notice = { text: successText, type: "info" };
		} catch (error) {
			this.notice = { text: sanitizeTerminalText(error instanceof Error ? error.message : String(error)), type: "error" };
		} finally {
			this.busy = false;
			this.refresh();
		}
	}
}

interface PanelViewState {
	busy: boolean;
	confirmingDefault?: { server: string; enabled: boolean };
	notice?: { text: string; type: "info" | "error" };
}

export function renderMcpPanel(
	width: number,
	theme: Theme,
	statuses: ServerStatus[],
	selected: number,
	configPath: string,
	view: PanelViewState,
): string[] {
	const contentWidth = Math.max(1, width);
	const lines: string[] = [];
	lines.push(theme.fg("border", "─".repeat(contentWidth)));
	lines.push(headerLine(contentWidth, theme, statuses));
	lines.push(theme.fg("dim", truncateToWidth(configPath, contentWidth)));
	lines.push("");

	if (statuses.length === 0) {
		lines.push(theme.fg("muted", "No MCP servers configured."));
		lines.push(theme.fg("dim", "Add servers to mcp.json, then reload Pi."));
	} else {
		const maxVisible = Math.min(10, statuses.length);
		const start = Math.max(0, Math.min(selected - Math.floor(maxVisible / 2), statuses.length - maxVisible));
		const end = start + maxVisible;
		for (let index = start; index < end; index++) {
			lines.push(serverRow(contentWidth, theme, statuses[index], index === selected));
		}
		if (statuses.length > maxVisible) lines.push(theme.fg("dim", `Showing ${start + 1}-${end} of ${statuses.length} servers`));
		lines.push("");
		lines.push(...serverDetails(contentWidth, theme, statuses[Math.min(selected, statuses.length - 1)]));
	}

	if (view.confirmingDefault) {
		lines.push("");
		const action = view.confirmingDefault.enabled ? "enabled" : "disabled";
		lines.push(theme.fg("warning", theme.bold(`Change the future-session default for ${view.confirmingDefault.server} to ${action}?`)));
		lines.push(theme.fg("muted", truncateToWidth(`This writes only the enabled setting in ${configPath}.`, contentWidth)));
		lines.push(theme.fg("muted", "It does not change the current session. MCP secret placeholders stay untouched."));
		lines.push(theme.fg("dim", "y confirm · n/esc cancel"));
	} else {
		if (view.notice) {
			lines.push("");
			lines.push(theme.fg(view.notice.type === "error" ? "error" : "accent", truncateToWidth(view.notice.text, contentWidth)));
		}
		lines.push("");
		lines.push(theme.fg("dim", view.busy
			? "operation in progress · esc close"
			: "enter/space enable or disable · r reconnect · d change default"));
		lines.push(theme.fg("dim", "↑↓ navigate · esc close"));
	}
	lines.push(theme.fg("border", "─".repeat(contentWidth)));
	return lines.flatMap((line) => wrapTextWithAnsi(line, contentWidth));
}

function headerLine(width: number, theme: Theme, statuses: ServerStatus[]): string {
	const ready = statuses.filter((status) => status.sessionEnabled && status.status === "ready").length;
	const off = statuses.filter((status) => !status.sessionEnabled).length;
	const errors = statuses.filter((status) => status.sessionEnabled && status.status === "error").length;
	const connecting = statuses.filter((status) => status.sessionEnabled && status.status === "connecting").length;
	const unavailable = statuses.filter((status) => status.sessionEnabled && (status.status === "configured" || status.status === "disconnected")).length;
	const counts = [ready ? `${ready} ready` : "", connecting ? `${connecting} connecting` : "", unavailable ? `${unavailable} unavailable` : "", off ? `${off} off` : "", errors ? `${errors} error` : ""]
		.filter(Boolean).join(" · ") || "no servers";
	const left = theme.fg("accent", theme.bold("MCP Servers"));
	const right = theme.fg(errors ? "error" : "muted", counts);
	const spaces = Math.max(1, width - visibleWidth(left) - visibleWidth(right));
	return `${left}${" ".repeat(spaces)}${right}`;
}

function serverRow(width: number, theme: Theme, status: ServerStatus, selected: boolean): string {
	const state = effectiveState(status);
	const prefix = theme.fg(selected ? "accent" : "muted", selected ? "→ " : "  ");
	const marker = theme.fg(state.color, `${state.marker} `);
	const compact = width < 70;
	const nameWidth = compact ? Math.max(8, width - 20) : Math.min(24, Math.max(12, Math.floor(width * 0.28)));
	const name = truncateToWidth(status.name, nameWidth, "…", true);
	const stateText = truncateToWidth(state.label, 13, "…", true);
	let row = `${prefix}${marker}${selected ? theme.fg("accent", theme.bold(name)) : theme.fg("text", name)} ${theme.fg(state.color, stateText)}`;
	if (!compact) {
		const tools = status.status === "ready" && status.sessionEnabled ? `${status.toolCount} tools` : "—";
		const current = status.sessionEnabled ? "session on" : "session off";
		const defaultText = status.configuredEnabled ? "default on" : "default off";
		row += ` ${theme.fg("muted", truncateToWidth(tools, 10, "…", true))} ${theme.fg("muted", truncateToWidth(current, 12, "…", true))} ${theme.fg("dim", defaultText)}`;
	}
	return truncateToWidth(row, width);
}

function serverDetails(width: number, theme: Theme, status: ServerStatus): string[] {
	const transport = status.transport === "stdio" ? "Stdio" : "Streamable HTTP";
	const lines = [
		theme.fg("accent", theme.bold(status.name)),
		theme.fg("muted", `${transport} · ${status.target}`),
		`${theme.fg("muted", "Current session: ")}${theme.fg(status.sessionEnabled ? "success" : "warning", status.sessionEnabled ? "enabled" : "disabled")}`,
		`${theme.fg("muted", "Default for future sessions: ")}${theme.fg(status.configuredEnabled ? "success" : "warning", status.configuredEnabled ? "enabled" : "disabled")}`,
	];
	if (status.serverName) lines.push(theme.fg("muted", `Server: ${status.serverName}${status.serverVersion ? ` ${status.serverVersion}` : ""}`));
	if (status.sessionEnabled && status.status === "ready") lines.push(theme.fg("success", `${status.toolCount} tools available`));
	else if (!status.sessionEnabled) lines.push(theme.fg("muted", "No connection is running."));
	else lines.push(theme.fg(effectiveState(status).color, effectiveState(status).detail));
	if (status.lastError) lines.push(theme.fg("error", truncateToWidth(`Last error: ${sanitizeTerminalText(status.lastError)}`, width)));
	return lines;
}

function sanitizeTerminalText(value: string): string {
	return value
		.replace(/\u001B(?:\[[0-?]*[ -/]*[@-~]|[@-_])/g, "")
		.replace(/[\u0000-\u001F\u007F-\u009F]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function effectiveState(status: ServerStatus): { label: string; marker: string; color: "success" | "accent" | "warning" | "error" | "muted"; detail: string } {
	if (!status.sessionEnabled) return { label: "OFF", marker: "○", color: "muted", detail: "Disabled for this session." };
	switch (status.status) {
		case "ready": return { label: "READY", marker: "●", color: "success", detail: "Connected and ready." };
		case "connecting": return { label: "CONNECTING", marker: "◌", color: "accent", detail: "Connecting and loading the catalog…" };
		case "error": return { label: "ERROR", marker: "!", color: "error", detail: "Connection failed." };
		case "disconnected": return { label: "DISCONNECTED", marker: "○", color: "warning", detail: "Connection closed; the next operation may reconnect it." };
		case "configured": return { label: "CONFIGURED", marker: "○", color: "muted", detail: "Configured and waiting to connect." };
	}
}
