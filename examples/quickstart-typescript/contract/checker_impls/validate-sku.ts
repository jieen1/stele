/**
 * Custom checker: validate that all item SKUs match the expected format.
 *
 * Stele calls check(steleContext) when evaluating the SKU_FORMAT invariant.
 * The checker reads steleContext.items — a flat list of item objects wired
 * in tests/contract/stele_context.ts.
 */

/** SKU format: one or more uppercase letters, a dash, then alphanumerics. */
const SKU_PATTERN = /^[A-Z]+-[A-Z0-9]+$/;

export function check(
  steleContext: Record<string, unknown>,
  _kwargs: Record<string, unknown>,
): { passed: boolean; message: string | null } {
  const items = Array.isArray(steleContext["items"])
    ? (steleContext["items"] as Record<string, unknown>[])
    : [];
  for (const item of items) {
    const sku = String(item["sku"] ?? "");
    if (!SKU_PATTERN.test(sku)) {
      return {
        passed: false,
        message: `SKU ${JSON.stringify(sku)} does not match ^[A-Z]+-[A-Z0-9]+$`,
      };
    }
  }
  return { passed: true, message: null };
}
