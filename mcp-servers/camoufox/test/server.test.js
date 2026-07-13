import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

test("stdio server exposes only the local bounded tool set", async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [new URL("../src/index.js", import.meta.url).pathname],
    stderr: "pipe",
  });
  const client = new Client({ name: "local-test", version: "1.0.0" });
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    const names = listed.tools.map(({ name }) => name).sort();
    assert.deepEqual(names, [
      "browse",
      "browse_screenshot",
      "browse_sequence",
      "browse_session_action",
      "browse_session_close",
      "browse_session_navigate",
      "browse_session_screenshot",
      "browse_session_snapshot",
      "browse_session_start",
      "camoufox_status",
    ]);
    assert.equal(names.some((name) => name.includes("eval")), false);
    const expectedAnnotations = {
      camoufox_status: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      browse: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      browse_sequence: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      browse_screenshot: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      browse_session_start: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      browse_session_navigate: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      browse_session_snapshot: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      browse_session_action: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      browse_session_screenshot: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      browse_session_close: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    };
    for (const tool of listed.tools) assert.deepEqual(tool.annotations, expectedAnnotations[tool.name], tool.name);

    const sessionAction = listed.tools.find(({ name }) => name === "browse_session_action");
    const actionSchema = sessionAction.inputSchema.properties.actions.items;
    assert.match(JSON.stringify(actionSchema), /target/);
    assert.deepEqual(sessionAction.inputSchema.properties.detail.enum, ["compact", "full"]);
    assert.equal(sessionAction.inputSchema.properties.includeText, undefined);
    assert.equal(sessionAction.inputSchema.properties.completion, undefined);
    const oneShot = listed.tools.find(({ name }) => name === "browse_sequence");
    assert.doesNotMatch(JSON.stringify(oneShot.inputSchema.properties.actions.items), /target/);
    assert.deepEqual(oneShot.inputSchema.properties.detail.enum, ["compact", "full"]);

    const status = await client.callTool({ name: "camoufox_status", arguments: {} });
    assert.equal(status.isError, undefined);
    assert.deepEqual(JSON.parse(status.content[0].text), status.structuredContent);
    assert.equal(status.structuredContent.schemaVersion, "2");
    assert.equal(status.structuredContent.ok, true);
    assert.equal(status.structuredContent.operation, "camoufox_status");
    assert.equal(status.structuredContent.version, "0.3.0");
    assert.equal(status.structuredContent.policy.evaluateAllowed, false);
  } finally {
    await client.close();
  }
});

test("invalid action locator combinations are rejected by the public schema", async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [new URL("../src/index.js", import.meta.url).pathname],
    stderr: "pipe",
  });
  const client = new Client({ name: "schema-test", version: "1.0.0" });
  try {
    await client.connect(transport);
    const missing = await client.callTool({ name: "browse_session_action", arguments: { sessionId: "sess_none", actions: [{ type: "click" }] } });
    assert.equal(missing.isError, true);
    assert.match(missing.content[0].text, /requires target or selector/);
    const ambiguous = await client.callTool({ name: "browse_session_action", arguments: { sessionId: "sess_none", actions: [{ type: "click", target: "s1_e1", selector: "button" }] } });
    assert.equal(ambiguous.isError, true);
    assert.match(ambiguous.content[0].text, /target or selector, not both/);
  } finally {
    await client.close();
  }
});

test("cancelled MCP call reaches the handler and returns promptly", async () => {
  const script = `
    import { Client } from ${JSON.stringify(new URL("../node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js", import.meta.url).href)};
    import { StdioClientTransport } from ${JSON.stringify(new URL("../node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js", import.meta.url).href)};
    const client = new Client({name:'cancel-test',version:'1'});
    const transport = new StdioClientTransport({command:process.execPath,args:[${JSON.stringify(new URL("../src/index.js", import.meta.url).pathname)}],stderr:'pipe'});
    await client.connect(transport);
    const controller = new AbortController();
    const call = client.callTool({name:'browse',arguments:{url:'https://example.com'}}, undefined, {signal:controller.signal});
    setTimeout(() => controller.abort(new Error('local cancellation check')), 10);
    try { await call; process.exitCode=2; } catch (error) { console.log(String(error.message)); }
    await client.close();
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (data) => { stdout += data; });
  child.stderr.on("data", (data) => { stderr += data; });
  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`cancellation test hung: ${stderr}`)); }, 10_000);
    child.on("exit", (value) => { clearTimeout(timer); resolve(value); });
  });
  assert.equal(code, 0, stderr);
  assert.match(stdout, /local cancellation check|cancel/i);
});
