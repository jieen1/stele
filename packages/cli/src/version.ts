/**
 * Single source of truth for Stele CLI version.
 *
 * Used by:
 * - index.ts (CLI --version flag)
 * - sarif.ts (SARIF tool.driver.version)
 * - formatter.ts (format version metadata)
 *
 * Derive from package.json at build time in a follow-up.
 */
export const STELE_VERSION: string = "0.1.0";
