import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { homedir, platform } from "node:os";
import { join } from "node:path";

const runIntegration = process.env.CAMOUFOX_INTEGRATION === "1";
const browserExecutable = process.env.CAMOUFOX_EXECUTABLE_PATH ?? join(
  homedir(),
  ".local",
  "camoufox",
  ...(platform() === "darwin" ? ["Camoufox.app", "Contents", "MacOS", "camoufox"] : ["camoufox-bin"]),
);

test("direct server entry derives the browser install directory before loading camoufox-js", { skip: !runIntegration, timeout: 120_000 }, async () => {
  const env = {
    ...getDefaultEnvironment(),
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1",
    ...(platform() === "linux" ? {
      MOZ_FAKE_NO_SANDBOX: "1",
      MOZ_DISABLE_CONTENT_SANDBOX: "1",
      LIBGL_ALWAYS_SOFTWARE: "1",
    } : {}),
  };
  delete env.CAMOUFOX_INSTALL_DIR;

  const client = new Client({ name: "direct-entry-test", version: "1" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [new URL("../src/index.js", import.meta.url).pathname, "--executable-path", browserExecutable],
    env,
    stderr: "pipe",
  });
  try {
    await client.connect(transport);
    const result = await client.callTool({ name: "browse", arguments: { url: "https://example.com/", detail: "compact" } });
    assert.equal(result.structuredContent?.ok, true);
    assert.equal(result.structuredContent?.status, 200);
    assert.equal(result.structuredContent?.title, "Example Domain");
  } finally {
    await client.close();
  }
});
