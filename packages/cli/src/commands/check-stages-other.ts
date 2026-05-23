import {
  createViolationReport,
  type ContractNotice,
  type Violation,
  type ViolationReport,
} from "@stele/core";
import type { PreparedCheckContext, ProtectedCheckState } from "../architecture/types.js";
import { evaluateCodeShapes } from "../code-shape/evaluate.js";
import { buildArchitectureStageReport } from "../architecture/stage.js";
import { evaluateCoreNodes } from "../complexity/evaluate.js";
import { createGeneratedDriftViolation } from "./check-violations.js";
import { checkDesign } from "./design/check.js";
import { profilePathExists } from "../design-profile/load.js";

// ----------------------------------------------------------------
// Generated stage
// ----------------------------------------------------------------

export function buildGeneratedStageReport(
  context: PreparedCheckContext,
  command: string,
): ViolationReport {
  if (!context.generated.ok) {
    return createViolationReport({
      tool: "stele",
      command,
      ok: false,
      summary: {
        invariant_count: context.invariantCount,
        generated_file_count: context.generated.files.length,
        violation_count: 1,
      },
      violations: [createGeneratedDriftViolation(context.config.entry, context.config.generatedDir, context.generated, command)],
    });
  }

  return createViolationReport({
    tool: "stele",
    command,
    ok: true,
    summary: {
      invariant_count: context.invariantCount,
      generated_file_count: context.generated.files.length,
      violation_count: 0,
    },
    violations: [],
  });
}

// ----------------------------------------------------------------
// Design stage
// ----------------------------------------------------------------

export async function buildDesignStage(
  context: PreparedCheckContext,
  protectedState: ProtectedCheckState,
  command: string,
): Promise<ViolationReport> {
  if (!profilePathExists(context.projectDir)) {
    return createViolationReport({
      tool: "stele",
      command,
      ok: true,
      summary: {
        invariant_count: protectedState.summary.invariantCount,
        violation_count: 0,
      },
      violations: [],
    });
  }

  const result = await checkDesign(context.projectDir, {});

  const violations: Violation[] = [];
  for (const error of result.errors) {
    violations.push({
      rule_id: "design_integrity.violation",
      rule_kind: "design_integrity",
      severity: "error",
      source: { tool: "stele", command, kind: "design" },
      location: { path: "contract/design/profile.yaml" },
      cause: { summary: error },
      fingerprint: `design_integrity.${result.profileValid ? "profile_fail" : "pass"}.${result.manifestValid ? "manifest_ok" : "manifest_fail"}.${result.ownershipValid ? "ownership_ok" : "ownership_fail"}`,
      scope_paths: ["contract/design/profile.yaml"],
      status: "active",
    });
  }

  return createViolationReport({
    tool: "stele",
    command,
    ok: violations.length === 0,
    summary: {
      invariant_count: protectedState.summary.invariantCount,
      violation_count: violations.length,
    },
    violations,
  });
}

// ----------------------------------------------------------------
// Code-shape stage
// ----------------------------------------------------------------

export async function buildCodeShapeStageReport(
  context: PreparedCheckContext,
  protectedState: ProtectedCheckState,
  command: string,
): Promise<ViolationReport> {
  const violations = await evaluateCodeShapes(context.projectDir, context.contract, command);

  return createViolationReport({
    tool: "stele",
    command,
    ok: violations.length === 0,
    summary: {
      invariant_count: protectedState.summary.invariantCount,
      generated_file_count: protectedState.summary.generatedFileCount,
      protected_file_count: protectedState.summary.protectedFileCount,
      violation_count: violations.length,
    },
    violations,
  });
}

// ----------------------------------------------------------------
// Architecture stage
// ----------------------------------------------------------------

export async function buildArchitectureStage(
  context: PreparedCheckContext,
  protectedState: ProtectedCheckState,
  command: string,
): Promise<ViolationReport> {
  return buildArchitectureStageReport(context, protectedState, command);
}

// ----------------------------------------------------------------
// Complexity stage
// ----------------------------------------------------------------

export async function buildComplexityStage(
  context: PreparedCheckContext,
  protectedState: ProtectedCheckState,
  command: string,
): Promise<ViolationReport> {
  const coreNodes = context.contract.coreNodes;

  if (coreNodes.length === 0) {
    return createViolationReport({
      tool: "stele",
      command,
      ok: true,
      summary: {
        invariant_count: protectedState.summary.invariantCount,
        violation_count: 0,
      },
      violations: [],
      notices: [],
    });
  }

  const results = await evaluateCoreNodes(context.projectDir, coreNodes);

  const violations: Violation[] = [];
  const notices: ContractNotice[] = [];

  for (const result of results) {
    for (const v of result.violations) {
      const detail = `Complexity violation: ${v.metric} value ${v.value} exceeds max ${v.max} for core-node "${result.measurement.id}"`;
      violations.push({
        rule_id: `complexity.${result.measurement.id}.${v.metric}`,
        rule_kind: "rule_violation" as const,
        severity: "error" as const,
        source: { tool: "stele", command, kind: "rule" },
        location: { path: result.measurement.filePath },
        cause: { summary: detail },
        fingerprint: `complexity.${result.measurement.id}.${v.metric}`,
        scope_paths: [result.measurement.filePath],
        status: "active" as const,
        fix: { summary: `Reduce ${v.metric} of "${result.measurement.className}" below ${v.max}.` },
      });
    }

    for (const n of result.notices) {
      notices.push({
        id: `notice.${result.measurement.id}.${n.metric}`,
        kind: "above-ideal",
        nodeId: n.nodeId,
        target: n.target,
        metric: n.metric,
        value: n.value,
        ideal: n.ideal,
        max: n.max,
        summary: `${n.metric} value ${n.value} exceeds ideal ${n.ideal} for core-node "${result.measurement.id}"`,
      });
    }
  }

  return createViolationReport({
    tool: "stele",
    command,
    ok: violations.length === 0,
    summary: {
      invariant_count: protectedState.summary.invariantCount,
      violation_count: violations.length,
    },
    violations,
    notices,
  });
}
