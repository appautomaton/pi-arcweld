import { chmod, readFile, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { getAgentDir, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { parseEnv } from "node:util";

const ROOT_FIELDS = new Set(["servers"]);
const STDIO_FIELDS = new Set(["enabled", "transport", "command", "args", "env", "cwd"]);
const HTTP_FIELDS = new Set(["enabled", "transport", "url", "headers"]);
const SERVER_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;
const ENV_REFERENCE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

interface BaseServerConfig {
	enabled: boolean;
}

export interface StdioServerConfig extends BaseServerConfig {
	transport: "stdio";
	command: string;
	args: string[];
	env: Record<string, string>;
	cwd?: string;
}

export interface HttpServerConfig extends BaseServerConfig {
	transport: "streamable-http";
	url: string;
	headers: Record<string, string>;
}

export type McpServerConfig = StdioServerConfig | HttpServerConfig;

export interface McpConfig {
	path: string;
	servers: Record<string, McpServerConfig>;
}

export function getConfigPath(): string {
	return join(getAgentDir(), "mcp.json");
}

let temporaryFileCounter = 0;

/**
 * Updates only one server's raw enabled default. The normalized config is never
 * serialized because it contains secrets expanded from mcp.env.
 */
export function setServerDefaultEnabled(path: string, serverName: string, enabled: boolean): Promise<void> {
	return withFileMutationQueue(path, async () => {
		const targetPath = await realpath(path);
		const before = await stat(targetPath);
		const text = await readFile(targetPath, "utf8");
		let raw: unknown;
		try {
			raw = JSON.parse(text);
		} catch (error) {
			throw new Error(`Could not read MCP config at ${path}: ${error instanceof Error ? error.message : String(error)}`);
		}
		const variables = await loadVariables(join(dirname(path), "mcp.env"));
		parseConfig(raw, variables, path);
		const root = object(raw, "config");
		const servers = object(root.servers, "servers");
		if (!(serverName in servers)) throw new Error(`Unknown MCP server: ${serverName}`);
		const server = object(servers[serverName], `servers.${serverName}`);
		if (enabled) delete server.enabled;
		else server.enabled = false;

		const current = await stat(targetPath);
		if (!sameFileVersion(before, current)) throw new Error(`MCP config changed while saving ${serverName}. Retry the operation.`);

		const temporaryPath = join(dirname(targetPath), `.${basename(targetPath)}.tmp-${process.pid}-${++temporaryFileCounter}`);
		try {
			const mode = before.mode & 0o777;
			await writeFile(temporaryPath, `${JSON.stringify(raw, null, 2)}\n`, { mode, flag: "wx" });
			await chmod(temporaryPath, mode);
			const latest = await stat(targetPath);
			if (!sameFileVersion(before, latest)) throw new Error(`MCP config changed while saving ${serverName}. Retry the operation.`);
			await rename(temporaryPath, targetPath);
		} catch (error) {
			await unlink(temporaryPath).catch(() => {});
			throw error;
		}
	});
}

export async function loadConfig(path = getConfigPath()): Promise<McpConfig> {
	let raw: unknown;
	try {
		raw = JSON.parse(await readFile(path, "utf8"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { path, servers: {} };
		throw new Error(`Could not read MCP config at ${path}: ${error instanceof Error ? error.message : String(error)}`);
	}

	const variables = await loadVariables(join(dirname(path), "mcp.env"));
	return parseConfig(raw, variables, path);
}

function parseConfig(raw: unknown, variables: Record<string, string>, path: string): McpConfig {
	const root = object(raw, "config");
	rejectUnknown(root, ROOT_FIELDS, "config");
	const rawServers = root.servers === undefined ? {} : object(root.servers, "servers");
	const servers: Record<string, McpServerConfig> = {};

	for (const [name, value] of Object.entries(rawServers)) {
		if (!SERVER_NAME.test(name)) throw new Error(`Invalid MCP server name: ${name}`);
		servers[name] = parseServer(name, value, variables);
	}
	return { path, servers };
}

async function loadVariables(path: string): Promise<Record<string, string>> {
	try {
		return Object.fromEntries(Object.entries(parseEnv(await readFile(path, "utf8"))).filter((entry): entry is [string, string] => entry[1] !== undefined));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
		throw new Error(`Could not read MCP environment at ${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function parseServer(name: string, value: unknown, variables: Record<string, string>): McpServerConfig {
	const server = object(value, `servers.${name}`);
	rejectUnknown(server, new Set([...STDIO_FIELDS, ...HTTP_FIELDS]), `servers.${name}`);
	const transport = string(server.transport, `servers.${name}.transport`);
	const enabled = optionalBoolean(server.enabled, `servers.${name}.enabled`) ?? true;

	if (transport === "stdio") {
		rejectUnknown(server, STDIO_FIELDS, `servers.${name}`);
		const command = string(server.command, `servers.${name}.command`);
		if (!isAbsolute(command)) throw new Error(`servers.${name}.command must be an absolute path`);
		const args = stringArray(server.args, `servers.${name}.args`);
		const env = resolveRecord(server.env, `servers.${name}.env`, variables);
		const cwd = server.cwd === undefined ? undefined : string(server.cwd, `servers.${name}.cwd`);
		if (cwd !== undefined && !isAbsolute(cwd)) throw new Error(`servers.${name}.cwd must resolve to an absolute path`);
		return { enabled, transport, command, args, env, cwd };
	}

	if (transport === "streamable-http") {
		rejectUnknown(server, HTTP_FIELDS, `servers.${name}`);
		const url = string(server.url, `servers.${name}.url`);
		let parsed: URL;
		try {
			parsed = new URL(url);
		} catch {
			throw new Error(`servers.${name}.url must be a valid URL`);
		}
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
			throw new Error(`servers.${name}.url must use http or https`);
		}
		return { enabled, transport, url: parsed.toString(), headers: resolveRecord(server.headers, `servers.${name}.headers`, variables) };
	}

	throw new Error(`servers.${name}.transport must be "stdio" or "streamable-http"`);
}

function resolveRecord(value: unknown, path: string, variables: Record<string, string>): Record<string, string> {
	if (value === undefined) return {};
	const record = object(value, path);
	return Object.fromEntries(Object.entries(record).map(([key, item]) => [key, interpolate(string(item, `${path}.${key}`), `${path}.${key}`, variables)]));
}

function interpolate(value: string, path: string, variables: Record<string, string>): string {
	return value.replace(ENV_REFERENCE, (_match, name: string) => {
		const resolved = variables[name];
		if (resolved === undefined) throw new Error(`${path} references missing MCP environment variable ${name}`);
		return resolved;
	});
}

function object(value: unknown, path: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} must be an object`);
	return value as Record<string, unknown>;
}

function string(value: unknown, path: string): string {
	if (typeof value !== "string" || value.length === 0) throw new Error(`${path} must be a non-empty string`);
	return value;
}

function optionalBoolean(value: unknown, path: string): boolean | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "boolean") throw new Error(`${path} must be a boolean`);
	return value;
}

function sameFileVersion(left: Awaited<ReturnType<typeof stat>>, right: Awaited<ReturnType<typeof stat>>): boolean {
	return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs;
}

function stringArray(value: unknown, path: string): string[] {
	if (value === undefined) return [];
	if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) throw new Error(`${path} must be an array of strings`);
	return value;
}

function rejectUnknown(value: Record<string, unknown>, allowed: Set<string>, path: string): void {
	for (const key of Object.keys(value)) {
		if (!allowed.has(key)) throw new Error(`Unknown field ${path}.${key}`);
	}
}
