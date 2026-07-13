import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const runIntegration = process.env.CAMOUFOX_INTEGRATION === "1";

async function withClient(operation) {
  const client = new Client({ name: "camoufox-integration", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: new URL("../bin/camoufox-mcp", import.meta.url).pathname,
    stderr: "pipe",
  });
  try {
    await client.connect(transport);
    return await operation(client);
  } finally {
    await client.close();
  }
}

test("real browser reaches a public page", { skip: !runIntegration, timeout: 120_000 }, async () => {
  await withClient(async (client) => {
    const result = await client.callTool({ name: "browse", arguments: { url: "https://example.com", maxChars: 5_000 } });
    assert.equal(result.isError, undefined, result.content?.[0]?.text);
    assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
    assert.match(result.content[0].text, /Example Domain/);
    assert.equal(result.structuredContent.detail, "full");
    assert.equal(result.structuredContent.referenceScope, "none");
    assert.doesNotMatch(result.structuredContent.ariaSnapshot, /\[ref=/);
    assert.deepEqual(result.structuredContent.page, { url: "https://example.com/", title: "Example Domain", status: 200 });
    assert.equal(typeof result.structuredContent.text, "string");
    assert.ok(Array.isArray(result.structuredContent.elements));
  });
});

test("SSRF policy rejects loopback before browser launch", { skip: !runIntegration, timeout: 30_000 }, async () => {
  await withClient(async (client) => {
    const result = await client.callTool({ name: "browse", arguments: { url: "http://127.0.0.1:9" } });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Private, local, or reserved/);
  });
});

test("cancellation closes active navigation and browser resources", { skip: !runIntegration, timeout: 120_000 }, async () => {
  await withClient(async (client) => {
    const controller = new AbortController();
    const call = client.callTool(
      { name: "browse", arguments: { url: "https://httpstat.us/200?sleep=30000" } },
      undefined,
      { signal: controller.signal },
    );
    setTimeout(() => controller.abort(new Error("integration cancellation")), 1_000);
    await assert.rejects(call, /integration cancellation|cancel/i);
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    const status = await client.callTool({ name: "camoufox_status", arguments: {} });
    assert.equal(status.structuredContent.activeBrowsers, 0);
  });
});
