import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

test("stdio guard forces console output onto stderr", async () => {
  const script = `
    import("./src/stdio-guard.js").then(() => {
      console.log("log-line");
      console.info("info-line");
      console.warn("warn-line");
      console.debug("debug-line");
      console.error("error-line");
    });
  `;
  const { stdout, stderr } = await run(process.execPath, ["--input-type=module", "-e", script], {
    cwd: new URL("..", import.meta.url).pathname,
  });
  assert.equal(stdout, "", "stdout must stay empty for JSON-RPC framing");
  for (const line of ["log-line", "info-line", "warn-line", "debug-line", "error-line"]) {
    assert.match(stderr, new RegExp(line));
  }
});
