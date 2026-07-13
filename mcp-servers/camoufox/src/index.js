#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { browserStatus, raceAbort, shutdownBrowsers, withBrowser, assertPageSafe } from "./browser.js";
import { redactUrl } from "./redact.js";
import { validateUrl } from "./policy.js";
import { pageSnapshot } from "./snapshot.js";
import { captureScreenshot } from "./screenshot.js";
import { runActions, MAX_ACTIONS } from "./actions.js";
import { commonOutputSchema, executeTool, success } from "./response.js";
import {
  actSession,
  closeAllSessions,
  closeSession,
  navigateSession,
  screenshotSession,
  sessionStatus,
  snapshotSession,
  startSession,
} from "./sessions.js";

const VERSION = "0.3.0";
const waitUntil = z.enum(["domcontentloaded", "load", "networkidle"]).optional();
const readOptions = {
  selector: z.string().min(1).max(1_000).optional(),
  detail: z.enum(["compact", "full"]).optional().describe("Snapshot detail; compact omits visible text and the separate element inventory"),
  maxChars: z.number().int().min(1).max(100_000).optional(),
  maxElements: z.number().int().min(1).max(300).optional().describe("Maximum interactive elements in full detail mode"),
};

function locatorFields({ targets }) {
  return {
    selector: z.string().min(1).max(1_000).optional().describe(targets ? "Advanced/legacy CSS or Playwright selector fallback" : "CSS or Playwright selector"),
    ...(targets ? { target: z.string().min(1).max(200).optional().describe("Preferred exact target from the latest persistent-session snapshot") } : {}),
    frame: z.string().min(1).max(1_000).optional(),
  };
}

function actionSchema({ targets }) {
  const locator = locatorFields({ targets });
  const requiresLocator = new Set(["click", "fill", "type", "select", "hover"]);
  return z.discriminatedUnion("type", [
    z.object({ type: z.literal("click"), ...locator, timeout: z.number().int().min(100).max(30_000).optional() }),
    z.object({ type: z.literal("fill"), ...locator, value: z.string().max(100_000), timeout: z.number().int().min(100).max(30_000).optional() }),
    z.object({ type: z.literal("type"), ...locator, text: z.string().max(100_000), delay: z.number().int().min(0).max(1_000).optional(), timeout: z.number().int().min(100).max(30_000).optional() }),
    z.object({ type: z.literal("press"), key: z.string().min(1).max(100), ...locator, delay: z.number().int().min(0).max(1_000).optional(), timeout: z.number().int().min(100).max(30_000).optional() }),
    z.object({ type: z.literal("select"), ...locator, value: z.union([z.string(), z.array(z.string()).max(100)]), timeout: z.number().int().min(100).max(30_000).optional() }),
    z.object({ type: z.literal("hover"), ...locator, timeout: z.number().int().min(100).max(30_000).optional() }),
    z.object({ type: z.literal("wait"), ...locator, state: z.enum(["attached", "detached", "visible", "hidden"]).optional(), ms: z.number().int().min(0).max(30_000).optional(), timeout: z.number().int().min(100).max(30_000).optional() }),
    z.object({ type: z.literal("scroll"), ...locator, x: z.number().int().min(-100_000).max(100_000).optional(), y: z.number().int().min(-100_000).max(100_000).optional(), timeout: z.number().int().min(100).max(30_000).optional() }),
  ]).superRefine((action, context) => {
    if (action.target && action.selector) context.addIssue({ code: "custom", message: "Provide target or selector, not both." });
    if (action.target && action.frame) context.addIssue({ code: "custom", message: "The frame field cannot be combined with target." });
    if (requiresLocator.has(action.type) && !action.target && !action.selector) {
      context.addIssue({ code: "custom", message: `${action.type} requires target or selector.` });
    }
  });
}

const oneShotAction = actionSchema({ targets: false });
const sessionAction = actionSchema({ targets: true });

const server = new McpServer(
  { name: "arcweld-camoufox-mcp-server", version: VERSION },
  {
    instructions: "Use Camoufox for public-web browser automation. The server blocks local/private/reserved network targets, bounds output, and closes browser work when MCP requests are cancelled. For multi-step work, prefer persistent sessions, use targets from the latest session snapshot, and close the session when finished. User confirmation policy belongs to the MCP host.",
  },
);

const statusAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true };
const interactive = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };

async function navigate(page, guard, input, signal) {
  const target = await validateUrl(input.url);
  const response = await raceAbort(page.goto(target.toString(), {
    waitUntil: input.waitUntil ?? "domcontentloaded",
    timeout: input.timeout ?? 30_000,
  }), signal);
  await raceAbort(page.waitForTimeout(100), signal);
  await assertPageSafe(page, guard);
  return response;
}

server.registerTool("camoufox_status", {
  description: "Return local Camoufox browser, queue, session, and security-policy status without launching a browser.",
  inputSchema: {},
  outputSchema: commonOutputSchema,
  annotations: statusAnnotations,
}, async () => success("camoufox_status", {
  version: VERSION,
  browser: "camoufox",
  platform: process.platform,
  ...browserStatus(),
  ...sessionStatus(),
  policy: {
    ssrf: "Blocks localhost plus private, link-local, multicast, documentation, and reserved IPv4/IPv6 ranges before navigation and per browser request.",
    networkSandbox: "Application-layer guard only; PRoot/Xvfb isolation is unchanged.",
    evaluateAllowed: false,
    proxyAllowed: false,
    customBrowserOptionsAllowed: false,
  },
}));

server.registerTool("browse", {
  description: "Open a public HTTP(S) URL in an isolated Camoufox browser and return a full bounded page read by default. Use detail=compact to omit visible text and elements. One-shot snapshots do not expose actionable targets.",
  inputSchema: {
    url: z.string().url(),
    waitUntil,
    timeout: z.number().int().min(1_000).max(120_000).optional(),
    ...readOptions,
  },
  outputSchema: commonOutputSchema,
  annotations: interactive,
}, async (input, extra) => executeTool("browse", async () => withBrowser(extra.signal, async ({ page, guard }) => {
  const response = await navigate(page, guard, input, extra.signal);
  return success("browse", { status: response?.status(), ...(await pageSnapshot(page, input, extra.signal, { defaultDetail: "full" })) });
})));

server.registerTool("browse_sequence", {
  description: `Open a public URL, run up to ${MAX_ACTIONS} bounded selector actions, then return compact final ARIA state by default. Use detail=full for visible text and elements. JavaScript evaluation and cross-call snapshot targets are not supported.`,
  inputSchema: {
    url: z.string().url(),
    waitUntil,
    timeout: z.number().int().min(1_000).max(120_000).optional(),
    actions: z.array(oneShotAction).min(1).max(MAX_ACTIONS),
    ...readOptions,
  },
  outputSchema: commonOutputSchema,
  annotations: interactive,
}, async (input, extra) => executeTool("browse_sequence", async () => withBrowser(extra.signal, async ({ page, guard }) => {
  const response = await navigate(page, guard, input, extra.signal);
  const actions = await runActions(page, guard, input.actions, extra.signal);
  return success("browse_sequence", { initialStatus: response?.status(), actions, snapshot: await pageSnapshot(page, input, extra.signal, { defaultDetail: "compact" }) });
})));

server.registerTool("browse_screenshot", {
  description: "Open a public URL and return a bounded PNG or JPEG screenshot.",
  inputSchema: {
    url: z.string().url(),
    waitUntil,
    timeout: z.number().int().min(1_000).max(120_000).optional(),
    selector: z.string().min(1).max(1_000).optional(),
    fullPage: z.boolean().optional(),
    type: z.enum(["png", "jpeg"]).optional(),
    quality: z.number().int().min(1).max(100).optional(),
  },
  outputSchema: commonOutputSchema,
  annotations: interactive,
}, async (input, extra) => executeTool("browse_screenshot", async () => withBrowser(extra.signal, async ({ page, guard }) => {
  const response = await navigate(page, guard, input, extra.signal);
  const { buffer, mimeType, bytes } = await captureScreenshot(page, input, extra.signal);
  return success("browse_screenshot", { url: redactUrl(page.url()), title: await page.title(), status: response?.status(), bytes }, {
    data: buffer.toString("base64"),
    mimeType,
  });
})));

server.registerTool("browse_session_start", {
  description: "Start one isolated short-lived Camoufox session for multi-step browser work. Close it when finished.",
  inputSchema: {},
  outputSchema: commonOutputSchema,
  annotations: interactive,
}, async (_input, extra) => executeTool("browse_session_start", async () => success("browse_session_start", await startSession(extra.signal))));

server.registerTool("browse_session_navigate", {
  description: "Navigate an existing Camoufox session and return a compact actionable ARIA snapshot by default. Use detail=full for visible text and elements.",
  inputSchema: {
    sessionId: z.string().min(1).max(200),
    url: z.string().url(),
    waitUntil,
    timeout: z.number().int().min(1_000).max(120_000).optional(),
    ...readOptions,
  },
  outputSchema: commonOutputSchema,
  annotations: interactive,
}, async (input, extra) => executeTool("browse_session_navigate", async () => success("browse_session_navigate", await navigateSession(input, extra.signal))));

server.registerTool("browse_session_snapshot", {
  description: "Read full bounded visible and ARIA state from an existing session by default. Use detail=compact for continuation-only output. The latest snapshot replaces earlier targets.",
  inputSchema: { sessionId: z.string().min(1).max(200), ...readOptions },
  outputSchema: commonOutputSchema,
  annotations: readOnly,
}, async (input, extra) => executeTool("browse_session_snapshot", async () => success("browse_session_snapshot", await snapshotSession(input, extra.signal))));

server.registerTool("browse_session_action", {
  description: "Run bounded actions with completion observation, then return compact actionable ARIA state by default. Prefer latest snapshot targets; use detail=full for visible text and elements.",
  inputSchema: {
    sessionId: z.string().min(1).max(200),
    actions: z.array(sessionAction).min(1).max(MAX_ACTIONS),
    ...readOptions,
  },
  outputSchema: commonOutputSchema,
  annotations: interactive,
}, async (input, extra) => executeTool("browse_session_action", async () => success("browse_session_action", await actSession(input, extra.signal))));

server.registerTool("browse_session_screenshot", {
  description: "Capture a bounded PNG or JPEG from an existing Camoufox session.",
  inputSchema: {
    sessionId: z.string().min(1).max(200),
    selector: z.string().min(1).max(1_000).optional(),
    fullPage: z.boolean().optional(),
    type: z.enum(["png", "jpeg"]).optional(),
    quality: z.number().int().min(1).max(100).optional(),
  },
  outputSchema: commonOutputSchema,
  annotations: readOnly,
}, async (input, extra) => executeTool("browse_session_screenshot", async () => {
  const result = await screenshotSession(input, extra.signal);
  return success("browse_session_screenshot", result.payload, result.image);
}));

server.registerTool("browse_session_close", {
  description: "Close an existing Camoufox session and release its browser resources.",
  inputSchema: { sessionId: z.string().min(1).max(200) },
  outputSchema: commonOutputSchema,
  annotations: interactive,
}, async (input) => executeTool("browse_session_close", async () => success("browse_session_close", { sessionId: input.sessionId, closed: await closeSession(input.sessionId) })));

const transport = new StdioServerTransport();
let shuttingDown = false;
async function shutdown(reason, code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.error(`[Camoufox] Shutting down after ${reason}.`);
  await closeAllSessions();
  await shutdownBrowsers();
  await server.close().catch(() => {});
  await transport.close().catch(() => {});
  process.exitCode = code;
}

process.stdin.once("end", () => void shutdown("stdin end"));
process.stdin.once("close", () => void shutdown("stdin close"));
process.once("SIGHUP", () => void shutdown("SIGHUP"));
process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

try {
  await server.connect(transport);
  console.error("[Camoufox] Local MCP server running on stdio.");
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[Camoufox] Fatal startup error: ${message}`);
  await shutdown("startup failure", 1);
}
