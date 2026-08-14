import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const script = new URL("../scripts/deploy-local.js", import.meta.url).pathname;

function run(root, action) {
  return spawnSync(process.execPath, [script, action], {
    encoding: "utf8",
    env: { ...process.env, CAMOUFOX_MCP_DEPLOY_ROOT: root },
  });
}

test("deployment status handles an empty local root", () => {
  const root = mkdtempSync(join(tmpdir(), "camoufox-deploy-status-"));
  try {
    const result = run(root, "status");
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /current: none/);
    assert.match(result.stdout, /previous: none/);
    assert.match(result.stdout, /releases: 0/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("deployment rollback swaps current and previous links", () => {
  const root = mkdtempSync(join(tmpdir(), "camoufox-deploy-rollback-"));
  try {
    const releases = join(root, "releases");
    const first = join(releases, "first");
    const second = join(releases, "second");
    mkdirSync(first, { recursive: true });
    mkdirSync(second, { recursive: true });
    writeFileSync(join(first, "DEPLOYMENT.json"), '{"packageVersion":"0.4.0","sourceFingerprint":"111111111111"}\n');
    writeFileSync(join(second, "DEPLOYMENT.json"), '{"packageVersion":"0.5.0","sourceFingerprint":"222222222222"}\n');
    symlinkSync("releases/second", join(root, "current"), "dir");
    symlinkSync("releases/first", join(root, "previous"), "dir");

    const result = run(root, "rollback");
    assert.equal(result.status, 0, result.stderr);
    assert.equal(resolve(root, readlinkSync(join(root, "current"))), first);
    assert.equal(resolve(root, readlinkSync(join(root, "previous"))), second);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("deployment mutation refuses an active deployment lock", () => {
  const root = mkdtempSync(join(tmpdir(), "camoufox-deploy-lock-"));
  try {
    const lock = join(root, ".deploy.lock");
    mkdirSync(lock);
    writeFileSync(join(lock, "owner.json"), `${JSON.stringify({ pid: process.pid })}\n`);
    const result = run(root, "rollback");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, new RegExp(`another deployment command is running with PID ${process.pid}`));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
