const MARKER_PREFIX = "pi-arcweld:claude-web-search:v1:";
const MAX_MARKER_JSON_BYTES = 16 * 1024 * 1024;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

export interface ServerToolUseReplayBlock {
	type: "server_tool_use";
	id: string;
	name: "web_search";
	input: unknown;
	caller?: unknown;
	[key: string]: unknown;
}

export interface WebSearchResultReplayBlock {
	type: "web_search_result";
	encrypted_content: string;
	title: string;
	url: string;
	page_age?: string | null;
	[key: string]: unknown;
}

export interface WebSearchResultErrorReplayBlock {
	type: "web_search_tool_result_error";
	error_code: string;
	[key: string]: unknown;
}

export interface WebSearchToolResultReplayBlock {
	type: "web_search_tool_result";
	tool_use_id: string;
	content: WebSearchResultReplayBlock[] | WebSearchResultErrorReplayBlock;
	caller?: unknown;
	[key: string]: unknown;
}

export type ReplayableServerBlock = ServerToolUseReplayBlock | WebSearchToolResultReplayBlock;

interface ServerBlockMarkerEnvelope {
	version: 1;
	kind: "server_block";
	block: ReplayableServerBlock;
}

interface PauseBoundaryMarkerEnvelope {
	version: 1;
	kind: "pause_boundary";
}

type ReplayMarkerEnvelope = ServerBlockMarkerEnvelope | PauseBoundaryMarkerEnvelope;

export type DecodedReplayMarker =
	| { kind: "server_block"; block: ReplayableServerBlock }
	| { kind: "pause_boundary" };

export class ReplayMarkerError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ReplayMarkerError";
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(record: Record<string, unknown>, key: string, context: string): string {
	const value = record[key];
	if (typeof value !== "string" || value.length === 0) {
		throw new ReplayMarkerError(`${context}.${key} must be a non-empty string`);
	}
	return value;
}

function validateCaller(value: unknown, context: string): void {
	if (value !== undefined && !isRecord(value)) {
		throw new ReplayMarkerError(`${context}.caller must be an object when present`);
	}
}

function validateWebSearchResult(value: unknown, index: number): asserts value is WebSearchResultReplayBlock {
	if (!isRecord(value) || value.type !== "web_search_result") {
		throw new ReplayMarkerError(`web_search_tool_result.content[${index}] must be a web_search_result block`);
	}
	requireString(value, "encrypted_content", `web_search_tool_result.content[${index}]`);
	requireString(value, "title", `web_search_tool_result.content[${index}]`);
	requireString(value, "url", `web_search_tool_result.content[${index}]`);
	if (value.page_age !== undefined && value.page_age !== null && typeof value.page_age !== "string") {
		throw new ReplayMarkerError(`web_search_tool_result.content[${index}].page_age must be a string or null`);
	}
}

function validateWebSearchResultError(value: unknown): asserts value is WebSearchResultErrorReplayBlock {
	if (!isRecord(value) || value.type !== "web_search_tool_result_error") {
		throw new ReplayMarkerError(
			"web_search_tool_result.content must be an array of results or a web_search_tool_result_error block",
		);
	}
	requireString(value, "error_code", "web_search_tool_result.content");
}

export function validateReplayableServerBlock(value: unknown): asserts value is ReplayableServerBlock {
	if (!isRecord(value)) {
		throw new ReplayMarkerError("Replay server block must be an object");
	}

	if (value.type === "server_tool_use") {
		requireString(value, "id", "server_tool_use");
		if (value.name !== "web_search") {
			throw new ReplayMarkerError("Only Anthropic web_search server_tool_use blocks are supported");
		}
		if (!("input" in value)) {
			throw new ReplayMarkerError("server_tool_use.input is required");
		}
		validateCaller(value.caller, "server_tool_use");
		return;
	}

	if (value.type === "web_search_tool_result") {
		requireString(value, "tool_use_id", "web_search_tool_result");
		validateCaller(value.caller, "web_search_tool_result");
		if (Array.isArray(value.content)) {
			for (let index = 0; index < value.content.length; index++) {
				validateWebSearchResult(value.content[index], index);
			}
		} else {
			validateWebSearchResultError(value.content);
		}
		return;
	}

	throw new ReplayMarkerError("Unsupported Anthropic replay block type");
}

function encodeEnvelope(envelope: ReplayMarkerEnvelope): string {
	const json = JSON.stringify(envelope);
	const bytes = Buffer.byteLength(json, "utf8");
	if (bytes > MAX_MARKER_JSON_BYTES) {
		throw new ReplayMarkerError(`Replay marker payload exceeds ${MAX_MARKER_JSON_BYTES} bytes`);
	}
	return `${MARKER_PREFIX}${Buffer.from(json, "utf8").toString("base64url")}`;
}

export function encodeServerBlockMarker(block: unknown): string {
	validateReplayableServerBlock(block);
	return encodeEnvelope({ version: 1, kind: "server_block", block });
}

export function encodePauseBoundaryMarker(): string {
	return encodeEnvelope({ version: 1, kind: "pause_boundary" });
}

export function isReplayMarkerSignature(value: unknown): value is string {
	return typeof value === "string" && value.startsWith(MARKER_PREFIX);
}

export function decodeReplayMarker(signature: unknown): DecodedReplayMarker | undefined {
	if (!isReplayMarkerSignature(signature)) return undefined;

	const encoded = signature.slice(MARKER_PREFIX.length);
	if (!encoded || !BASE64URL_PATTERN.test(encoded)) {
		throw new ReplayMarkerError("Replay marker contains invalid base64url data");
	}

	let json: string;
	try {
		const decoded = Buffer.from(encoded, "base64url");
		if (decoded.byteLength > MAX_MARKER_JSON_BYTES) {
			throw new ReplayMarkerError(`Replay marker payload exceeds ${MAX_MARKER_JSON_BYTES} bytes`);
		}
		json = decoded.toString("utf8");
	} catch (error) {
		if (error instanceof ReplayMarkerError) throw error;
		throw new ReplayMarkerError(`Could not decode replay marker: ${error instanceof Error ? error.message : String(error)}`);
	}

	let envelope: unknown;
	try {
		envelope = JSON.parse(json);
	} catch (error) {
		throw new ReplayMarkerError(`Replay marker is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
	}

	if (!isRecord(envelope) || envelope.version !== 1) {
		throw new ReplayMarkerError("Replay marker has an unsupported version");
	}
	if (envelope.kind === "pause_boundary") {
		return { kind: "pause_boundary" };
	}
	if (envelope.kind === "server_block") {
		validateReplayableServerBlock(envelope.block);
		return { kind: "server_block", block: envelope.block };
	}
	throw new ReplayMarkerError("Replay marker has an unsupported kind");
}
