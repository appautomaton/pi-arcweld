import test from "node:test";
import assert from "node:assert/strict";
import { parseCliArgs } from "../src/cli.js";

test("parses the Camoufox executable path", () => {
  assert.deepEqual(parseCliArgs(["--executable-path", "/opt/camoufox/camoufox-bin"]), {
    executablePath: "/opt/camoufox/camoufox-bin",
  });
  assert.deepEqual(parseCliArgs(["--executable-path=/opt/camoufox/camoufox-bin"]), {
    executablePath: "/opt/camoufox/camoufox-bin",
  });
});

test("requires an absolute Camoufox executable path", () => {
  assert.throws(() => parseCliArgs([]), /requires an absolute browser path/);
  assert.throws(() => parseCliArgs(["--executable-path", "camoufox-bin"]), /must be absolute/);
  assert.throws(() => parseCliArgs(["--other-option"]), /Unknown option/);
});
