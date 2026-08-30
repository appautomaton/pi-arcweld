/**
 * Machine-local alias file: ~/.pi/agent/delegate.json
 *
 * Read per call with an mtime cache so alias edits do not require /reload
 * and do not enter the parent tool schema.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { isRecord } from "./types.ts";

export type ModelRef = {
	provider: string;
	modelId: string;
	alias?: string;
};

type AliasCache = {
	path: string;
	mtimeMs: number;
	aliases: Map<string, string>;
};

let cache: AliasCache | undefined;

export function defaultAliasPath(): string {
	return join(getAgentDir(), "delegate.json");
}

export function parseModelRef(spec: string): ModelRef | undefined {
	const trimmed = spec.trim();
	const slash = trimmed.indexOf("/");
	if (slash <= 0 || slash === trimmed.length - 1) return undefined;
	return {
		provider: trimmed.slice(0, slash),
		modelId: trimmed.slice(slash + 1),
	};
}

export function parseAliasFile(text: string): Map<string, string> {
	const parsed: unknown = JSON.parse(text);
	if (!isRecord(parsed) || !isRecord(parsed.aliases)) {
		throw new Error('Alias file must be { "aliases": { "name": "provider/model", ... } }');
	}
	const aliases = new Map<string, string>();
	for (const [name, value] of Object.entries(parsed.aliases)) {
		if (typeof name !== "string" || name.length === 0 || typeof value !== "string" || !parseModelRef(value)) {
			throw new Error(`Invalid alias "${name}": expected "provider/model", got ${JSON.stringify(value)}`);
		}
		aliases.set(name, value);
	}
	return aliases;
}

export function loadAliases(path: string = defaultAliasPath()): Map<string, string> {
	if (!existsSync(path)) {
		if (cache?.path === path) cache = undefined;
		return new Map();
	}
	const mtimeMs = statSync(path).mtimeMs;
	if (cache && cache.path === path && cache.mtimeMs === mtimeMs) return cache.aliases;
	const aliases = parseAliasFile(readFileSync(path, "utf8"));
	cache = { path, mtimeMs, aliases };
	return aliases;
}

/** Test helper: drop the mtime cache. */
export function resetAliasCache(): void {
	cache = undefined;
}

export function formatKnownTargets(aliases: Map<string, string>, modelIds: readonly string[]): string {
	const aliasLines =
		aliases.size === 0
			? "  (none)"
			: [...aliases.entries()].map(([name, spec]) => `  ${name} → ${spec}`).join("\n");
	const idLines = modelIds.length === 0 ? "  (none listed)" : modelIds.map((id) => `  ${id}`).join("\n");
	return `Aliases:\n${aliasLines}\nConfigured models:\n${idLines}`;
}

export function resolveTarget(
	to: string,
	aliases: Map<string, string>,
): { ok: true; ref: ModelRef } | { ok: false; error: string } {
	const trimmed = to.trim();
	if (!trimmed) return { ok: false, error: 'Missing "to" (alias or provider/model id).' };

	const direct = parseModelRef(trimmed);
	if (direct) return { ok: true, ref: direct };

	const spec = aliases.get(trimmed);
	if (!spec) {
		return {
			ok: false,
			error: `Unknown delegate target "${trimmed}". Use an alias or provider/model id.`,
		};
	}
	const ref = parseModelRef(spec);
	if (!ref) {
		return { ok: false, error: `Alias "${trimmed}" does not resolve to provider/model.` };
	}
	return { ok: true, ref: { ...ref, alias: trimmed } };
}
