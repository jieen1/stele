import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import {
  createViolationBaseline,
  stableStringCompare,
  tryReadViolationBaseline,
  writeManifest,
  writeViolationBaseline,
  type HumanState,
  type Violation,
  type ViolationReport,
} from "@stele/core";
import { STELE_BASELINE_FILE, type SteleConfig } from "../config/defaults.js";
import {
  buildRawCheckReport,
  collectProtectedCheckState,
  isBaselineEligibleViolation,
  prepareCheckContext,
} from "./check.js";
import { isMissingFileError } from "../utils/shared-utils.js";
import { createEvent, writeEvent } from "../events/write-event.js";

export type BaselineCommandOptions = {
  reason?: string;
};

export type BaselineCommandSummary = {
  baselinePath: string;
  invariantCount: number;
  protectedFileCount: number;
  violationCount: number;
  humanFiles: number;
};

/**
 * Compute SHA-256 hashes for human-authored protected files.
 *
 * Returns a HumanState containing per-file hashes and the contract hash.
 * Human-authored files are those under contract/ with .stele extension
 * and contract/checker_impls/*.py (excluding the baseline and manifest).
 */
export async function computeHumanState(
  projectDir: string,
  config: SteleConfig,
  contractHash: string,
): Promise<HumanState> {
  const files: Record<string, string> = {};
  const humanDirs = [config.contractDir, config.checkerImplDir];

  for (const dir of humanDirs) {
    const dirPath = resolve(projectDir, dir);
    await walkHumanDir(dirPath, projectDir, dir, files);
  }

  return {
    files,
    contract_hash: contractHash,
  };
}

async function walkHumanDir(
  dirPath: string,
  projectDir: string,
  dirPattern: string,
  files: Record<string, string>,
): Promise<void> {
  let entries;
  try {
    entries = await readdir(dirPath, { withFileTypes: true });
  } catch (error) {
    if (isMissingFileError(error)) {
      return;
    }
    throw error;
  }

  entries.sort((a, b) => stableStringCompare(a.name, b.name));

  for (const entry of entries) {
    if (entry.name === ".baseline.json" || entry.name === ".manifest.json") {
      continue;
    }

    const fullPath = resolve(dirPath, entry.name);
    let entryStats;

    try {
      entryStats = await lstat(fullPath);
    } catch {
      continue;
    }

    if (entryStats.isSymbolicLink()) {
      continue;
    }

    if (entryStats.isDirectory()) {
      await walkHumanDir(fullPath, projectDir, dirPattern, files);
      continue;
    }

    if (!entryStats.isFile()) {
      continue;
    }

    const relativePath = normalizePath(relative(projectDir, fullPath));
    const buffer = await readFile(fullPath);
    files[relativePath] = createHash("sha256").update(buffer).digest("hex");
  }
}

function normalizePath(value: string): string {
  return value.replaceAll("\\", "/");
}

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

  // Prepare baseline without human_state for check verification.
  // This ensures buildRawCheckReport uses manifest-based verification
  // instead of baseline-based human file drift detection.
  const baselinePath = resolve(projectDir, STELE_BASELINE_FILE);
  await writeViolationBaseline(baselinePath, {
    version: "1",
    generated_at: new Date().toISOString(),
    reason: "internal: baseline update in progress",
    violations: {},
  });

  const initialContext = await prepareCheckContext(projectDir);
  const initialReport = await buildRawCheckReport(initialContext, "check");
  assertBaselineEligible(initialReport);

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

  const finalProtectedState = await collectProtectedCheckState(
    projectDir,
    finalContext.config,
    finalContext.contract,
    finalContext.generated,
  );
  const finalHumanState = await computeHumanState(projectDir, finalContext.config, finalProtectedState.contractHash);
  const finalBaseline = createViolationBaseline({
    reason,
    violations: finalReport.violations.filter(isBaselineEligibleViolation),
    existing: existingBaseline,
    humanState: finalHumanState,
  });
  await writeViolationBaseline(baselinePath, finalBaseline);
  await writeManifest(finalProtectedState.protectedPaths, resolve(projectDir, finalContext.config.manifestPath), finalProtectedState.contractHash);

  await writeEvent(
    projectDir,
    createEvent("baseline-update", projectDir, {
      violation_count: Object.keys(finalBaseline.violations).length,
      reason,
    }),
  );

  return {
    baselinePath: STELE_BASELINE_FILE,
    invariantCount: finalProtectedState.summary.invariantCount,
    protectedFileCount: finalProtectedState.summary.protectedFileCount,
    violationCount: Object.keys(finalBaseline.violations).length,
    humanFiles: Object.keys(finalHumanState.files).length,
  };
}

export function formatBaselineSummary(action: "initialized" | "updated", summary: BaselineCommandSummary): string {
  return `OK baseline ${action}: ${summary.baselinePath} (${summary.violationCount} violation${summary.violationCount === 1 ? "" : "s"} recorded, ${summary.humanFiles} human file${summary.humanFiles === 1 ? "" : "s"} tracked, ${summary.protectedFileCount} protected file${summary.protectedFileCount === 1 ? "" : "s"} verified).\n`;
}

function assertBaselineEligible(report: ViolationReport): void {
  const unsupported = report.violations.filter((violation) => !isBaselineEligibleViolation(violation) && !isBaselineUpdateExpectedViolation(violation));

  if (unsupported.length === 0) {
    return;
  }

  throw new Error(
    `Baseline files only support contract/check violations. Unsupported report entries: ${unsupported
      .map((violation) => violation.rule_id)
      .join(", ")}.`,
  );
}

/**
 * Violations expected during baseline update but NOT baseline-eligible.
 *
 * These are drift violations that indicate protected files have changed.
 * During baseline update, they are acceptable because the update process
 * re-records the current state. Tool errors (execution_error) are NOT
 * acceptable — they indicate a misconfigured environment.
 */
function isBaselineUpdateExpectedViolation(violation: Violation): boolean {
  const id = violation.rule_id;
  return (
    id === "stele.baseline.human_file_drift" ||
    id === "stele.check.manifest_drift" ||
    id === "stele.check.protected_file_drift" ||
    id === "stele.check.generated_drift" ||
    id === "stele.check.contract_hash_mismatch"
  );
}
