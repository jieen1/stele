/**
 * Sanitize error messages for MCP tool responses.
 * Strips potentially sensitive data: file paths, PIDs, stack traces, raw error objects.
 */

/** Maximum error message length. */
const MAX_LENGTH = 512;

/**
 * Sanitize an error message for safe inclusion in MCP responses.
 * Recursively sanitizes error.cause chains.
 */
export function sanitizeError(error: unknown): string {
  let parts: string[] = [];

  if (error instanceof Error) {
    parts.push(sanitizeString(error.message));

    // Recursively sanitize error.cause
    if (error.cause !== undefined) {
      const causeMsg = sanitizeError(error.cause);
      if (causeMsg && causeMsg !== error.message) {
        parts.push(`cause: ${causeMsg}`);
      }
    }
  } else if (typeof error === "string") {
    parts.push(sanitizeString(error));
  } else {
    parts.push(sanitizeString(String(error)));
  }

  const msg = parts.join(": ");

  // Truncate to max length
  if (msg.length > MAX_LENGTH) {
    return msg.slice(0, MAX_LENGTH) + "... (truncated)";
  }

  return msg;
}

/**
 * Sanitize a single error string by stripping sensitive patterns.
 */
function sanitizeString(msg: string): string {
  // Stack traces
  msg = msg.replace(/at\s+[^)]+\([^\)]+\)/g, "[redacted]");
  msg = msg.replace(/at\s+\S+:\d+:\d+/g, "[redacted]");

  // URLs with credentials (must run before path redaction to preserve credential marker)
  msg = msg.replace(/(\w+:\/\/)(\S+:\S+@)/g, "$1[credentials]@");

  // File system paths (at least 2 segments to avoid matching URL paths)
  msg = msg.replace(/\/(?:[\w.-]+\/){1,}[\w.-]+/g, "[path]");
  msg = msg.replace(/[A-Z]:\\(?:[\w.-]+\\){1,}[\w.-]+/g, "[path]");

  // PIDs
  msg = msg.replace(/\bpid\s+[0-9]+/gi, "pid [redacted]");

  // Network errors with addresses
  msg = msg.replace(/\b(?:EAI_AGAIN|ECONNREFUSED|ENOTFOUND)\s+\S+/gi, "$& [redacted]");

  // Environment variables (common patterns)
  msg = msg.replace(/\b(?:API_KEY|TOKEN|SECRET|PASSWORD|PRIVATE_KEY|CREDENTIAL)\s*[=:]\s*\S+/gi, "$& [redacted]");

  // Memory addresses
  msg = msg.replace(/\b0x[0-9a-f]{8,}\b/gi, "0x[redacted]");

  // URLs with credentials
  msg = msg.replace(/(\w+:\/\/)(\S+:\S+@)/g, "$1[credentials]@");

  // Email addresses (privacy)
  msg = msg.replace(/\b[\w.-]+@[\w.-]+\.\w+\b/g, "[email]");

  return msg;
}
