import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

const entry = new URL("../src/index.js", import.meta.url).pathname;

async function waitForReady(child) {
  let stderr = "";
  child.stderr.on("data", (data) => { stderr += data; });
  // Generous ceiling so a slow process launch under load does not fail
  // spuriously. On failure, kill the child so the test fails fast instead of
  // leaking a running process that keeps the event loop alive.
  const deadline = Date.now() + 30_000;
  while (!stderr.includes("Local MCP server running on stdio")) {
    if (child.exitCode !== null) throw new Error(`server exited before ready: ${stderr}`);
    if (Date.now() > deadline) {
      child.kill("SIGKILL");
      throw new Error(`server did not become ready: ${stderr}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return () => stderr;
}

async function waitForExit(child, stderr) {
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`server did not exit: ${stderr()}`));
    }, 5_000);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

test("stdin EOF triggers graceful shutdown", async () => {
  const child = spawn(process.execPath, [entry], { stdio: ["pipe", "ignore", "pipe"] });
  const stderr = await waitForReady(child);
  child.stdin.end();
  const exited = await waitForExit(child, stderr);
  assert.equal(exited.code, 0, stderr());
  assert.match(stderr(), /Shutting down after stdin end|stdin close/);
});

test("SIGHUP triggers graceful shutdown", { skip: process.platform === "win32" }, async () => {
  const child = spawn(process.execPath, [entry], { stdio: ["pipe", "ignore", "pipe"] });
  const stderr = await waitForReady(child);
  child.kill("SIGHUP");
  const exited = await waitForExit(child, stderr);
  assert.equal(exited.code, 0, stderr());
  assert.match(stderr(), /Shutting down after SIGHUP/);
});
