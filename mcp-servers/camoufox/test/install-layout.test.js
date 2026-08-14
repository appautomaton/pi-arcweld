import test from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { installWorkPrefix } from "../scripts/install-layout.js";

test("browser installation stages beside the final install directory", () => {
  const installDir = join("/home", "user", ".local", "camoufox");
  const prefix = installWorkPrefix(installDir);
  assert.equal(dirname(prefix), dirname(installDir));
  assert.equal(prefix, join("/home", "user", ".local", ".camoufox-install-"));
});
