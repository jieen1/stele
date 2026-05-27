/**
 * Custom checker: validate that user.email is RFC-shaped.
 *
 * Stele calls check(steleContext) when evaluating the EMAIL_FORMAT invariant.
 * The checker reads steleContext.user.email — wired in stele_context.ts.
 */

/** Minimal pattern: at least one non-@ non-whitespace char, @, domain, dot, tld. */
const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export function check(
  steleContext: Record<string, unknown>,
  _kwargs: Record<string, unknown>,
): { passed: boolean; message: string | null } {
  const user = (steleContext["user"] ?? {}) as Record<string, unknown>;
  const email = String(user["email"] ?? "");
  if (EMAIL_PATTERN.test(email)) {
    return { passed: true, message: null };
  }
  return {
    passed: false,
    message: `Email ${JSON.stringify(email)} is not RFC-shaped (expected user@domain.tld)`,
  };
}
