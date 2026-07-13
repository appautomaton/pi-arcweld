import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateHead,
} from "@earendil-works/pi-coding-agent";

export type PiContent = TextContent | ImageContent;

export interface OutputDetails {
	contentTypes: string[];
	truncation?: {
		fullOutputPath: string;
		outputBytes: number;
		totalBytes: number;
		outputLines: number;
		totalLines: number;
	};
}

export async function guardTextOutput(text: string): Promise<{ content: TextContent[]; details: Pick<OutputDetails, "truncation"> }> {
	const guarded = await guardText(text);
	return {
		content: guarded.text ? [{ type: "text", text: guarded.text }] : [],
		details: { truncation: guarded.truncation },
	};
}

export async function convertMcpResult(result: unknown): Promise<{ content: PiContent[]; details: OutputDetails }> {
	const record = object(result);
	const blocks = Array.isArray(record?.content) ? record.content : [];
	const content: PiContent[] = [];
	const text: string[] = [];
	const contentTypes: string[] = [];

	for (const block of blocks) {
		const item = object(block);
		const type = typeof item?.type === "string" ? item.type : "unknown";
		contentTypes.push(type);
		if (type === "text" && typeof item?.text === "string") {
			text.push(item.text);
		} else if (type === "image" && typeof item?.data === "string" && typeof item.mimeType === "string") {
			content.push({ type: "image", data: item.data, mimeType: item.mimeType.slice(0, 100) });
		} else if (type === "resource") {
			const resource = object(item?.resource);
			if (typeof resource?.text === "string") text.push(resource.text);
			else text.push(`[MCP resource: ${typeof resource?.uri === "string" ? resource.uri : "unknown"}]`);
		} else if (type === "resource_link") {
			text.push(`[MCP resource link: ${typeof item?.uri === "string" ? item.uri : "unknown"}]`);
		} else if (type === "audio") {
			text.push(`[MCP audio: ${typeof item?.mimeType === "string" ? item.mimeType : "unknown"}]`);
		} else {
			text.push(`[Unsupported MCP content block: ${type}]`);
		}
	}

	if (text.length === 0 && content.length === 0 && record?.structuredContent !== undefined) {
		text.push(JSON.stringify(record.structuredContent, null, 2));
		contentTypes.push("structuredContent");
	}
	if (text.length === 0 && content.length === 0) text.push("(empty MCP result)");

	const guarded = await guardText(text.join("\n"));
	if (guarded.text) content.unshift({ type: "text", text: guarded.text });
	return {
		content,
		details: {
			contentTypes: [...new Set(contentTypes)],
			truncation: guarded.truncation,
		},
	};
}

async function guardText(text: string): Promise<{ text: string; truncation?: OutputDetails["truncation"] }> {
	const result = truncateHead(text, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
	if (!result.truncated) return { text: result.content };

	const directory = await mkdtemp(join(tmpdir(), "pi-mcp-output-"));
	const fullOutputPath = join(directory, "result.txt");
	await writeFile(fullOutputPath, text, { encoding: "utf8", mode: 0o600 });
	const notice = `[MCP output truncated: showing ${result.outputLines} of ${result.totalLines} lines (${formatSize(result.outputBytes)} of ${formatSize(result.totalBytes)}). Full output saved to: ${fullOutputPath}]`;
	return {
		text: `${result.content}\n\n${notice}`,
		truncation: {
			fullOutputPath,
			outputBytes: result.outputBytes,
			totalBytes: result.totalBytes,
			outputLines: result.outputLines,
			totalLines: result.totalLines,
		},
	};
}

function object(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined;
}
