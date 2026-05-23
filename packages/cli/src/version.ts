/**
 * Single source of truth for Stele CLI version.
 *
 * Used by:
 * - index.ts (CLI --version flag)
 * - sarif.ts (SARIF tool.driver.version)
 * - formatter.ts (format version metadata)
 *
 * Round 4 F-C-05: derived from package.json at module load. Read via
 * createRequire so it works under native ESM without a build step. The
 * `inline_version_sync` self-protection invariant asserts this stays in
 * lockstep with packages/cli/package.json.
 */
import { createRequire } from "node:module";

const _require = createRequire(import.meta.url);
const _pkg = _require("../package.json") as { version?: string };
export const STELE_VERSION: string =
  typeof _pkg.version === "string" && _pkg.version.length > 0 ? _pkg.version : "0.1.0";
