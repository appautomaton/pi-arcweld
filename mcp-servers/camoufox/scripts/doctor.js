#!/usr/bin/env node
import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { arch, homedir, platform, release } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { installedVerStr, launchPath } from "camoufox-js/dist/pkgman.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(root, "config", "proot-arm64-runtime.json"), "utf8"));
const expected = manifest.npm;
const expectedBrowser = `${manifest.browser.version}-${manifest.browser.release}`;
let proot = false;
try {
  proot = platform() === "linux" && readFileSync("/proc/version", "utf8").toLowerCase().includes("proot");
} catch {}

let failed = false;
function check(ok, label) {
  console.log(`${ok ? "ok" : "FAIL"} ${label}`);
  failed ||= !ok;
}

console.log(`runtime ${platform()} ${arch()} ${release()} node ${process.version}`);
console.log(`root ${root}`);
console.log(`home ${homedir()}`);
console.log(`profile ${proot ? "proot-arm64" : "generic-unverified"}`);

check(Number.parseInt(process.versions.node.split(".")[0], 10) >= 24, `Node ${process.version}`);
for (const [name, version] of Object.entries(expected)) {
  try {
    const installed = JSON.parse(readFileSync(join(root, "node_modules", ...name.split("/"), "package.json"), "utf8")).version;
    check(installed === version, `${name} ${installed} (expected ${version})`);
  } catch (error) {
    check(false, `${name} missing (${error instanceof Error ? error.message : error})`);
  }
}

try {
  const path = String(launchPath());
  accessSync(path, constants.X_OK);
  check(installedVerStr() === expectedBrowser, `browser ${installedVerStr()} at ${path}`);
} catch (error) {
  check(false, `browser ${error instanceof Error ? error.message : error}`);
}

for (const command of proot ? manifest.proot.requiredCommands : ["node", "npm"]) {
  const result = spawnSync("sh", ["-c", `command -v "$1" >/dev/null 2>&1`, "doctor", command]);
  check(result.status === 0, `command ${command}`);
}

const launcher = proot ? join(root, manifest.proot.launcher) : join(root, "bin", "camoufox-mcp");
check(existsSync(launcher), `launcher ${launcher}`);

if (!proot) console.log("note this environment is not in the verified PRoot ARM64 support profile");
if (failed) process.exitCode = 1;
