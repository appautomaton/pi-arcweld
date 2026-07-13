import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const runIntegration = process.env.CAMOUFOX_INTEGRATION === "1";

test("cancelled session navigation closes that session", { skip: !runIntegration, timeout: 120_000 }, async () => {
  const client = new Client({ name: "session-cancel-test", version: "1" });
  const transport = new StdioClientTransport({ command: new URL("../bin/camoufox-mcp", import.meta.url).pathname, stderr: "pipe" });
  try {
    await client.connect(transport);
    const started = await client.callTool({ name: "browse_session_start", arguments: {} });
    const sessionId = JSON.parse(started.content[0].text).sessionId;
    const controller = new AbortController();
    const call = client.callTool(
      { name: "browse_session_navigate", arguments: { sessionId, url: "https://httpstat.us/200?sleep=30000" } },
      undefined,
      { signal: controller.signal },
    );
    setTimeout(() => controller.abort(new Error("cancel session navigation")), 1_000);
    await assert.rejects(call, /cancel session navigation|cancel/i);
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    const status = await client.callTool({ name: "camoufox_status", arguments: {} });
    assert.equal(status.structuredContent.activeBrowsers, 0);
    assert.equal(status.structuredContent.activeSessions, 0);
  } finally {
    await client.close();
  }
});
