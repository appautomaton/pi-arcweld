import { randomUUID } from "node:crypto";
import { abortReason, assertPageSafe, closeBrowser, openBrowser, raceAbort, throwIfAborted } from "./browser.js";
import { redactUrl } from "./redact.js";
import { boundedEnv } from "./env.js";
import { validateUrl } from "./policy.js";
import { pageSnapshot } from "./snapshot.js";
import { captureScreenshot } from "./screenshot.js";
import { runActions } from "./actions.js";
import { invalidateSnapshot } from "./snapshot-state.js";

const MAX_SESSIONS = boundedEnv("CAMOUFOX_MCP_MAX_SESSIONS", 1, 1, 4);
const SESSION_TTL_MS = boundedEnv("CAMOUFOX_MCP_SESSION_TTL_MS", 600_000, 60_000, 900_000);
const sessions = new Map();
let reserved = 0;

export function sessionStatus() {
  return { activeSessions: sessions.size, maxSessions: MAX_SESSIONS, sessionTtlMs: SESSION_TTL_MS };
}

function touch(session) {
  clearTimeout(session.timer);
  session.expiresAt = Date.now() + SESSION_TTL_MS;
  session.timer = setTimeout(() => void closeSession(session.id, "expired"), SESSION_TTL_MS);
}

function expiresAt(session) {
  return new Date(session.expiresAt).toISOString();
}

async function getSession(id) {
  const session = sessions.get(id);
  if (!session) throw new Error(`Unknown or closed session: ${id}`);
  if (Date.now() > session.expiresAt) {
    await closeSession(id, "expired");
    throw new Error(`Session expired: ${id}`);
  }
  touch(session);
  return session;
}

async function exclusive(session, signal, operation) {
  throwIfAborted(signal);
  const run = session.chain.catch(() => {}).then(async () => {
    throwIfAborted(signal);
    if (session.closed) throw new Error(`Session is closed: ${session.id}`);
    const onAbort = () => void closeSession(session.id, "cancelled");
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      return await operation();
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  });
  session.chain = run.then(() => {}, () => {});
  return run;
}

export async function startSession(signal) {
  if (reserved >= MAX_SESSIONS) throw new Error(`Too many active sessions. Maximum is ${MAX_SESSIONS}.`);
  reserved += 1;
  let cancelled = false;
  const onAbort = () => { cancelled = true; };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const { browser, context, page, guard, release } = await openBrowser(signal, { detach: true });
    if (cancelled || signal?.aborted) {
      await context.close({ reason: "MCP request cancelled" }).catch(() => {});
      await closeBrowser(browser, "MCP request cancelled");
      release();
      throw abortReason(signal);
    }
    const id = `sess_${randomUUID()}`;
    const session = {
      id,
      browser,
      context,
      page,
      guard,
      release,
      chain: Promise.resolve(),
      expiresAt: Date.now() + SESSION_TTL_MS,
      timer: undefined,
      closed: false,
    };
    session.timer = setTimeout(() => void closeSession(id, "expired"), SESSION_TTL_MS);
    sessions.set(id, session);
    return { sessionId: id, expiresAt: expiresAt(session) };
  } catch (error) {
    reserved = Math.max(0, reserved - 1);
    throw error;
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}

export async function navigateSession(input, signal) {
  const session = await getSession(input.sessionId);
  return exclusive(session, signal, async () => {
    invalidateSnapshot(session.page);
    const target = await validateUrl(input.url);
    const response = await raceAbort(session.page.goto(target.toString(), {
      waitUntil: input.waitUntil ?? "domcontentloaded",
      timeout: input.timeout ?? 30_000,
    }), signal, () => void closeSession(session.id, "cancelled during navigation"));
    await assertPageSafe(session.page, session.guard);
    return {
      sessionId: session.id,
      expiresAt: expiresAt(session),
      status: response?.status(),
      ...(await pageSnapshot(session.page, input, signal, { actionableRefs: true, defaultDetail: "compact" })),
    };
  });
}

export async function snapshotSession(input, signal) {
  const session = await getSession(input.sessionId);
  return exclusive(session, signal, async () => ({
    sessionId: session.id,
    expiresAt: expiresAt(session),
    ...(await pageSnapshot(session.page, input, signal, { actionableRefs: true, defaultDetail: "full" })),
  }));
}

export async function actSession(input, signal) {
  const session = await getSession(input.sessionId);
  return exclusive(session, signal, async () => {
    const actions = await runActions(session.page, session.guard, input.actions, signal, { allowTargets: true });
    return {
      sessionId: session.id,
      expiresAt: expiresAt(session),
      actions,
      snapshot: await pageSnapshot(session.page, input, signal, { actionableRefs: true, defaultDetail: "compact" }),
    };
  });
}

export async function screenshotSession(input, signal) {
  const session = await getSession(input.sessionId);
  return exclusive(session, signal, async () => {
    await assertPageSafe(session.page, session.guard);
    const { buffer, mimeType, bytes } = await captureScreenshot(session.page, input, signal);
    return {
      payload: { sessionId: session.id, expiresAt: expiresAt(session), url: redactUrl(session.page.url()), title: await session.page.title(), bytes },
      image: { data: buffer.toString("base64"), mimeType },
    };
  });
}

export async function closeSession(id, reason = "requested") {
  const session = sessions.get(id);
  if (!session || session.closed) return false;
  session.closed = true;
  sessions.delete(id);
  clearTimeout(session.timer);
  invalidateSnapshot(session.page);
  await session.context.close({ reason }).catch(() => {});
  await closeBrowser(session.browser, reason);
  session.release();
  reserved = Math.max(0, reserved - 1);
  return true;
}

export async function closeAllSessions() {
  await Promise.allSettled([...sessions.keys()].map((id) => closeSession(id, "server shutdown")));
}
