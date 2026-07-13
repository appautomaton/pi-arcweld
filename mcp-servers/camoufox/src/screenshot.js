import { raceAbort } from "./browser.js";

export const MAX_SCREENSHOT_BYTES = 5 * 1024 * 1024;
export const SCREENSHOT_TIMEOUT_MS = 10_000;

export async function captureScreenshot(page, input, signal) {
  const type = input.type ?? "png";
  const quality = type === "jpeg" ? input.quality : undefined;
  const buffer = await raceAbort(input.selector
    ? page.locator(input.selector).first().screenshot({ type, quality, timeout: SCREENSHOT_TIMEOUT_MS })
    : page.screenshot({ type, quality, fullPage: Boolean(input.fullPage) }), signal);
  if (buffer.length > MAX_SCREENSHOT_BYTES) throw new Error(`Screenshot exceeds ${MAX_SCREENSHOT_BYTES} bytes.`);
  return { buffer, type, mimeType: type === "jpeg" ? "image/jpeg" : "image/png", bytes: buffer.length };
}
