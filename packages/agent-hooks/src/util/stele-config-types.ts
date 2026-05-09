/**
 * Local mirror of `@stele/cli`'s `SteleConfig` shape. Defined here so the
 * agent-hooks package can be type-checked and emit declarations without
 * waiting for the CLI's dts build to publish. The CLI is the source of
 * truth at runtime — see {@link loadSteleConfig}.
 *
 * This file MUST stay structurally compatible with
 * `packages/cli/src/config/defaults.ts`. If a field is added there, mirror
 * it here.
 */
export interface SteleConfig {
  version: string;
  contractDir: string;
  entry: string;
  generatedDir: string;
  checkerImplDir: string;
  manifestPath: string;
  targetLanguage: string;
  testFramework: string;
  pathMode: string;
  protected: string[];
}
