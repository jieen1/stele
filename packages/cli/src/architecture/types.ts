import type { ArchitectureDeclaration, EvaluationResult, ArchitectureGraph } from "@stele/architecture-core";
import type { Violation } from "@stele/core";

export type ArchitectureCheckResult = {
  declaration: ArchitectureDeclaration;
  graph: ArchitectureGraph;
  evaluation: EvaluationResult;
  violations: Violation[];
};

export type ArchitectureStageReport = {
  ok: boolean;
  violations: Violation[];
  architectureCount: number;
};
