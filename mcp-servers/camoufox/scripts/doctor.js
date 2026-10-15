#!/usr/bin/env node
import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { arch, homedir, platform, release } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { resolveProfile } from "./runtime-profile.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const profile = resolveProfile();
const expected = profile.manifest.npm;
const expectedBrowser = `${profile.manifest.browser.version}-${profile.manifest.browser.release}`;

let failed = false;
function check(ok, label) {
  console.log(`${ok ? "ok" : "FAIL"} ${label}`);
  failed ||= !ok;
}

console.log(`runtime ${platform()} ${arch()} ${release()} node ${process.version}`);
console.log(`root ${root}`);
console.log(`home ${homedir()}`);
console.log(`profile ${profile.name}`);

check(Number.parseInt(process.versions.node.split(".")[0], 10) >= 24, `Node ${process.version}`);
for (const [name, version] of Object.entries(expected)) {
  try {
    const installed = JSON.parse(readFileSync(join(root, "node_modules", ...name.split("/"), "package.json"), "utf8")).version;
    check(installed === version, `${name} ${installed} (expected ${version})`);
  } catch (error) {
    check(false, `${name} missing (${error instanceof Error ? error.message : error})`);
  }
}

const executable = join(profile.installDir, ...profile.manifest.browser.executablePath.split("/"));
try {
  const installed = JSON.parse(readFileSync(join(profile.installDir, "version.json"), "utf8"));
  accessSync(executable, constants.X_OK);
  const installedBrowser = `${installed.version}-${installed.release}`;
  check(installedBrowser === expectedBrowser, `browser ${installedBrowser} at ${executable}`);
} catch (error) {
  check(false, `browser ${error instanceof Error ? error.message : error}`);
}

// The launcher reads the Firefox version from application.ini beside the
// executable it is told to launch, and every launch fails when that file is
// absent, so assert the stamp the installer writes for bundle layouts. Checking
// the version too catches a stamp left behind by a previous browser install.
try {
  const versionLine = readFileSync(join(dirname(executable), "application.ini"), "utf8")
    .split(/\r\n|\r|\n/)
    .find((line) => line.startsWith("Version="));
  const stampedBrowser = versionLine?.slice("Version=".length).trim();
  check(stampedBrowser === expectedBrowser, `application.ini ${stampedBrowser ?? "missing"} beside the executable (expected ${expectedBrowser})`);
} catch (error) {
  check(false, `application.ini ${error instanceof Error ? error.message : error}`);
}

for (const command of profile.requiredCommands) {
  const result = spawnSync("sh", ["-c", `command -v "$1" >/dev/null 2>&1`, "doctor", command]);
  check(result.status === 0, `command ${command}`);
}

const launcher = join(root, profile.launcher);
check(existsSync(launcher), `launcher ${launcher}`);

if (!profile.verified) console.log("note this environment is not in a verified support profile");
if (failed) process.exitCode = 1;
