import test from "node:test";
import assert from "node:assert/strict";
import { pageSnapshot } from "../src/snapshot.js";

function fakePage() {
  const calls = { evaluate: 0, elements: 0 };
  const root = {
    ariaSnapshot: async () => '- link "Next" [ref=e2]\n' + "x".repeat(20_000),
    evaluate: async (_fn, limit) => {
      calls.evaluate++;
      return { value: "visible text".slice(0, limit), truncated: false };
    },
    locator: () => ({
      evaluateAll: async (_fn, limit) => {
        calls.elements++;
        return [{ index: 0, tag: "a", label: "Next", href: "https://example.com/next?secret=1" }].slice(0, limit);
      },
    }),
  };
  const page = {
    title: async () => "Example",
    url: () => "https://example.com/?secret=1",
    locator: () => root,
  };
  return { page, calls };
}

test("compact detail skips text and element extraction and bounds ARIA", async () => {
  const { page, calls } = fakePage();
  const snapshot = await pageSnapshot(page, {}, undefined, { actionableRefs: true, defaultDetail: "compact" });
  assert.equal(snapshot.detail, "compact");
  assert.deepEqual(snapshot.omitted, ["text", "elements"]);
  assert.equal(snapshot.text, undefined);
  assert.equal(snapshot.elements, undefined);
  assert.equal(calls.evaluate, 0);
  assert.equal(calls.elements, 0);
  assert.equal(snapshot.ariaSnapshot.length, 12_000);
  assert.equal(snapshot.ariaTruncated, true);
  assert.match(snapshot.ariaSnapshot, /ref=s1_e2/);
});

test("full detail retains legacy rich fields and limits", async () => {
  const { page, calls } = fakePage();
  const snapshot = await pageSnapshot(page, { maxChars: 100, maxElements: 1 }, undefined, { defaultDetail: "compact" });
  assert.equal(snapshot.detail, "compact");
  assert.equal(calls.evaluate, 0);

  const full = await pageSnapshot(page, { detail: "full", maxChars: 100, maxElements: 1 }, undefined, { defaultDetail: "compact" });
  assert.equal(full.detail, "full");
  assert.equal(full.text, "visible text");
  assert.equal(full.elements.length, 1);
  assert.equal(calls.evaluate, 1);
  assert.equal(calls.elements, 1);
  assert.equal(full.elements[0].href, "https://example.com/next?...");
});

test("caller compact override beats a full tool default and strips one-shot refs", async () => {
  const { page } = fakePage();
  const snapshot = await pageSnapshot(page, { detail: "compact", maxChars: 500 }, undefined, { defaultDetail: "full" });
  assert.equal(snapshot.detail, "compact");
  assert.equal(snapshot.referenceScope, "none");
  assert.doesNotMatch(snapshot.ariaSnapshot, /\[ref=/);
});
