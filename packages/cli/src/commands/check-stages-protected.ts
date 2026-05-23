import { resolve } from "node:path";
import {
  createViolationReport,
  tryReadViolationBaseline,
  verifyManifest,
  type HumanState,
  type ViolationReport,
} from "@stele/core";
import { STELE_BASELINE_FILE } from "../config/defaults.js";
import type { PreparedCheckContext, ProtectedCheckState } from "../architecture/types.js";
import { computeHumanState } from "./baseline.js";
import {
  createContractHashMismatchViolation,
  createExecutionViolation,
  createHumanFileDriftViolation,
  createManifestDriftViolation,
  createProtectedFileDriftViolation,
} from "./check-violations.js";
import { toManifestPaths } from "./generate.js";

// ----------------------------------------------------------------
// Protected stage
// ----------------------------------------------------------------

/**
 * Build the protected-stage report.
 *
 * If a baseline with `human_state` exists, delegates to baseline-driven
 * drift detection. Otherwise falls back to manifest verification.
 */
export async function buildProtectedStageReport(
  context: PreparedCheckContext,
  protectedState: ProtectedCheckState,
  command: string,
): Promise<ViolationReport> {
  try {
    const baseline = await tryReadViolationBaseline(resolve(context.projectDir, STELE_BASELINE_FILE));
    const humanState = baseline?.human_state;

    if (humanState !== undefined) {
      return buildProtectedReportWithBaseline(context, protectedState, humanState, command);
    }

    return buildProtectedReportWithManifest(context, protectedState, command);
  } catch (error) {
    return createViolationReport({
      tool: "stele",
      command,
      ok: false,
      summary: {
        invariant_count: protectedState.summary.invariantCount,
        generated_file_count: protectedState.summary.generatedFileCount,
        protected_file_count: protectedState.summary.protectedFileCount,
        violation_count: 1,
      },
      violations: [createExecutionViolation(error, context.config.entry, command)],
    });
  }
}

/**
 * Protected-stage report when baseline has human_state.
 *
 * Compares current human file hashes against the recorded baseline state.
 * If human files match, skips manifest verification entirely (the manifest
 * will naturally drift from human-authored files).
 * If human files drift from baseline, reports human_file_drift violations.
 */
async function buildProtectedReportWithBaseline(
  context: PreparedCheckContext,
  protectedState: ProtectedCheckState,
  humanState: HumanState,
  command: string,
): Promise<ViolationReport> {
  const currentHumanState = await computeHumanState(
    context.projectDir,
    context.config,
    protectedState.contractHash,
  );

  const driftedFiles: string[] = [];
  for (const [path, baselineHash] of Object.entries(humanState.files)) {
    if (currentHumanState.files[path] !== baselineHash) {
      driftedFiles.push(path);
    }
  }

  for (const path of Object.keys(currentHumanState.files)) {
    if (humanState.files[path] === undefined) {
      driftedFiles.push(path);
    }
  }

  driftedFiles.sort();

  const violations: ReturnType<typeof createHumanFileDriftViolation>[] = [];

  if (driftedFiles.length > 0 || currentHumanState.contract_hash !== humanState.contract_hash) {
    violations.push(
      createHumanFileDriftViolation(
        STELE_BASELINE_FILE,
        humanState,
        currentHumanState,
        command,
      ),
    );
  }

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

/**
 * Protected-stage report using manifest verification (no baseline human_state).
 * This is the original behavior when no baseline exists.
 */
async function buildProtectedReportWithManifest(
  context: PreparedCheckContext,
  protectedState: ProtectedCheckState,
  command: string,
): Promise<ViolationReport> {
  const manifest = await verifyManifest(resolve(context.projectDir, context.config.manifestPath));
  const currentProtectedPaths = toManifestPaths(context.projectDir, protectedState.protectedPaths);
  const manifestProtectedPathSet = new Set(manifest.files.map((file) => file.path));
  const violations = [
    ...(!manifest.ok ? [createManifestDriftViolation(context.config.manifestPath, manifest, command)] : []),
    ...currentProtectedPaths
      .filter((path) => !manifestProtectedPathSet.has(path))
      .map((path) => createProtectedFileDriftViolation(context.config.manifestPath, [path], command)),
  ];

  if (manifest.contractHash !== protectedState.contractHash) {
    violations.push(
      createContractHashMismatchViolation(
        context.config.entry,
        context.config.manifestPath,
        manifest.contractHash,
        protectedState.contractHash,
        command,
      ),
    );
  }

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
