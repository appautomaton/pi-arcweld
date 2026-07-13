import { raceAbort, throwIfAborted } from "./browser.js";

const RELEVANT_RESOURCE_TYPES = new Set(["document", "stylesheet", "script", "xhr", "fetch"]);

const DEFAULT_COMPLETION_POLICY = Object.freeze({
  observeMs: 300,
  navigationTimeoutMs: 10_000,
  requestsTimeoutMs: 3_000,
  settleMs: 200,
});

export async function waitForActionCompletion(page, operation, signal, policy = DEFAULT_COMPLETION_POLICY) {
  throwIfAborted(signal);
  const started = Date.now();
  const startUrl = page.url();
  const requests = [];
  let navigationCommitted = false;
  let resolveNavigation;
  const navigationPromise = new Promise((resolve) => { resolveNavigation = resolve; });
  const onRequest = (request) => requests.push(request);
  const onFrameNavigated = (frame) => {
    if (frame !== page.mainFrame()) return;
    navigationCommitted = true;
    resolveNavigation();
  };
  page.on("request", onRequest);
  page.on("framenavigated", onFrameNavigated);

  try {
    const result = await operation();
    await delay(policy.observeMs, signal);

    const navigation = navigationCommitted || page.url() !== startUrl || requests.some((request) => isMainFrameNavigation(page, request));
    let timedOut = false;
    let kind = "settled";

    if (navigation) {
      kind = "navigation";
      const settleNavigation = async () => {
        if (!navigationCommitted) await navigationPromise;
        await page.mainFrame().waitForLoadState("load", { timeout: policy.navigationTimeoutMs });
      };
      timedOut = await settleWithTimeout(settleNavigation(), policy.navigationTimeoutMs, signal);
    } else {
      const relevant = requests.filter((request) => RELEVANT_RESOURCE_TYPES.has(request.resourceType()));
      if (relevant.length) {
        kind = "requests";
        timedOut = await settleWithTimeout(Promise.all(relevant.map(waitForRequest)), policy.requestsTimeoutMs, signal);
        await delay(policy.settleMs, signal);
      }
    }

    return {
      result,
      completion: {
        kind,
        urlChanged: page.url() !== startUrl,
        observedRequests: requests.length,
        waitedMs: Date.now() - started,
        ...(timedOut ? { timedOut: true } : {}),
      },
    };
  } finally {
    page.off("request", onRequest);
    page.off("framenavigated", onFrameNavigated);
  }
}

async function waitForRequest(request) {
  try {
    const response = await request.response();
    await response?.finished();
  } catch {
    // Failed and aborted requests are still complete for settling purposes.
  }
}

function isMainFrameNavigation(page, request) {
  try {
    return request.isNavigationRequest() && request.frame() === page.mainFrame();
  } catch {
    return false;
  }
}

async function settleWithTimeout(promise, timeoutMs, signal) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });
  try {
    const outcome = await raceAbort(Promise.race([
      Promise.resolve(promise).then(() => "settled", () => "settled"),
      timeout,
    ]), signal);
    return outcome === "timeout";
  } finally {
    clearTimeout(timer);
  }
}

function delay(ms, signal) {
  if (ms <= 0) {
    throwIfAborted(signal);
    return Promise.resolve();
  }
  return raceAbort(new Promise((resolve) => setTimeout(resolve, ms)), signal);
}
