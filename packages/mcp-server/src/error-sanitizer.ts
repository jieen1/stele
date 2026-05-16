/**
 * Sanitize error messages for MCP tool responses.
 * Strips potentially sensitive data: file paths, PIDs, stack traces, raw error objects.
 */

/** Maximum error message length. */
const MAX_LENGTH = 512;

/** Patterns to strip from error messages. */
const SENSITIVE_PATTERNS = [
  // Stack traces
  /at\s+[^)]+\([^\)]+\)/g,
  /at\s+\S+:\d+:\d+/g,
  // File system paths (but not short identifiers)
  /(?:\/[\w.-]+){4,}/g,
  /(?:[A-Z]:\\[\w.-]+){4,}/g,
  // PIDs
  /pid\s+[0-9]+/gi,
  // ESOCKET, ECONNREFUSED with addresses
  /(?:EAI_AGAIN|ECONNREFUSED|ENOTFOUND)\s+\S+/gi,
  // Full file URLs
  /file:\/\/[\w./:-]+\n?/g,
  // Memory addresses
  /0x[0-9a-f]{8,}/gi,
];

/**
 * Sanitize an error message for safe inclusion in MCP responses.
 */
export function sanitizeError(error: unknown): string {
  let msg: string;

  if (error instanceof Error) {
    msg = error.message;
  } else if (typeof error === "string") {
    msg = error;
  } else {
    msg = String(error);
  }

  // Apply pattern filters
  for (const pattern of SENSITIVE_PATTERNS) {
    msg = msg.replace(pattern, "[redacted]");
  }

  // Truncate to max length
  if (msg.length > MAX_LENGTH) {
    msg = msg.slice(0, MAX_LENGTH) + "... (truncated)";
  }

  return msg;
}
