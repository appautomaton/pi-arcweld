import { raceAbort, throwIfAborted } from "./browser.js";
import { redactUrl } from "./redact.js";
import { publishSnapshot, stripSnapshotRefs } from "./snapshot-state.js";

const DEFAULT_FULL_MAX_CHARS = 30_000;
const DEFAULT_COMPACT_MAX_CHARS = 12_000;
const MAX_MAX_CHARS = 100_000;
const DEFAULT_MAX_ELEMENTS = 100;
const MAX_MAX_ELEMENTS = 300;

function clamp(value, fallback, max) {
  return Math.min(max, Math.max(1, value ?? fallback));
}

function truncate(value, limit) {
  return { value: value.slice(0, limit), truncated: value.length > limit };
}

export async function pageSnapshot(page, options = {}, signal, { actionableRefs = false, defaultDetail = "full" } = {}) {
  throwIfAborted(signal);
  const detail = options.detail ?? defaultDetail;
  const maxChars = clamp(options.maxChars, detail === "compact" ? DEFAULT_COMPACT_MAX_CHARS : DEFAULT_FULL_MAX_CHARS, MAX_MAX_CHARS);
  const maxElements = clamp(options.maxElements, DEFAULT_MAX_ELEMENTS, MAX_MAX_ELEMENTS);
  const root = options.selector ? page.locator(options.selector).first() : page.locator("body");
  if (options.selector && await raceAbort(root.count(), signal) === 0) {
    throw new Error(`Snapshot selector not found: ${options.selector}`);
  }

  const [title, rawAria] = await Promise.all([
    raceAbort(page.title(), signal),
    raceAbort(root.ariaSnapshot({ mode: "ai", depth: 12, timeout: 10_000 }), signal),
  ]);
  const boundedRawAria = truncate(rawAria, maxChars);
  const reference = actionableRefs
    ? publishSnapshot(page, boundedRawAria.value, maxChars)
    : { ariaSnapshot: stripSnapshotRefs(boundedRawAria.value), referenceScope: "none", refCount: 0 };

  const snapshot = {
    detail,
    url: redactUrl(page.url()),
    title,
    ariaSnapshot: reference.ariaSnapshot,
    ariaTruncated: boundedRawAria.truncated,
    snapshotId: reference.snapshotId,
    refCount: reference.refCount,
    referenceScope: reference.referenceScope,
    selector: options.selector,
  };
  if (detail === "compact") return { ...snapshot, omitted: ["text", "elements"] };

  const [boundedText, elements] = await Promise.all([
    raceAbort(root.evaluate((element, limit) => {
      const text = element.innerText ?? element.textContent ?? "";
      return { value: text.slice(0, limit), truncated: text.length > limit };
    }, maxChars), signal),
    raceAbort(root.locator("a,button,input,textarea,select,[role='button'],[role='link'],[role='checkbox'],[role='radio'],[contenteditable='true']").evaluateAll((nodes, limit) => nodes.slice(0, limit).map((element, index) => {
      const node = element;
      const label = node.getAttribute("aria-label")
        || node.getAttribute("title")
        || node.getAttribute("placeholder")
        || node.innerText
        || node.getAttribute("value")
        || node.getAttribute("name")
        || "";
      return {
        index,
        tag: node.tagName.toLowerCase(),
        role: node.getAttribute("role") || undefined,
        type: node.getAttribute("type") || undefined,
        label: label.trim().slice(0, 300) || undefined,
        href: node instanceof HTMLAnchorElement ? node.href : undefined,
        name: node.getAttribute("name") || undefined,
        disabled: "disabled" in node ? Boolean(node.disabled) : undefined,
      };
    }), maxElements), signal),
  ]);

  return {
    ...snapshot,
    text: boundedText.value,
    textTruncated: boundedText.truncated,
    elements: elements.map((element) => ({
      ...element,
      href: element.href ? redactUrl(element.href) : undefined,
    })),
    elementsTruncated: elements.length === maxElements,
  };
}
