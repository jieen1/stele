import type { CoreNodeMetricName, CoreNodeRole } from "@stele/core";

// ----------------------------------------------------------------
// Metric values
// ----------------------------------------------------------------

/**
 * A measured value for a single complexity metric.
 */
export interface CoreNodeMetricValue {
  name: CoreNodeMetricName;
  value: number;
  ideal: number;
  max: number;
  status: "ok" | "above-ideal" | "over-max";
}

/**
 * A measurement of complexity metrics for a single core-node target (class).
 */
export interface CoreNodeMeasurement {
  id: string;
  role: CoreNodeRole;
  target: string;
  /** Absolute file path to the source file. */
  filePath: string;
  /** Name of the target class. */
  className: string;
  metrics: CoreNodeMetricValue[];
}

/**
 * Aggregated measurement result for `stele complexity measure --json`.
 */
export type ComplexityMeasureOutput = {
  core_nodes: CoreNodeMeasurement[];
};

// ----------------------------------------------------------------
// Candidate suggestion
// ----------------------------------------------------------------

/**
 * Signal values for a single candidate class.
 */
export interface CandidateSignals {
  sloc: number;
  publicMethodCount: number;
  fanIn: number;
  fanOut: number;
}

/**
 * A candidate class file for core-node contract adoption.
 */
export interface SuggestCandidate {
  target: string;
  suggestedRole: CoreNodeRole;
  signals: CandidateSignals;
  reason: string;
}

/**
 * Output shape for `stele complexity suggest --json`.
 */
export type ComplexitySuggestOutput = {
  schema_version: "1";
  generated_at: string;
  language: "typescript";
  candidates: SuggestCandidate[];
};

// ----------------------------------------------------------------
// Evaluation results
// ----------------------------------------------------------------

/**
 * A violation occurs when a metric value exceeds its declared `max` boundary.
 */
export interface CoreNodeViolation {
  nodeId: string;
  target: string;
  metric: CoreNodeMetricName | "missing-target";
  value: number;
  ideal: number;
  max: number;
  /** When true, this is a configuration violation (e.g. missing target file). */
  isConfigurationViolation?: boolean;
}

/**
 * A notice occurs when a metric value exceeds its declared `ideal` boundary
 * but is still within the `max` boundary.
 */
export interface CoreNodeNotice {
  nodeId: string;
  target: string;
  metric: CoreNodeMetricName;
  value: number;
  ideal: number;
  max: number;
}

/**
 * Result of evaluating a single core-node measurement against its declared boundaries.
 */
export interface CoreNodeEvaluationResult {
  measurement: CoreNodeMeasurement;
  violations: CoreNodeViolation[];
  notices: CoreNodeNotice[];
}

// ----------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------

/**
 * Parse a core-node target string into its components.
 * Format: `path/to/file.ts::ClassName`
 */
export function parseCoreNodeTarget(target: string): { filePath: string; className: string } | undefined {
  const idx = target.lastIndexOf("::");
  if (idx < 0) {
    return undefined;
  }
  return {
    filePath: target.slice(0, idx),
    className: target.slice(idx + 2),
  };
}

/**
 * Determine metric status from current value and boundaries.
 */
export function getMetricStatus(current: number, ideal: number, max: number): "ok" | "above-ideal" | "over-max" {
  if (current > max) {
    return "over-max";
  }
  if (current > ideal) {
    return "above-ideal";
  }
  return "ok";
}
