import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    assert.match(result.stdout, /releases: 0/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("deployment status lists releases with their deployed metadata", () => {
  const root = mkdtempSync(join(tmpdir(), "camoufox-deploy-releases-"));
  try {
    const releases = join(root, "releases");
    mkdirSync(join(releases, "first"), { recursive: true });
    mkdirSync(join(releases, "second"), { recursive: true });
    writeFileSync(join(releases, "second", "DEPLOYMENT.json"), '{"packageVersion":"0.5.0","sourceFingerprint":"222222222222","deployedAt":"2026-10-24T23:00:17.988Z"}\n');
    symlinkSync("releases/second", join(root, "current"), "dir");

    const result = run(root, "status");
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /releases: 2/);
    assert.match(result.stdout, /version 0\.5\.0, source 222222222222/);
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
    const result = run(root, "deploy");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, new RegExp(`another deployment command is running with PID ${process.pid}`));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
