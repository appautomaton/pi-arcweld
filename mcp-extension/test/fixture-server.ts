import { appendFile, writeFile } from "node:fs/promises";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

if (process.env.FIXTURE_PID_FILE) await writeFile(process.env.FIXTURE_PID_FILE, String(process.pid), "utf8");
if (process.env.FIXTURE_START_COUNT_FILE) await appendFile(process.env.FIXTURE_START_COUNT_FILE, "start\n", "utf8");
if (process.env.FIXTURE_START_DELAY_MS) await new Promise((resolve) => setTimeout(resolve, Number(process.env.FIXTURE_START_DELAY_MS)));

const server = new Server(
	{ name: "pi-mcp-fixture", version: "1.0.0" },
	{
		capabilities: { tools: { listChanged: true } },
		instructions: process.env.FIXTURE_INSTRUCTIONS ?? "Use these tools for deterministic fixture testing.",
	},
);

const inputSchema = { type: "object" as const, properties: {}, required: [] as string[] };
const tools = [
	{ name: "echo", description: "Echo text", inputSchema: { type: "object" as const, properties: { text: { type: "string" } }, required: ["text"] } },
	{ name: "environment", description: "Return selected environment variables", inputSchema },
	{ name: "structured", description: "Return structured content", inputSchema },
	{ name: "image", description: "Return a tiny PNG image", inputSchema },
	{ name: "large", description: "Return oversized output", inputSchema },
	{ name: "fail", description: "Return an MCP tool error", inputSchema },
	{ name: "slow", description: "Wait until cancelled", inputSchema },
	{ name: "add_tool", description: "Add a tool and emit list_changed", inputSchema },
];

server.setRequestHandler(ListToolsRequestSchema, async (request) => {
	const offset = request.params?.cursor ? Number(request.params.cursor) : 0;
	if (process.env.FIXTURE_INFINITE_PAGES === "1") return { tools: [], nextCursor: String(offset + 1) };
	return { tools: tools.slice(offset, offset + 2), nextCursor: offset + 2 < tools.length ? String(offset + 2) : undefined };
});

server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
	const { name, arguments: args } = request.params;
	if (name === "echo") return { content: [{ type: "text", text: String(args?.text ?? "") }] };
	if (name === "environment") {
		return { content: [{ type: "text", text: JSON.stringify({ path: process.env.PATH, home: process.env.HOME, secret: process.env.SHOULD_NOT_LEAK, explicit: process.env.EXPLICIT_TEST_ENV }) }] };
	}
	if (name === "structured") return { content: [], structuredContent: { ok: true, count: 2 } };
	if (name === "image") return { content: [{ type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" }] };
	if (name === "large") return { content: [{ type: "text", text: "x".repeat(60_000) }] };
	if (name === "fail") return { content: [{ type: "text", text: "fixture failure" }], isError: true };
	if (name === "slow") {
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(resolve, 60_000);
			extra.signal.addEventListener("abort", () => {
				clearTimeout(timer);
				reject(new Error("cancelled"));
			}, { once: true });
		});
		return { content: [{ type: "text", text: "done" }] };
	}
	if (name === "add_tool") {
		if (!tools.some((tool) => tool.name === "added")) tools.push({ name: "added", description: "Dynamically added tool", inputSchema });
		await server.sendToolListChanged();
		return { content: [{ type: "text", text: "added" }] };
	}
	if (name === "added") return { content: [{ type: "text", text: "dynamic" }] };
	throw new Error(`Unknown tool: ${name}`);
});

await server.connect(new StdioServerTransport());
