import test from "node:test";
import assert from "node:assert/strict";
import { invalidateSnapshot, publishSnapshot, resolveTarget, snapshotState, stripSnapshotRefs } from "../src/snapshot-state.js";

const aria = '- button "Submit" [ref=e2]\n- iframe [ref=f1e3]';

test("publishes snapshot-scoped targets and advances generations", () => {
  const page = {};
  const first = publishSnapshot(page, aria);
  assert.equal(first.snapshotId, "s1");
  assert.equal(first.refCount, 2);
  assert.match(first.ariaSnapshot, /ref=s1_e2/);
  assert.match(first.ariaSnapshot, /ref=s1_f1e3/);
  assert.equal(resolveTarget(page, "s1_e2"), "e2");

  const second = publishSnapshot(page, aria);
  assert.equal(second.snapshotId, "s2");
  assert.throws(() => resolveTarget(page, "s1_e2"), (error) => error.code === "STALE_TARGET");
  assert.equal(resolveTarget(page, "s2_f1e3"), "f1e3");
});

test("distinguishes missing, invalid, and stale target state", () => {
  const page = {};
  assert.throws(() => resolveTarget(page, "s1_e2"), (error) => error.code === "SNAPSHOT_REQUIRED");
  publishSnapshot(page, aria);
  assert.throws(() => resolveTarget(page, "not-a-ref"), (error) => error.code === "INVALID_TARGET");
  assert.throws(() => resolveTarget(page, "s1_e999"), (error) => error.code === "INVALID_TARGET");
  invalidateSnapshot(page);
  assert.equal(snapshotState(page).snapshotId, undefined);
  assert.throws(() => resolveTarget(page, "s1_e2"), (error) => error.code === "SNAPSHOT_REQUIRED");
});

test("one-shot snapshots strip unusable Playwright refs", () => {
  assert.equal(stripSnapshotRefs(aria), '- button "Submit"\n- iframe');
});

test("only refs present in the published snapshot are actionable", () => {
  const page = {};
  const published = publishSnapshot(page, '- button "Visible" [ref=e2]');
  assert.equal(published.refCount, 1);
  assert.equal(resolveTarget(page, "s1_e2"), "e2");
  assert.throws(() => resolveTarget(page, "s1_e3"), (error) => error.code === "INVALID_TARGET");
});
