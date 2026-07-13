import { z } from "zod";
import { redactUrl } from "./redact.js";

export const SCHEMA_VERSION = "2";

export const commonOutputSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  ok: z.boolean(),
  operation: z.string(),
  page: z.object({
    url: z.string(),
    title: z.string(),
    status: z.number().int().optional(),
  }).optional(),
  session: z.object({
    id: z.string(),
    expiresAt: z.string().optional(),
  }).optional(),
  error: z.object({
    code: z.string(),
    message: z.string(),
    retryable: z.boolean(),
    suggestion: z.string().optional(),
  }).optional(),
}).loose();

export class ToolError extends Error {
  constructor(code, message, { retryable = false, suggestion } = {}) {
    super(message);
    this.name = "ToolError";
    this.code = code;
    this.retryable = retryable;
    this.suggestion = suggestion;
  }
}

export function success(operation, payload = {}, image) {
  const structuredContent = normalizeEnvelope({
    schemaVersion: SCHEMA_VERSION,
    ok: true,
    operation,
    ...payload,
  });
  if (image) {
    structuredContent.image = {
      mimeType: image.mimeType,
      bytes: Buffer.from(image.data, "base64").length,
    };
  }
  const content = [{ type: "text", text: JSON.stringify(structuredContent, null, 2) }];
  if (image) content.push({ type: "image", data: image.data, mimeType: image.mimeType });
  return { content, structuredContent };
}

export function failure(operation, error) {
  const details = errorDetails(error);
  const structuredContent = {
    schemaVersion: SCHEMA_VERSION,
    ok: false,
    operation,
    error: details,
  };
  return {
    content: [{ type: "text", text: JSON.stringify(structuredContent, null, 2) }],
    structuredContent,
    isError: true,
  };
}

export async function executeTool(operation, handler) {
  try {
    return await handler();
  } catch (error) {
    return failure(operation, error);
  }
}

export function normalizeEnvelope(payload) {
  const normalized = { ...payload };
  if (!normalized.session && typeof normalized.sessionId === "string") {
    normalized.session = compact({
      id: normalized.sessionId,
      expiresAt: typeof normalized.expiresAt === "string" ? normalized.expiresAt : undefined,
    });
  }

  if (!normalized.page) {
    const snapshot = object(normalized.snapshot);
    const pageSource = snapshot && typeof snapshot.url === "string" ? snapshot : normalized;
    if (typeof pageSource.url === "string" && typeof pageSource.title === "string") {
      normalized.page = compact({
        url: pageSource.url,
        title: pageSource.title,
        status: integer(normalized.status) ?? integer(normalized.initialStatus) ?? integer(pageSource.status),
      });
    }
  }
  return normalized;
}

export function errorDetails(error) {
  if (error instanceof ToolError) {
    return compact({
      code: error.code,
      message: sanitizeErrorMessage(error.message),
      retryable: error.retryable,
      suggestion: error.suggestion,
    });
  }
  if (error instanceof DOMException && error.name === "AbortError") {
    return {
      code: "CANCELLED",
      message: "Browser operation cancelled.",
      retryable: true,
      suggestion: "Retry the operation if it is still needed.",
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  return {
    code: "BROWSER_OPERATION_FAILED",
    message: sanitizeErrorMessage(message),
    retryable: false,
  };
}

function sanitizeErrorMessage(message) {
  return message.replace(/https?:\/\/[^\s"'<>]+/gi, redactUrl);
}

function compact(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

function integer(value) {
  return Number.isInteger(value) ? value : undefined;
}

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}
