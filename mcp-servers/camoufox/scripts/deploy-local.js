#!/usr/bin/env node
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const deployRoot = resolve(process.env.CAMOUFOX_MCP_DEPLOY_ROOT ?? join(homedir(), ".local", "mcps", "camoufox"));
const releasesRoot = join(deployRoot, "releases");
const action = process.argv[2] ?? "deploy";
const packageJson = JSON.parse(readFileSync(join(sourceRoot, "package.json"), "utf8"));
const copiedEntries = ["bin", "config", "docs", "scripts", "src", "test", "README.md", "package.json", "package-lock.json"];
const lockDir = join(deployRoot, ".deploy.lock");

function fail(message) {
  throw new Error(message);
}

function run(command, args, cwd) {
  console.log(`run ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, { cwd, env: process.env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) fail(`${command} exited with status ${result.status ?? "unknown"}`);
}

function filesBelow(path, base = path) {
  const result = [];
  const stat = lstatSync(path);
  if (!stat.isDirectory()) return [{ path, relativePath: relative(base, path) || basename(path) }];
  for (const name of readdirSync(path).sort()) {
    const child = join(path, name);
    const childStat = lstatSync(child);
    if (childStat.isDirectory()) result.push(...filesBelow(child, base));
    else if (childStat.isFile() || childStat.isSymbolicLink()) result.push({ path: child, relativePath: relative(base, child) });
  }
  return result;
}

function sourceFingerprint() {
  const hash = createHash("sha256");
  for (const entry of copiedEntries) {
    const path = join(sourceRoot, entry);
    for (const file of filesBelow(path, sourceRoot)) {
      hash.update(file.relativePath);
      hash.update("\0");
      if (lstatSync(file.path).isSymbolicLink()) hash.update(`link:${readlinkSync(file.path)}`);
      else hash.update(readFileSync(file.path));
      hash.update("\0");
    }
  }
  return hash.digest("hex");
}

function linkTarget(name) {
  const path = join(deployRoot, name);
  if (!existsSync(path) && !lstatExists(path)) return undefined;
  const stat = lstatSync(path);
  if (!stat.isSymbolicLink()) fail(`${path} exists but is not a symbolic link`);
  const target = resolve(deployRoot, readlinkSync(path));
  const prefix = `${releasesRoot}${sep}`;
  if (target !== releasesRoot && !target.startsWith(prefix)) fail(`${path} points outside ${releasesRoot}`);
  if (!existsSync(target)) fail(`${path} points to a missing release: ${target}`);
  return target;
}

function lstatExists(path) {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function processIsRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function acquireDeployLock() {
  mkdirSync(deployRoot, { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      mkdirSync(lockDir);
      writeFileSync(join(lockDir, "owner.json"), `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }, null, 2)}\n`);
      return () => rmSync(lockDir, { recursive: true, force: true });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      let owner;
      try {
        owner = JSON.parse(readFileSync(join(lockDir, "owner.json"), "utf8"));
      } catch {
        fail(`deployment lock exists but its owner cannot be read: ${lockDir}`);
      }
      if (processIsRunning(owner?.pid)) fail(`another deployment command is running with PID ${owner.pid}`);
      rmSync(lockDir, { recursive: true, force: true });
    }
  }
  fail(`could not acquire deployment lock: ${lockDir}`);
}

function replaceLink(name, target) {
  mkdirSync(deployRoot, { recursive: true });
  const destination = join(deployRoot, name);
  if (lstatExists(destination) && !lstatSync(destination).isSymbolicLink()) {
    fail(`${destination} exists but is not a symbolic link`);
  }
  const temporary = join(deployRoot, `.${name}-${process.pid}-${Date.now()}`);
  rmSync(temporary, { force: true });
  symlinkSync(relative(deployRoot, target), temporary, "dir");
  renameSync(temporary, destination);
}

function deploymentInfo(path) {
  try {
    return JSON.parse(readFileSync(join(path, "DEPLOYMENT.json"), "utf8"));
  } catch {
    return undefined;
  }
}

function printLink(name) {
  const target = linkTarget(name);
  if (!target) {
    console.log(`${name}: none`);
    return;
  }
  const info = deploymentInfo(target);
  console.log(`${name}: ${target}`);
  if (info) console.log(`  version ${info.packageVersion}, source ${info.sourceFingerprint.slice(0, 12)}, deployed ${info.deployedAt}`);
}

function status() {
  console.log(`deploy root: ${deployRoot}`);
  printLink("current");
  printLink("previous");
  if (!existsSync(releasesRoot)) {
    console.log("releases: 0");
    return;
  }
  const releases = readdirSync(releasesRoot).filter((name) => existsSync(join(releasesRoot, name))).sort();
  console.log(`releases: ${releases.length}`);
  for (const name of releases) console.log(`  ${name}`);
}

function deploy() {
  const releasePrefix = `${releasesRoot}${sep}`;
  if (sourceRoot === releasesRoot || sourceRoot.startsWith(releasePrefix)) {
    fail("deploy from the canonical source checkout, not from an installed release");
  }
  mkdirSync(releasesRoot, { recursive: true });
  const fingerprint = sourceFingerprint();
  const timestamp = new Date().toISOString().replace(/[-:.]/g, "");
  const releaseName = `${packageJson.version}-${timestamp}-${fingerprint.slice(0, 12)}`;
  const staging = join(deployRoot, `.staging-${releaseName}-${process.pid}`);
  const release = join(releasesRoot, releaseName);
  if (existsSync(release)) fail(`release already exists: ${release}`);

  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  try {
    for (const entry of copiedEntries) cpSync(join(sourceRoot, entry), join(staging, entry), { recursive: true, preserveTimestamps: true });
    writeFileSync(join(staging, "DEPLOYMENT.json"), `${JSON.stringify({
      schemaVersion: 1,
      packageName: packageJson.name,
      packageVersion: packageJson.version,
      sourceFingerprint: fingerprint,
      deployedAt: new Date().toISOString(),
      sourceRoot,
    }, null, 2)}\n`);

    run("npm", ["ci", "--omit=dev"], staging);
    run("npm", ["run", "doctor"], staging);
    run("npm", ["test"], staging);
    run("npm", ["run", "test:integration"], staging);

    renameSync(staging, release);
    const oldCurrent = linkTarget("current");
    if (oldCurrent) replaceLink("previous", oldCurrent);
    replaceLink("current", release);

    console.log(`ok deployed ${packageJson.name} ${packageJson.version}`);
    console.log(`release: ${release}`);
    console.log(`current: ${join(deployRoot, "current")}`);
    if (oldCurrent) console.log(`previous: ${oldCurrent}`);
    console.log(`Pi command: ${join(deployRoot, "current", "bin", "camoufox-mcp")}`);
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

function rollback() {
  const current = linkTarget("current");
  const previous = linkTarget("previous");
  if (!previous) fail("no previous deployment is available");
  replaceLink("current", previous);
  if (current) replaceLink("previous", current);
  console.log(`ok current -> ${previous}`);
  if (current) console.log(`previous -> ${current}`);
  console.log("Restart or reconnect the Camoufox MCP server for the change to take effect.");
}

try {
  if (action === "status") status();
  else if (action === "deploy" || action === "rollback") {
    const releaseLock = acquireDeployLock();
    try {
      if (action === "deploy") deploy();
      else rollback();
    } finally {
      releaseLock();
    }
  } else fail("usage: node scripts/deploy-local.js [deploy|status|rollback]");
} catch (error) {
  console.error(`FAIL ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
