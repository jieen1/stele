import type { Contract, GeneratedVerificationResult } from "@stele/core";
import type { SteleConfig } from "../config/defaults.js";

export type CheckSummary = {
  invariantCount: number;
  generatedFileCount: number;
  protectedFileCount: number;
};

export type PreparedCheckContext = {
  projectDir: string;
  config: SteleConfig;
  contract: Contract;
  generated: GeneratedVerificationResult;
  invariantCount: number;
  /**
   * Optional override for the contract used by the code-shape stage. Set by
   * `checkProject` when `--diff` is active so code-shape only re-evaluates
   * changed files while other stages still see the full contract. When
   * undefined, code-shape uses `contract`.
   */
  codeShapeContract?: Contract;
};

export type ProtectedCheckState = {
  protectedPaths: string[];
  contractHash: string;
  summary: CheckSummary;
};
