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

// Must mirror camoufox-js userCacheDir(): the launcher resolves the browser
// from this directory, so the installer has to agree with it exactly.
function browserInstallDir() {
  if (platform() === "darwin") return join(homedir(), "Library", "Caches", "camoufox");
  return join(homedir(), ".cache", "camoufox");
}

export function resolveProfile() {
  if (platform() === "darwin" && arch() === "arm64") {
    const manifest = readManifest("darwin-arm64-runtime.json");
    return {
      name: "darwin-arm64",
      verified: true,
      manifest,
      installDir: browserInstallDir(),
      browserInstallSupported: true,
      launcher: manifest.launcher.path,
      requiredCommands: manifest.launcher.requiredCommands,
    };
  }
  if (platform() === "linux" && arch() === "arm64") {
    const manifest = readManifest("proot-arm64-runtime.json");
    const proot = isProot();
    return {
      name: proot ? "proot-arm64" : "generic-unverified",
      verified: proot,
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
