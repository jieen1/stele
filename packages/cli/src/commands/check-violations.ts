import {
  createViolation,
  type GeneratedVerificationResult,
  type VerificationResult,
} from "@stele/core";
import { STELE_CONFIG_FILE } from "../config/defaults.js";

/**
 * Create a violation for generated file drift.
 */
export function createGeneratedDriftViolation(
  entryPath: string,
  generatedDir: string,
  generated: GeneratedVerificationResult,
  command: string,
): ReturnType<typeof createViolation> {
  return createViolation({
    rule_id: "stele.check.generated_drift",
    rule_kind: "generated_drift",
    severity: "error",
    source: {
      tool: "stele",
      command,
      kind: "generated",
    },
    location: {
      generated_dir: generatedDir,
    },
    cause: {
      summary: "Generated files do not match the contract.",
      missing: generated.missing,
      changed: generated.changed,
      extra: generated.extra,
    },
    scope_paths: [entryPath, ...generated.missing, ...generated.changed, ...generated.extra],
    fix: {
      summary: "Re-run stele generate --force to replace them.",
      command: "stele generate --force",
    },
  });
}

/**
 * Create a violation for manifest drift.
 */
export function createManifestDriftViolation(
  manifestPath: string,
  manifest: VerificationResult,
  command: string,
): ReturnType<typeof createViolation> {
  return createViolation({
    rule_id: "stele.check.manifest_drift",
    rule_kind: "manifest_drift",
    severity: "error",
    source: {
      tool: "stele",
      command,
      kind: "manifest",
    },
    location: {
      manifest_path: manifestPath,
    },
    cause: {
      summary: "Manifest verification failed.",
      missing: manifest.missing,
      changed: manifest.changed,
    },
    scope_paths: [manifestPath, ...manifest.missing, ...manifest.changed],
    fix: {
      summary: "Run stele lock after approval to refresh the manifest.",
      command: "stele lock --reason <reason>",
    },
  });
}

/**
 * Create a violation for unlocked protected files.
 */
export function createProtectedFileDriftViolation(
  manifestPath: string,
  newProtectedPaths: string[],
  command: string,
): ReturnType<typeof createViolation> {
  return createViolation({
    rule_id: "stele.check.protected_file_drift",
    rule_kind: "protected_file_drift",
    severity: "error",
    source: {
      tool: "stele",
      command,
      kind: "protected",
    },
    location: {
      manifest_path: manifestPath,
    },
    cause: {
      summary: "Found new/unlocked protected files.",
      new_files: newProtectedPaths,
    },
    scope_paths: [manifestPath, ...newProtectedPaths],
    fix: {
      summary: "Run stele lock after approval to capture the approved protected files.",
      command: "stele lock --reason <reason>",
    },
  });
}

/**
 * Create a violation for contract hash mismatch.
 */
export function createContractHashMismatchViolation(
  entryPath: string,
  manifestPath: string,
  expectedHash: string,
  actualHash: string,
  command: string,
): ReturnType<typeof createViolation> {
  return createViolation({
    rule_id: "stele.check.contract_hash_mismatch",
    rule_kind: "contract_hash_mismatch",
    severity: "error",
    source: {
      tool: "stele",
      command,
      kind: "contract",
    },
    location: {
      path: entryPath,
      manifest_path: manifestPath,
    },
    cause: {
      summary: "Manifest contract hash does not match the current contract.",
      expected_hash: expectedHash,
      actual_hash: actualHash,
    },
    scope_paths: [entryPath, manifestPath],
    fix: {
      summary: "Run stele lock after approval to capture the updated contract hash.",
      command: "stele lock --reason <reason>",
    },
  });
}

/**
 * Create a violation for execution errors during check.
 */
export function createExecutionViolation(
  error: unknown,
  entryPath: string | undefined,
  command: string,
): ReturnType<typeof createViolation> {
  const message = error instanceof Error ? error.message : String(error);

  return createViolation({
    rule_id: "stele.check.execution_error",
    rule_kind: "execution_error",
    severity: "error",
    source: {
      tool: "stele",
      command,
      kind: "execution",
    },
    location: {
      path: entryPath ?? STELE_CONFIG_FILE,
    },
    cause: {
      summary: message,
    },
    scope_paths: [entryPath ?? STELE_CONFIG_FILE],
  });
}
