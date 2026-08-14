import test from "node:test";
import assert from "node:assert/strict";
import { resolveProfile } from "../scripts/runtime-profile.js";

test("runtime profile verification follows the manifest status", () => {
  const linux = resolveProfile({ runtimePlatform: "linux", runtimeArch: "arm64", proot: true });
  assert.equal(linux.name, "proot-arm64");
  assert.equal(linux.manifest.support.status, "verified");
  assert.equal(linux.verified, true);

  const macos = resolveProfile({ runtimePlatform: "darwin", runtimeArch: "arm64", proot: false });
  assert.equal(macos.name, "darwin-arm64");
  assert.equal(macos.manifest.support.status, "pending-revalidation");
  assert.equal(macos.verified, false);

  const genericLinux = resolveProfile({ runtimePlatform: "linux", runtimeArch: "arm64", proot: false });
  assert.equal(genericLinux.name, "generic-unverified");
  assert.equal(genericLinux.verified, false);
});
