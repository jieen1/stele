/**
 * Sanitize a string to be safe as a Python identifier.
 * Replaces non-alphanumeric characters with underscores, strips leading/trailing
 * underscores, and ensures the result does not start with a digit.
 */
export function sanitizeIdentifier(identifier: string, fallbackPrefix = "value"): string {
  const sanitized = identifier.replace(/[^A-Za-z0-9_]/g, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "");
  const withPrefix = sanitized.length === 0 ? fallbackPrefix : sanitized;
  return /^[0-9]/.test(withPrefix) ? `${fallbackPrefix}_${withPrefix}` : withPrefix;
}
