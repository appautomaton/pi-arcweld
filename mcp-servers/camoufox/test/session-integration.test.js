import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const runIntegration = process.env.CAMOUFOX_INTEGRATION === "1";

test("session uses compact continuation output, completion, rich snapshots, and scoped targets", { skip: !runIntegration, timeout: 120_000 }, async () => {
  const client = new Client({ name: "session-test", version: "1" });
  const transport = new StdioClientTransport({ command: new URL("../bin/camoufox-mcp", import.meta.url).pathname, stderr: "pipe" });
  try {
    await client.connect(transport);
    const started = await client.callTool({ name: "browse_session_start", arguments: {} });
    assert.equal(started.isError, undefined, started.content[0].text);
    assert.deepEqual(JSON.parse(started.content[0].text), started.structuredContent);
    const sessionId = started.structuredContent.sessionId;

    const navigated = await client.callTool({ name: "browse_session_navigate", arguments: { sessionId, url: "https://example.com" } });
    assert.equal(navigated.isError, undefined, navigated.content[0].text);
    assert.equal(navigated.structuredContent.detail, "compact");
    assert.deepEqual(navigated.structuredContent.omitted, ["text", "elements"]);
    assert.equal(navigated.structuredContent.text, undefined);
    assert.equal(navigated.structuredContent.elements, undefined);
    assert.equal(navigated.structuredContent.referenceScope, "session");
    const firstTarget = navigated.structuredContent.ariaSnapshot.match(/link "(?:More information\.\.\.|Learn more)" \[ref=(s1_e\d+)\]/)?.[1];
    assert.ok(firstTarget, navigated.content[0].text);

    const acted = await client.callTool({
      name: "browse_session_action",
      arguments: { sessionId, actions: [{ type: "click", target: firstTarget }] },
    });
    assert.equal(acted.isError, undefined, acted.content[0].text);
    assert.equal(acted.structuredContent.actions[0].target, firstTarget);
    assert.equal(acted.structuredContent.actions[0].completion.kind, "navigation");
    assert.equal(acted.structuredContent.actions[0].completion.urlChanged, true);
    assert.equal(acted.structuredContent.snapshot.detail, "compact");
    assert.equal(acted.structuredContent.snapshot.snapshotId, "s2");
    assert.ok(Buffer.byteLength(acted.content[0].text) < 50 * 1024);

    const stale = await client.callTool({
      name: "browse_session_action",
      arguments: { sessionId, actions: [{ type: "click", target: firstTarget }] },
    });
    assert.equal(stale.isError, true);
    assert.equal(stale.structuredContent.error.code, "STALE_TARGET");

    const full = await client.callTool({ name: "browse_session_snapshot", arguments: { sessionId, maxChars: 5_000, maxElements: 10 } });
    assert.equal(full.isError, undefined, full.content[0].text);
    assert.equal(full.structuredContent.detail, "full");
    assert.equal(typeof full.structuredContent.text, "string");
    assert.ok(Array.isArray(full.structuredContent.elements));

    const compactOverride = await client.callTool({ name: "browse_session_snapshot", arguments: { sessionId, detail: "compact", maxChars: 2_000 } });
    assert.equal(compactOverride.structuredContent.detail, "compact");
    assert.equal(compactOverride.structuredContent.text, undefined);

    const selectorAction = await client.callTool({
      name: "browse_session_action",
      arguments: { sessionId, actions: [{ type: "click", selector: "a" }] },
    });
    assert.equal(selectorAction.isError, undefined, selectorAction.content[0].text);

    const beforeNavigation = selectorAction.structuredContent.snapshot.ariaSnapshot.match(/\[ref=(s5_(?:f\d+)?e\d+)\]/)?.[1];
    assert.ok(beforeNavigation, selectorAction.content[0].text);
    const navigatedAgain = await client.callTool({ name: "browse_session_navigate", arguments: { sessionId, url: "https://example.com" } });
    assert.equal(navigatedAgain.isError, undefined, navigatedAgain.content[0].text);
    const staleAfterNavigation = await client.callTool({
      name: "browse_session_action",
      arguments: { sessionId, actions: [{ type: "click", target: beforeNavigation }] },
    });
    assert.equal(staleAfterNavigation.isError, true);
    assert.equal(staleAfterNavigation.structuredContent.error.code, "STALE_TARGET");

    const closed = await client.callTool({ name: "browse_session_close", arguments: { sessionId } });
    assert.equal(closed.structuredContent.closed, true);
    const status = await client.callTool({ name: "camoufox_status", arguments: {} });
    assert.match(status.content[0].text, /"activeBrowsers": 0/);
    assert.match(status.content[0].text, /"activeSessions": 0/);
  } finally {
    await client.close();
  }
});
