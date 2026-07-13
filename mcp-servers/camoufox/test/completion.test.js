import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { waitForActionCompletion } from "../src/completion.js";

class FakePage extends EventEmitter {
  constructor(url = "https://example.com/") {
    super();
    this.currentUrl = url;
    this.load = Promise.resolve();
    this.frame = { waitForLoadState: () => this.load };
  }
  url() { return this.currentUrl; }
  mainFrame() { return this.frame; }
}

function request({ type = "fetch", navigation = false, frame, response = Promise.resolve({ finished: () => Promise.resolve() }) } = {}) {
  return {
    resourceType: () => type,
    isNavigationRequest: () => navigation,
    frame: () => frame,
    response: () => response,
  };
}

const fast = { observeMs: 0, navigationTimeoutMs: 20, requestsTimeoutMs: 20, settleMs: 0 };

test("reports settled actions and removes listeners", async () => {
  const page = new FakePage();
  const result = await waitForActionCompletion(page, async () => "ok", undefined, fast);
  assert.equal(result.result, "ok");
  assert.deepEqual(result.completion.kind, "settled");
  assert.equal(result.completion.observedRequests, 0);
  assert.equal(page.listenerCount("request"), 0);
});

test("waits for relevant requests but ignores irrelevant resources", async () => {
  const page = new FakePage();
  let finished = false;
  const result = await waitForActionCompletion(page, async () => {
    page.emit("request", request({ type: "image" }));
    page.emit("request", request({ type: "fetch", response: Promise.resolve({ finished: async () => { finished = true; } }) }));
  }, undefined, fast);
  assert.equal(result.completion.kind, "requests");
  assert.equal(result.completion.observedRequests, 2);
  assert.equal(finished, true);
  assert.equal(page.listenerCount("request"), 0);
});

test("detects main-frame navigation and URL changes", async () => {
  const page = new FakePage();
  const result = await waitForActionCompletion(page, async () => {
    page.emit("request", request({ type: "document", navigation: true, frame: page.mainFrame() }));
    page.currentUrl = "https://example.com/next";
    page.emit("framenavigated", page.mainFrame());
  }, undefined, fast);
  assert.equal(result.completion.kind, "navigation");
  assert.equal(result.completion.urlChanged, true);
  assert.equal(result.completion.timedOut, undefined);
});

test("reports bounded completion timeout without failing a successful action", async () => {
  const page = new FakePage();
  page.load = new Promise(() => {});
  const result = await waitForActionCompletion(page, async () => {
    page.emit("request", request({ type: "document", navigation: true, frame: page.mainFrame() }));
    page.emit("framenavigated", page.mainFrame());
  }, undefined, fast);
  assert.equal(result.completion.kind, "navigation");
  assert.equal(result.completion.timedOut, true);
  assert.equal(page.listenerCount("request"), 0);
});

test("cancellation rejects promptly and cleans listeners", async () => {
  const page = new FakePage();
  const controller = new AbortController();
  const call = waitForActionCompletion(page, async () => {
    page.emit("request", request({ type: "fetch", response: new Promise(() => {}) }));
    controller.abort(new Error("stop completion"));
  }, controller.signal, fast);
  await assert.rejects(call, /stop completion/);
  assert.equal(page.listenerCount("request"), 0);
});
