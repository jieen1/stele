import { resolve } from "node:path";
import {
  createViolationBaseline,
  tryReadViolationBaseline,
  writeManifest,
  writeViolationBaseline,
  type ViolationReport,
} from "@stele/core";
import { STELE_BASELINE_FILE } from "../config/defaults.js";
import {
  buildRawCheckReport,
  collectProtectedCheckState,
  isBaselineEligibleViolation,
  prepareCheckContext,
} from "./check.js";

export type BaselineCommandOptions = {
  reason?: string;
};

export type BaselineCommandSummary = {
  baselinePath: string;
  invariantCount: number;
  protectedFileCount: number;
  violationCount: number;
};

export async function runBaselineInit(projectDir: string, options: BaselineCommandOptions): Promise<BaselineCommandSummary> {
  return baselineProject(projectDir, options);
}

export async function runBaselineUpdate(projectDir: string, options: BaselineCommandOptions): Promise<BaselineCommandSummary> {
  return baselineProject(projectDir, options);
}

function validateReason(reason: string | undefined): string {
  if (reason === undefined || reason.trim().length === 0) {
    throw new Error("Baseline updates require a non-empty --reason.");
  }

  return reason.trim();
}

async function baselineProject(projectDir: string, options: BaselineCommandOptions): Promise<BaselineCommandSummary> {
  const reason = validateReason(options.reason);
  const existingBaseline = await tryReadViolationBaseline(resolve(projectDir, STELE_BASELINE_FILE));
  const initialContext = await prepareCheckContext(projectDir);
  const initialReport = await buildRawCheckReport(initialContext, "check");
  assertBaselineEligible(initialReport);

  const baselinePath = resolve(projectDir, STELE_BASELINE_FILE);
  await writeViolationBaseline(
    baselinePath,
    createViolationBaseline({
      reason,
      violations: [],
      existing: existingBaseline,
    }),
  );

  const lockedContext = await prepareCheckContext(projectDir);
  const lockedProtectedState = await collectProtectedCheckState(
    projectDir,
    lockedContext.config,
    lockedContext.contract,
    lockedContext.generated,
  );
  await writeManifest(lockedProtectedState.protectedPaths, resolve(projectDir, lockedContext.config.manifestPath), lockedProtectedState.contractHash);

  const finalContext = await prepareCheckContext(projectDir);
  const finalReport = await buildRawCheckReport(finalContext, "check");
  assertBaselineEligible(finalReport);

  const finalBaseline = createViolationBaseline({
    reason,
    violations: finalReport.violations.filter(isBaselineEligibleViolation),
    existing: existingBaseline,
  });
  await writeViolationBaseline(baselinePath, finalBaseline);

  const finalProtectedState = await collectProtectedCheckState(
    projectDir,
    finalContext.config,
    finalContext.contract,
    finalContext.generated,
  );
  await writeManifest(finalProtectedState.protectedPaths, resolve(projectDir, finalContext.config.manifestPath), finalProtectedState.contractHash);

  return {
    baselinePath: STELE_BASELINE_FILE,
    invariantCount: finalProtectedState.summary.invariantCount,
    protectedFileCount: finalProtectedState.summary.protectedFileCount,
    violationCount: Object.keys(finalBaseline.violations).length,
  };
}

export function formatBaselineSummary(action: "initialized" | "updated", summary: BaselineCommandSummary): string {
  return `OK baseline ${action}: ${summary.baselinePath} (${summary.violationCount} violation${summary.violationCount === 1 ? "" : "s"} recorded, ${summary.protectedFileCount} protected file${summary.protectedFileCount === 1 ? "" : "s"} verified).\n`;
}

function assertBaselineEligible(report: ViolationReport): void {
  const unsupported = report.violations.filter((violation) => !isBaselineEligibleViolation(violation));

  if (unsupported.length === 0) {
    return;
  }

  throw new Error(
    `Baseline files only support contract/check violations. Unsupported report entries: ${unsupported
      .map((violation) => violation.rule_id)
      .join(", ")}.`,
  );
}
