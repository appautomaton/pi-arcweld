import { assertPageSafe, raceAbort, throwIfAborted } from "./browser.js";
import { waitForActionCompletion } from "./completion.js";
import { ToolError } from "./response.js";
import { resolveTarget } from "./snapshot-state.js";

export const MAX_ACTIONS = 25;
const ACTION_TIMEOUT_MS = 10_000;
const TARGET_NOT_FOUND_SUGGESTION = "Capture a fresh session snapshot and retry with one of its targets.";

function locatorFor(page, action, { allowTargets = false } = {}) {
  if (action.target) {
    if (!allowTargets) throw new ToolError("INVALID_TARGET", "Snapshot targets are only supported by persistent-session actions.");
    if (action.frame) throw new ToolError("INVALID_TARGET", "The frame field cannot be combined with a snapshot target.", { retryable: true, suggestion: TARGET_NOT_FOUND_SUGGESTION });
    const internalRef = resolveTarget(page, action.target);
    return page.locator(`aria-ref=${internalRef}`).first();
  }
  return action.frame
    ? page.frameLocator(action.frame).locator(action.selector).first()
    : page.locator(action.selector).first();
}

async function actionResult(page, action, index, run, signal) {
  const started = Date.now();
  let completed;
  try {
    completed = await waitForActionCompletion(page, () => raceAbort(run(), signal), signal);
  } catch (error) {
    if (action.target && isMissingTargetError(error)) {
      throw new ToolError("TARGET_NOT_FOUND", `Target ${action.target} is no longer available on the page.`, {
        retryable: true,
        suggestion: TARGET_NOT_FOUND_SUGGESTION,
      });
    }
    throw error;
  }
  return {
    index,
    type: action.type,
    target: action.target,
    selector: action.selector,
    status: "ok",
    durationMs: Date.now() - started,
    completion: completed.completion,
  };
}

export async function runActions(page, guard, actions, signal, { allowTargets = false } = {}) {
  if (actions.length > MAX_ACTIONS) throw new Error(`At most ${MAX_ACTIONS} actions are allowed per call.`);
  const results = [];

  for (let index = 0; index < actions.length; index += 1) {
    throwIfAborted(signal);
    const action = actions[index];
    const timeout = action.timeout ?? ACTION_TIMEOUT_MS;
    let result;

    switch (action.type) {
      case "click":
        result = await actionResult(page, action, index, () => locatorFor(page, action, { allowTargets }).click({ timeout, noWaitAfter: true }), signal);
        break;
      case "fill":
        result = await actionResult(page, action, index, () => locatorFor(page, action, { allowTargets }).fill(action.value, { timeout }), signal);
        break;
      case "type":
        result = await actionResult(page, action, index, () => locatorFor(page, action, { allowTargets }).pressSequentially(action.text, { timeout, delay: action.delay ?? 25 }), signal);
        break;
      case "press":
        result = await actionResult(page, action, index, () => action.selector || action.target
          ? locatorFor(page, action, { allowTargets }).press(action.key, { timeout, noWaitAfter: true })
          : page.keyboard.press(action.key, { delay: action.delay }), signal);
        break;
      case "select":
        result = await actionResult(page, action, index, () => locatorFor(page, action, { allowTargets }).selectOption(action.value, { timeout }), signal);
        break;
      case "hover":
        result = await actionResult(page, action, index, () => locatorFor(page, action, { allowTargets }).hover({ timeout }), signal);
        break;
      case "wait":
        result = await actionResult(page, action, index, () => action.selector || action.target
          ? locatorFor(page, action, { allowTargets }).waitFor({ state: action.state ?? "visible", timeout })
          : page.waitForTimeout(Math.min(action.ms ?? 500, timeout)), signal);
        break;
      case "scroll":
        result = await actionResult(page, action, index, () => action.selector || action.target
          ? locatorFor(page, action, { allowTargets }).evaluate((element, delta) => element.scrollBy(delta.x, delta.y), { x: action.x ?? 0, y: action.y ?? 500 })
          : page.mouse.wheel(action.x ?? 0, action.y ?? 500), signal);
        break;
      default:
        throw new Error(`Unsupported action type: ${action.type}`);
    }

    results.push(result);
    await assertPageSafe(page, guard);
  }

  return results;
}

function isMissingTargetError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /not found|no element|waiting for locator|resolved to 0|detached/i.test(message);
}
