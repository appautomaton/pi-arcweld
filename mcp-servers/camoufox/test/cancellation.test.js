import test from "node:test";
import assert from "node:assert/strict";
import { acquireSlot, browserStatus } from "../src/browser.js";

test("queued browser work is removed on cancellation", async () => {
  const releases = await Promise.all(
    Array.from({ length: browserStatus().maxConcurrency }, () => acquireSlot()),
  );
  const controller = new AbortController();
  const queued = acquireSlot(controller.signal);
  controller.abort(new DOMException("test cancellation", "AbortError"));
  await assert.rejects(queued, /test cancellation|cancel/i);
  releases.forEach((release) => release());
});
