import { readFileSync } from "node:fs";
import { arch, homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function readManifest(name) {
  return JSON.parse(readFileSync(join(root, "config", name), "utf8"));
}

function isProot() {
  try {
    return readFileSync("/proc/version", "utf8").toLowerCase().includes("proot");
  } catch {
    return false;
  }
}

function browserInstallDir() {
  return join(homedir(), ".local", "camoufox");
}

export function resolveProfile({ runtimePlatform = platform(), runtimeArch = arch(), proot = isProot() } = {}) {
  if (runtimePlatform === "darwin" && runtimeArch === "arm64") {
    const manifest = readManifest("darwin-arm64-runtime.json");
    return {
      name: "darwin-arm64",
      verified: manifest.support.status === "verified",
      manifest,
      installDir: browserInstallDir(),
      browserInstallSupported: true,
      launcher: manifest.launcher.path,
      requiredCommands: manifest.launcher.requiredCommands,
    };
  }
  if (runtimePlatform === "linux" && runtimeArch === "arm64") {
    const manifest = readManifest("proot-arm64-runtime.json");
    return {
      name: proot ? "proot-arm64" : "generic-unverified",
      verified: proot && manifest.support.status === "verified",
      manifest,
      installDir: browserInstallDir(),
      browserInstallSupported: true,
      launcher: proot ? manifest.proot.launcher : "bin/camoufox-mcp",
      requiredCommands: proot ? manifest.proot.requiredCommands : ["node", "npm"],
    };
  }
  const manifest = readManifest("proot-arm64-runtime.json");
  return {
    name: "generic-unverified",
    verified: false,
    manifest,
    installDir: browserInstallDir(),
    browserInstallSupported: false,
    launcher: "bin/camoufox-mcp",
    requiredCommands: ["node", "npm"],
  };
}
