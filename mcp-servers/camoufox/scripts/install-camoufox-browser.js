#!/usr/bin/env node
import { createHash } from "node:crypto";
import { copyFileSync, createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(root, "config", "proot-arm64-runtime.json"), "utf8"));
const browser = manifest.browser;
const installDir = join(homedir(), ".cache", "camoufox");
const versionPath = join(installDir, "version.json");

function installedMatches() {
  try {
    const installed = JSON.parse(readFileSync(versionPath, "utf8"));
    return installed.version === browser.version && installed.release === browser.release;
  } catch {
    return false;
  }
}

async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

if (installedMatches()) {
  console.log(`ok Camoufox ${browser.version}-${browser.release} already installed at ${installDir}`);
  process.exit(0);
}

if (existsSync(installDir)) {
  console.error(`FAIL existing Camoufox cache does not match ${browser.version}-${browser.release}: ${installDir}`);
  console.error("Move or remove that cache deliberately, then rerun this installer. It will not overwrite an unknown installation.");
  process.exit(1);
}

const work = mkdtempSync(join(tmpdir(), "camoufox-install-"));
const archive = join(work, browser.asset);
const extracted = join(work, "extracted");
try {
  const suppliedArchive = process.env.CAMOUFOX_ARCHIVE;
  if (suppliedArchive) {
    if (!existsSync(suppliedArchive)) throw new Error(`CAMOUFOX_ARCHIVE does not exist: ${suppliedArchive}`);
    console.log(`use archive ${suppliedArchive}`);
    copyFileSync(suppliedArchive, archive);
  } else {
    console.log(`download ${browser.url}`);
    const curl = spawnSync("curl", ["-fL", "--retry", "3", "--output", archive, browser.url], { stdio: "inherit" });
    if (curl.status !== 0) throw new Error(`curl exited with status ${curl.status ?? "unknown"}`);
  }

  const actualBytes = statSync(archive).size;
  if (actualBytes !== browser.bytes) throw new Error(`archive size ${actualBytes} did not match expected ${browser.bytes}`);

  const actualHash = await sha256(archive);
  if (actualHash !== browser.archiveSha256) throw new Error(`archive SHA-256 ${actualHash} did not match expected ${browser.archiveSha256}`);

  const unzip = spawnSync("unzip", ["-q", archive, "-d", extracted], { stdio: "inherit" });
  if (unzip.status !== 0) throw new Error(`unzip exited with status ${unzip.status ?? "unknown"}`);

  const executable = join(extracted, "camoufox-bin");
  const executableHash = await sha256(executable);
  if (executableHash !== browser.executableSha256) {
    throw new Error(`camoufox-bin SHA-256 ${executableHash} did not match expected ${browser.executableSha256}`);
  }

  writeFileSync(join(extracted, "version.json"), JSON.stringify({ version: browser.version, release: browser.release }));

  const chmod = spawnSync("chmod", ["-R", "u+rwX,go+rX", extracted], { stdio: "inherit" });
  if (chmod.status !== 0) throw new Error(`chmod exited with status ${chmod.status ?? "unknown"}`);

  mkdirSync(dirname(installDir), { recursive: true });
  renameSync(extracted, installDir);
  console.log(`ok installed Camoufox ${browser.version}-${browser.release} at ${installDir}`);
} catch (error) {
  console.error(`FAIL ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  rmSync(work, { recursive: true, force: true });
}
