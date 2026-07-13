import { Camoufox } from "camoufox-js";
import { launchPath } from "camoufox-js/dist/pkgman.js";
import { validateBrowserRequest, validateUrl } from "./policy.js";
import { redactUrl } from "./redact.js";
import { boundedEnv } from "./env.js";

const MAX_CONCURRENCY = boundedEnv("CAMOUFOX_MCP_MAX_CONCURRENCY", 1, 1, 4);
const MAX_QUEUE = boundedEnv("CAMOUFOX_MCP_MAX_QUEUE", 8, 0, 50);
const QUEUE_TIMEOUT_MS = boundedEnv("CAMOUFOX_MCP_QUEUE_TIMEOUT_MS", 30_000, 1_000, 300_000);
const LAUNCH_TIMEOUT_MS = boundedEnv("CAMOUFOX_MCP_LAUNCH_TIMEOUT_MS", 45_000, 1_000, 300_000);
const MAX_REQUESTS = boundedEnv("CAMOUFOX_MCP_MAX_REQUESTS", 1_024, 32, 10_000);

let activeSlots = 0;
let shuttingDown = false;
const queue = [];
const activeBrowsers = new Set();
const launchingOwners = new Set();

export function browserStatus() {
  let browserPath;
  try {
    browserPath = String(launchPath());
  } catch {}
  return {
    browserAvailable: Boolean(browserPath),
    browserPath,
    activeBrowsers: activeBrowsers.size,
    queuedRequests: queue.length,
    maxConcurrency: MAX_CONCURRENCY,
    maxQueue: MAX_QUEUE,
  };
}

function abortError(reason = "Browser operation cancelled.") {
  return new DOMException(reason, "AbortError");
}

export function abortReason(signal, fallback = "Browser operation cancelled.") {
  return signal?.reason instanceof Error ? signal.reason : abortError(fallback);
}

export function throwIfAborted(signal) {
  if (signal?.aborted) throw abortReason(signal);
}

function releaseSlot() {
  activeSlots = Math.max(0, activeSlots - 1);
  while (queue.length) {
    const entry = queue.shift();
    if (entry.signal?.aborted) {
      entry.reject(abortReason(entry.signal));
      continue;
    }
    clearTimeout(entry.timer);
    entry.signal?.removeEventListener("abort", entry.onAbort);
    activeSlots += 1;
    entry.resolve(() => {
      entry.owner.browser = undefined;
      releaseSlot();
    });
    return;
  }
}

export function acquireSlot(signal, owner = {}) {
  throwIfAborted(signal);
  if (shuttingDown) return Promise.reject(new Error("Server is shutting down."));
  if (activeSlots < MAX_CONCURRENCY) {
    activeSlots += 1;
    return Promise.resolve(() => {
      owner.browser = undefined;
      releaseSlot();
    });
  }
  if (queue.length >= MAX_QUEUE) return Promise.reject(new Error("Too many queued browser requests."));

  return new Promise((resolve, reject) => {
    const entry = { resolve, reject, signal, owner, timer: undefined, onAbort: undefined };
    entry.onAbort = () => {
      const index = queue.indexOf(entry);
      if (index >= 0) queue.splice(index, 1);
      clearTimeout(entry.timer);
      reject(abortReason(signal));
    };
    entry.timer = setTimeout(() => {
      const index = queue.indexOf(entry);
      if (index >= 0) queue.splice(index, 1);
      signal?.removeEventListener("abort", entry.onAbort);
      reject(new Error("Timed out waiting for a browser slot."));
    }, QUEUE_TIMEOUT_MS);
    signal?.addEventListener("abort", entry.onAbort, { once: true });
    queue.push(entry);
  });
}

export async function raceAbort(promise, signal, onAbort) {
  throwIfAborted(signal);
  if (!signal) return promise;
  let listener;
  const aborted = new Promise((_, reject) => {
    listener = () => {
      try { onAbort?.(); } catch {}
      reject(abortReason(signal));
    };
    signal.addEventListener("abort", listener, { once: true });
  });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    signal.removeEventListener("abort", listener);
  }
}

async function launchBrowser(signal, options = {}) {
  try {
    launchPath();
  } catch {
    throw new Error("Camoufox browser binary is missing from the shared cache.");
  }

  let lateBrowser;
  const launch = Camoufox({
    os: ["linux"],
    headless: process.platform === "linux" ? "virtual" : true,
    humanize: true,
    geoip: false,
    block_webrtc: true,
    enable_cache: false,
    exclude_addons: options.allowCachedDefaultAddons ? undefined : ["UBO"],
  }).then((browser) => {
    if (signal?.aborted) void closeBrowser(browser, "cancelled during launch");
    lateBrowser = browser;
    return browser;
  });

  let timer;
  const timed = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("Browser launch timed out.")), LAUNCH_TIMEOUT_MS);
  });
  try {
    const browser = await raceAbort(Promise.race([launch, timed]), signal, () => {
      if (lateBrowser) void closeBrowser(lateBrowser, "cancelled during launch");
    });
    if (shuttingDown) {
      await closeBrowser(browser, "server shutdown");
      throw new Error("Server is shutting down.");
    }
    return browser;
  } catch (error) {
    launch.then((browser) => closeBrowser(browser, "late launch cleanup"), () => {});
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export async function closeBrowser(browser, reason = "closed") {
  if (!browser) return;
  activeBrowsers.delete(browser);
  try {
    await browser.close({ reason });
  } catch {}
}

async function installRequestGuard(context) {
  let count = 0;
  let blocked;
  const recordBlock = (rawUrl, reason) => {
    blocked ??= new Error(`Blocked unsafe browser request to ${redactUrl(rawUrl)}. ${reason}`);
  };

  await context.route("**/*", async (route) => {
    const rawUrl = route.request().url();
    if (++count > MAX_REQUESTS) {
      recordBlock(rawUrl, "Request limit exceeded.");
      await route.abort("blockedbyclient").catch(() => {});
      return;
    }
    try {
      await validateBrowserRequest(rawUrl);
      await route.continue();
    } catch (error) {
      recordBlock(rawUrl, error instanceof Error ? error.message : String(error));
      await route.abort("blockedbyclient").catch(() => {});
    }
  });

  if (typeof context.routeWebSocket === "function") {
    await context.routeWebSocket(/.*/, async (socket) => {
      const rawUrl = socket.url();
      if (++count > MAX_REQUESTS) {
        recordBlock(rawUrl, "Request limit exceeded.");
        await socket.close({ code: 1008, reason: "Blocked by server policy" }).catch(() => {});
        return;
      }
      try {
        await validateBrowserRequest(rawUrl);
        socket.connectToServer();
      } catch (error) {
        recordBlock(rawUrl, error instanceof Error ? error.message : String(error));
        await socket.close({ code: 1008, reason: "Blocked by server policy" }).catch(() => {});
      }
    });
  }

  return {
    assert() {
      if (blocked) throw blocked;
    },
  };
}

export async function assertPageSafe(page, guard) {
  guard.assert();
  const current = page.url();
  if (current !== "about:blank") await validateUrl(current);
  guard.assert();
}

export async function openBrowser(signal, { detach = false, allowCachedDefaultAddons = false } = {}) {
  const owner = {};
  const releaseSlot = await acquireSlot(signal, owner);
  launchingOwners.add(owner);
  let released = false;
  const release = () => {
    if (!released) {
      released = true;
      releaseSlot();
    }
  };
  let browser;
  let context;
  const abortClose = () => {
    if (context) void context.close({ reason: "MCP request cancelled" }).catch(() => {});
    if (browser) void closeBrowser(browser, "MCP request cancelled");
  };
  signal?.addEventListener("abort", abortClose, { once: true });

  try {
    browser = await launchBrowser(signal, { allowCachedDefaultAddons });
    owner.browser = browser;
    activeBrowsers.add(browser);
    throwIfAborted(signal);
    context = await raceAbort(browser.newContext({ serviceWorkers: "block" }), signal, abortClose);
    const guard = await installRequestGuard(context);
    const page = await raceAbort(context.newPage(), signal, abortClose);
    page.setDefaultTimeout(10_000);
    page.setDefaultNavigationTimeout(30_000);
    signal?.removeEventListener("abort", abortClose);
    if (detach && signal?.aborted) {
      await context.close({ reason: "MCP request cancelled" }).catch(() => {});
      await closeBrowser(browser, "MCP request cancelled");
      throw abortReason(signal);
    }
    launchingOwners.delete(owner);
    return { browser, context, page, guard, release };
  } catch (error) {
    signal?.removeEventListener("abort", abortClose);
    if (context) await context.close({ reason: "browser setup failed" }).catch(() => {});
    if (browser) await closeBrowser(browser, "browser setup failed");
    launchingOwners.delete(owner);
    release();
    throw error;
  }
}

export async function withBrowser(signal, operation) {
  const resources = await openBrowser(signal);
  const abortClose = () => {
    void resources.context.close({ reason: "MCP request cancelled" }).catch(() => {});
    void closeBrowser(resources.browser, "MCP request cancelled");
  };
  signal?.addEventListener("abort", abortClose, { once: true });
  try {
    return await operation(resources);
  } finally {
    signal?.removeEventListener("abort", abortClose);
    await resources.context.close({ reason: "operation complete" }).catch(() => {});
    await closeBrowser(resources.browser);
    resources.release();
  }
}

export async function shutdownBrowsers() {
  shuttingDown = true;
  for (const entry of queue.splice(0)) {
    clearTimeout(entry.timer);
    entry.signal?.removeEventListener("abort", entry.onAbort);
    entry.reject(new Error("Server is shutting down."));
  }
  await Promise.allSettled([...activeBrowsers].map((browser) => closeBrowser(browser, "server shutdown")));
  const deadline = Date.now() + LAUNCH_TIMEOUT_MS;
  while (activeSlots > 0 && Date.now() < deadline) {
    for (const owner of launchingOwners) {
      if (owner.browser) void closeBrowser(owner.browser, "server shutdown");
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
