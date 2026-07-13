import test from "node:test";
import assert from "node:assert/strict";
import { failure, normalizeEnvelope, SCHEMA_VERSION, success, ToolError } from "../src/response.js";

test("success returns matching pretty text and structured content", () => {
  const result = success("example", {
    sessionId: "sess_1",
    expiresAt: "2030-01-01T00:00:00.000Z",
    url: "https://example.com/",
    title: "Example",
    status: 200,
    extra: true,
  });
  assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
  assert.match(result.content[0].text, /\n  \"schemaVersion\"/);
  assert.equal(result.structuredContent.schemaVersion, SCHEMA_VERSION);
  assert.equal(SCHEMA_VERSION, "2");
  assert.equal(result.structuredContent.ok, true);
  assert.equal(result.structuredContent.operation, "example");
  assert.deepEqual(result.structuredContent.session, { id: "sess_1", expiresAt: "2030-01-01T00:00:00.000Z" });
  assert.deepEqual(result.structuredContent.page, { url: "https://example.com/", title: "Example", status: 200 });
  assert.equal(result.structuredContent.extra, true);
});

test("normalizes nested snapshot page summaries", () => {
  const result = normalizeEnvelope({
    schemaVersion: SCHEMA_VERSION,
    ok: true,
    operation: "action",
    snapshot: { url: "https://example.com/next", title: "Next" },
  });
  assert.deepEqual(result.page, { url: "https://example.com/next", title: "Next" });
});

test("structured failures retain stable codes and pretty multi-line output", () => {
  const result = failure("act", new ToolError("STALE_TARGET", "Target is stale at https://example.com/path?token=secret", {
    retryable: true,
    suggestion: "Capture a fresh snapshot.",
  }));
  assert.equal(result.isError, true);
  assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
  assert.match(result.content[0].text, /\n  \"error\"/);
  assert.equal(result.structuredContent.ok, false);
  assert.equal(result.structuredContent.error.code, "STALE_TARGET");
  assert.equal(result.structuredContent.error.retryable, true);
  assert.doesNotMatch(result.structuredContent.error.message, /secret/);
  assert.match(result.structuredContent.error.message, /\?\.\.\./);
});

test("compact action payload remains below the generic Pi guard", () => {
  const result = success("browse_session_action", {
    actions: [{ index: 0, type: "click", status: "ok", completion: { kind: "navigation", observedRequests: 10, waitedMs: 500 } }],
    snapshot: {
      detail: "compact",
      url: "https://example.com/next",
      title: "Next",
      ariaSnapshot: "x".repeat(12_000),
      ariaTruncated: true,
      snapshotId: "s2",
      refCount: 50,
      referenceScope: "session",
      omitted: ["text", "elements"],
    },
  });
  assert.ok(Buffer.byteLength(result.content[0].text) < 50 * 1024);
});
