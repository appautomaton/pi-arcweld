import assert from "node:assert/strict";
import test from "node:test";
import {
	boundPayload,
	childToolNames,
	fallbackPayload,
	MAX_LIST_ITEMS,
	MAX_SUMMARY_BYTES,
	normalizeWorkTools,
	prepareDelegateParams,
	prepareDelegateResult,
} from "../types.ts";

test("childToolNames always includes delegate_result and gates nested delegate on depth", () => {
	assert.deepEqual(childToolNames(["read"], 1).sort(), ["delegate", "delegate_result", "read"].sort());
	assert.deepEqual(childToolNames(["read"], 2).sort(), ["delegate_result", "read"].sort());
});

test("normalizeWorkTools defaults to read-only and rejects unknown names", () => {
	assert.deepEqual(normalizeWorkTools(undefined), ["read", "grep", "find", "ls"]);
	assert.deepEqual(normalizeWorkTools(["bash", "read"]), ["bash", "read"]);
	assert.throws(() => normalizeWorkTools(["read", "mcp_call"]), /Unknown work tool/);
});

test("boundPayload truncates summary and caps lists", () => {
	const payload = boundPayload({
		status: "done",
		summary: "x".repeat(MAX_SUMMARY_BYTES + 50),
		evidence: Array.from({ length: MAX_LIST_ITEMS + 5 }, (_, i) => `e${i}`),
		artifacts: Array.from({ length: MAX_LIST_ITEMS + 1 }, (_, i) => `a${i}`),
		open_questions: [],
	});
	assert.ok(payload.summary.length <= MAX_SUMMARY_BYTES);
	assert.equal(payload.evidence.length, MAX_LIST_ITEMS);
	assert.equal(payload.artifacts.length, MAX_LIST_ITEMS);
});

test("fallbackPayload fills a needs_review contract", () => {
	const payload = fallbackPayload("needs_review", "  hello  ");
	assert.equal(payload.status, "needs_review");
	assert.equal(payload.summary, "hello");
});

test("prepareArguments shims keep a resume-safe shape", () => {
	assert.deepEqual(prepareDelegateParams({ to: "flash", task: "scan", extra: true }), {
		to: "flash",
		task: "scan",
		scope: "",
		done_when: "",
	});
	const result = prepareDelegateResult({ status: "done", summary: "ok" });
	assert.equal(result.status, "done");
	assert.equal(result.summary, "ok");
	assert.deepEqual(result.evidence, []);
});
