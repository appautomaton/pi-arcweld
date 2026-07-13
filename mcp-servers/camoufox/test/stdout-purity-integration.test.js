import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";

const runIntegration = process.env.CAMOUFOX_INTEGRATION === "1";

// Strict MCP clients close the connection on any stdout line that is not a
// JSON-RPC frame, so this drives a real browser launch through the launcher
// with raw pipes and asserts byte-level stdout purity. The SDK test client
// tolerates polluted lines via an ignored onerror, which is exactly how the
// camoufox-js "Skipping addon download" console.log regression slipped past
// the tool-level integration tests.
test("stdout carries only JSON-RPC frames through a real browser launch", { skip: !runIntegration, timeout: 120_000 }, async () => {
  const launcher = new URL("../bin/camoufox-mcp", import.meta.url).pathname;
  const child = spawn(launcher, [], { stdio: ["pipe", "pipe", "pipe"] });
  const polluted = [];
  let buffer = "";
  let resolveDone;
  const done = new Promise((resolve) => { resolveDone = resolve; });

  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (!line.trim()) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        polluted.push(line);
        continue;
      }
      if (message.id === 2) resolveDone(message);
    }
  });
  child.stderr.resume();

  const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
  try {
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "purity-test", version: "1" } } });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "browse", arguments: { url: "https://example.com" } } });
    const response = await done;
    assert.equal(polluted.length, 0, `stdout pollution: ${polluted.map((line) => line.slice(0, 100)).join(" | ")}`);
    assert.equal(response.error, undefined);
  } finally {
    child.kill("SIGTERM");
    await once(child, "exit").catch(() => {});
  }
});
