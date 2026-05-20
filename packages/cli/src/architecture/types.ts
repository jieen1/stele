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
};

export type ProtectedCheckState = {
  protectedPaths: string[];
  contractHash: string;
  summary: CheckSummary;
};
