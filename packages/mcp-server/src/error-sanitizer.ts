/**
 * Sanitize error messages for MCP tool responses.
 * Strips potentially sensitive data: file paths, PIDs, stack traces, raw error objects.
 */

/** Maximum error message length. */
const MAX_LENGTH = 512;

/** Maximum recursion depth for error.cause chains. */
const MAX_CAUSE_DEPTH = 10;

/**
 * Sanitize an error message for safe inclusion in MCP responses.
 * Recursively sanitizes error.cause chains with depth guard.
 */
export function sanitizeError(error: unknown, depth = 0): string {
  if (depth > MAX_CAUSE_DEPTH) {
    return "... (max cause chain depth exceeded)";
  }

  let parts: string[] = [];

  if (error instanceof Error) {
    parts.push(sanitizeString(error.message));

    // Recursively sanitize error.cause
    if (error.cause !== undefined) {
      const causeMsg = sanitizeError(error.cause, depth + 1);
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

  // Environment variables (common patterns) — must run before path redaction
  // to avoid path regex partially consuming credential values
  msg = msg.replace(/\b(?:API_KEY|TOKEN|SECRET|PASSWORD|PRIVATE_KEY|CREDENTIAL|AUTH_DATA|ACCESS_KEY|SECRET_KEY|CREDENTIAL)\s*[=:]\s*\S+/gi, "[env-credential]");

  // Bearer tokens and authorization headers
  msg = msg.replace(/\b(Bearer|bearer|Authorization)\s+\S+/gi, "[authorization]");

  // JWT-like tokens (3 base64 segments separated by dots)
  msg = msg.replace(/\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[jwt]");

  // SSH private key headers
  msg = msg.replace(/-----BEGIN\s+(RSA|EC|DSA|OPENSSH)\s+PRIVATE\s+KEY-----.*?-----END\s+(RSA|EC|DSA|OPENSSH)\s+PRIVATE\s+KEY-----/gs, "[private-key]");

  // URLs with credentials (must run before path redaction to preserve credential marker)
  msg = msg.replace(/(\w+:\/\/)(\S+:\S+@)/g, "$1[credentials]@");

  // Generic secret patterns (sk-, xoxb-, ghp_ prefixes)
  msg = msg.replace(/\b(?:sk-|xoxb-|ghp_|gho_|ghs_|ghu_|ghr_)[A-Za-z0-9_-]{8,}/g, "[secret]");

  // File system paths (at least 2 segments to avoid matching URL paths)
  msg = msg.replace(/\/(?:[\w.-]+\/){1,}[\w.-]+/g, "[path]");
  msg = msg.replace(/[A-Z]:\\(?:[\w.-]+\\){1,}[\w.-]+/g, "[path]");

  // PIDs
  msg = msg.replace(/\bpid\s+[0-9]+/gi, "pid [redacted]");

  // Network errors with addresses
  msg = msg.replace(/\b(?:EAI_AGAIN|ECONNREFUSED|ENOTFOUND)\s+\S+/gi, "[network-error]");

  // Memory addresses
  msg = msg.replace(/\b0x[0-9a-f]{8,}\b/gi, "0x[redacted]");

  // Email addresses (privacy)
  msg = msg.replace(/\b[\w.-]+@[\w.-]+\.\w+\b/g, "[email]");

  return msg;
}
