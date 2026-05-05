import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  createViolation,
  createViolationReport,
  formatViolationReportHuman,
  formatViolationReportJson,
  loadContract,
  normalizeContract,
  type GeneratedVerificationResult,
  type VerificationResult,
  type Violation,
  type ViolationReport,
  verifyManifest,
} from "@stele/core";
import { STELE_CONFIG_FILE } from "../config/defaults.js";
import { loadConfig } from "../config/loadConfig.js";
import { CliCommandError } from "../errors.js";
import {
  assertProtectedContractFilesReachable,
  collectProtectedPaths,
  createLanguageBackend,
  sha256,
  toManifestPaths,
  verifyManagedGeneratedFiles,
} from "./generate.js";

export type CheckSummary = {
  invariantCount: number;
  generatedFileCount: number;
  protectedFileCount: number;
};

export type CheckCommandOptions = {
  json?: boolean;
  reportFile?: string;
};

export type CheckCommandResult = {
  summary: CheckSummary;
  report: ViolationReport;
};

export async function runCheck(projectDir: string): Promise<void> {
  await checkProject(projectDir);
}

export async function checkProject(projectDir: string, _options: CheckCommandOptions = {}): Promise<CheckCommandResult> {
  const config = await loadConfig(projectDir);
  const contract = await loadContract(resolve(projectDir, config.entry));
  const backend = createLanguageBackend(config.generatedDir, config.targetLanguage, config.testFramework);
  const generated = await verifyManagedGeneratedFiles(projectDir, config.generatedDir, contract, backend);
  const invariantCount = contract.invariants.length;

  if (!generated.ok) {
    const violation = createGeneratedDriftViolation(config.entry, config.generatedDir, generated);

    throw new CheckCommandError(
      2,
      createViolationReport({
        tool: "stele",
        command: "check",
        ok: false,
        summary: {
          invariant_count: invariantCount,
          generated_file_count: generated.files.length,
          violation_count: 1,
        },
        violations: [violation],
      }),
    );
  }

  try {
    const protectedPaths = await collectProtectedPaths(projectDir, config);
    await assertProtectedContractFilesReachable(projectDir, config.entry, protectedPaths, contract);

    const manifest = await verifyManifest(resolve(projectDir, config.manifestPath));
    const currentProtectedPaths = toManifestPaths(projectDir, protectedPaths);
    const summary: CheckSummary = {
      invariantCount,
      generatedFileCount: generated.files.length,
      protectedFileCount: currentProtectedPaths.length,
    };
    const manifestProtectedPathSet = new Set(manifest.files.map((file) => file.path));
    const newProtectedPaths = currentProtectedPaths.filter((path) => !manifestProtectedPathSet.has(path));
    const manifestViolations = [
      ...(!manifest.ok ? [createManifestDriftViolation(config.manifestPath, manifest)] : []),
      ...(newProtectedPaths.length > 0 ? [createProtectedFileDriftViolation(config.manifestPath, newProtectedPaths)] : []),
    ];

    if (manifestViolations.length > 0) {
      throw new CheckCommandError(
        3,
        createViolationReport({
          tool: "stele",
          command: "check",
          ok: false,
          summary: {
            invariant_count: summary.invariantCount,
            generated_file_count: summary.generatedFileCount,
            protected_file_count: summary.protectedFileCount,
            violation_count: manifestViolations.length,
          },
          violations: manifestViolations,
        }),
      );
    }

    const contractHash = sha256(normalizeContract(contract));

    if (manifest.contractHash !== contractHash) {
      const violation = createContractHashMismatchViolation(config.entry, config.manifestPath, manifest.contractHash, contractHash);

      throw new CheckCommandError(
        3,
        createViolationReport({
          tool: "stele",
          command: "check",
          ok: false,
          summary: {
            invariant_count: summary.invariantCount,
            generated_file_count: summary.generatedFileCount,
            protected_file_count: summary.protectedFileCount,
            violation_count: 1,
          },
          violations: [violation],
        }),
      );
    }

    return {
      summary,
      report: createViolationReport({
        tool: "stele",
        command: "check",
        ok: true,
        summary: {
          message: formatCheckSummary(summary).trimEnd(),
          invariant_count: summary.invariantCount,
          generated_file_count: summary.generatedFileCount,
          protected_file_count: summary.protectedFileCount,
          violation_count: 0,
        },
        violations: [],
      }),
    };
  } catch (error) {
    if (error instanceof CheckCommandError) {
      throw error;
    }

    throw new CheckCommandError(
      3,
      createViolationReport({
        tool: "stele",
        command: "check",
        ok: false,
        summary: {
          invariant_count: invariantCount,
          generated_file_count: generated.files.length,
          violation_count: 1,
        },
        violations: [createExecutionViolation(error, config.entry)],
      }),
      error,
    );
  }
}

export function isCheckCommandError(error: unknown): error is CheckCommandError {
  return error instanceof CheckCommandError;
}

export function formatCheckSummary(summary: CheckSummary): string {
  return `OK ${summary.invariantCount} invariant${summary.invariantCount === 1 ? "" : "s"} checked; ${summary.generatedFileCount} generated file${summary.generatedFileCount === 1 ? "" : "s"} and ${summary.protectedFileCount} protected file${summary.protectedFileCount === 1 ? "" : "s"} verified.\n`;
}

export function formatCheckReportHuman(report: ViolationReport): string {
  return formatViolationReportHuman(report);
}

export function formatCheckReportJson(report: ViolationReport): string {
  return formatViolationReportJson(report);
}

export async function writeCheckReportFile(projectDir: string, reportFile: string, report: ViolationReport): Promise<void> {
  const absoluteReportPath = resolve(projectDir, reportFile);
  await mkdir(dirname(absoluteReportPath), { recursive: true });
  await writeFile(absoluteReportPath, formatViolationReportJson(report), "utf8");
}

class CheckCommandError extends CliCommandError {
  constructor(
    exitCode: number,
    readonly report: ViolationReport,
    cause?: unknown,
  ) {
    super(formatViolationReportHuman(report).trimEnd(), exitCode, cause);
    this.name = "CheckCommandError";
  }
}

function createGeneratedDriftViolation(
  entryPath: string,
  generatedDir: string,
  generated: GeneratedVerificationResult,
): Violation {
  return createViolation({
    rule_id: "stele.check.generated_drift",
    rule_kind: "generated_drift",
    severity: "error",
    source: {
      tool: "stele",
      command: "check",
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

function createManifestDriftViolation(manifestPath: string, manifest: VerificationResult): Violation {
  return createViolation({
    rule_id: "stele.check.manifest_drift",
    rule_kind: "manifest_drift",
    severity: "error",
    source: {
      tool: "stele",
      command: "check",
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

function createProtectedFileDriftViolation(manifestPath: string, newProtectedPaths: string[]): Violation {
  return createViolation({
    rule_id: "stele.check.protected_file_drift",
    rule_kind: "protected_file_drift",
    severity: "error",
    source: {
      tool: "stele",
      command: "check",
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

function createContractHashMismatchViolation(
  entryPath: string,
  manifestPath: string,
  expectedHash: string,
  actualHash: string,
): Violation {
  return createViolation({
    rule_id: "stele.check.contract_hash_mismatch",
    rule_kind: "contract_hash_mismatch",
    severity: "error",
    source: {
      tool: "stele",
      command: "check",
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

function createExecutionViolation(error: unknown, entryPath?: string): Violation {
  const message = error instanceof Error ? error.message : String(error);

  return createViolation({
    rule_id: "stele.check.execution_error",
    rule_kind: "execution_error",
    severity: "error",
    source: {
      tool: "stele",
      command: "check",
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
