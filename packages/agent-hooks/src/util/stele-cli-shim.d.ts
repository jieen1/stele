/**
 * Ambient declaration for `@stele/cli` runtime entry point.
 *
 * The @stele/cli package re-exports `loadConfig` and the `SteleConfig` type
 * from its own barrel. We declare a minimal shim here so this package's
 * declaration build does not depend on the CLI's d.ts being up to date.
 *
 * See {@link "./stele-config-types"} for the local mirror of `SteleConfig`.
 */
declare module "@stele/cli" {
  import type { SteleConfig } from "./stele-config-types.js";

  /** Read and validate `stele.config.json` from `projectDir`. */
  export function loadConfig(projectDir: string): Promise<SteleConfig>;

  /** Re-export the local mirror of `SteleConfig`. */
  export type { SteleConfig };

  export const STELE_CONFIG_FILE: string;
  export const STELE_BASELINE_FILE: string;
  export const DEFAULT_CONFIG: SteleConfig;
}
