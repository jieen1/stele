import { resolve } from "node:path";
import {
  SteleError,
  buildLoadedManifestForPaths,
  loadContract,
  lockManifest,
  normalizeContract,
  writeLockedManifest,
} from "@stele/core";
import { createEvent, writeEvent } from "../events/write-event.js";
import { loadBackend } from "../backend-registry.js";
import { loadConfig } from "../config/loadConfig.js";
import { getExitCode } from "../errors.js";
import { discoverProjects } from "../recursive-discovery.js";
import {
  assertProtectedContractFilesReachable,
  collectProtectedPaths,
  computeSha256,
  verifyManagedGeneratedFiles,
} from "./generate.js";
import { aggregateExitCode, formatRecursiveHeader, formatRecursiveSummary, type SubReport } from "./recursive.js";

export type LockOptions = {
  reason?: string;
  recursive?: boolean;
  json?: boolean;
};

export type LockSummary = {
  invariantCount: number;
  protectedFileCount: number;
  manifestPath: string;
};

export type RecursiveLockResult = {
  exitCode: number;
  subReports: SubReport[];
  jsonOutput?: string;
};

// Round 5 J-11: removed unused eslint-disable directive — `_options` is
// referenced inside the body so the lint rule wouldn't have fired.
export async function runLock(projectDir: string, _options: LockOptions): Promise<void> {
  await lockProject(projectDir, _options);
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export async function lockProject(projectDir: string, _options: LockOptions): Promise<LockSummary> {
  const config = await loadConfig(projectDir);
  const contract = await loadContract(resolve(projectDir, config.entry));
  const backend = await loadBackend(config.targetLanguage, config.testFramework);
  const generated = await verifyManagedGeneratedFiles(projectDir, config.generatedDir, contract, backend);

  if (!generated.ok) {
    throw new Error("Cannot refresh the manifest while generated files are out of date.");
  }

  const protectedPaths = await collectProtectedPaths(projectDir, config);
  await assertProtectedContractFilesReachable(projectDir, config.entry, protectedPaths, contract);

  // Closeout 4 (self-dogfooding plan): route through the typed
  // MANIFEST_LIFECYCLE — build the in-memory manifest in `Loaded` state,
  // promote it to `Locked`, then persist via the typed-write entry.
  // The persist site only accepts a `Manifest<"Locked">`; calling
  // `writeManifest` directly would bypass the lifecycle and is a
  // typestate.MANIFEST_LIFECYCLE.wrong_state_at_binding violation.
  const manifestPath = resolve(projectDir, config.manifestPath);
  const contractHash = computeSha256(normalizeContract(contract));
  const loaded = await buildLoadedManifestForPaths(protectedPaths, manifestPath, contractHash);
  const locked = lockManifest(loaded);
  await writeLockedManifest(locked, manifestPath);

  await writeEvent(
    projectDir,
    createEvent("lock-update", projectDir, {
      invariant_count: contract.invariants.length,
      protected_file_count: protectedPaths.length,
    }),
  );

  return {
    invariantCount: contract.invariants.length,
    protectedFileCount: protectedPaths.length,
    manifestPath: config.manifestPath,
  };
}

/**
 * Run `stele lock` across every project found under `rootDir` (recursive mode).
 *
 * Discovers all `stele.config.json` files, sorts deterministically, and runs
 * single-project `lockProject` on each (with `--recursive` removed). The
 * `--reason` option is applied to every project's lock; per EP08 §8 we do not
 * provide `--reason-per-project`.
 */
export async function runLockRecursive(
  rootDir: string,
  options: LockOptions,
  output: { stdout: (chunk: string) => void; stderr: (chunk: string) => void },
): Promise<RecursiveLockResult> {
  const projects = await discoverProjects(rootDir);

  if (projects.length === 0) {
    throw new SteleError(
      "E_NO_PROJECTS_FOUND",
      "RecursiveError",
      `No stele.config.json found under ${rootDir}. Run 'stele init' in a sub-directory first.`,
      undefined,
      undefined,
      "Run 'stele init' in a sub-directory or change to a directory containing Stele projects.",
    );
  }

  if (!options.json) {
    output.stdout(formatRecursiveHeader(projects));
  }

  const subReports: SubReport[] = [];
  const subOptions: LockOptions = { ...options, recursive: false, json: false };

  for (let i = 0; i < projects.length; i++) {
    const project = projects[i];
    const indexLabel = `[${i + 1}/${projects.length}]`;

    if (!options.json) {
      output.stdout(`${indexLabel} locking ${project}\n`);
    }

    const subReport = await runSingleProjectLock(project, subOptions);
    subReports.push(subReport);

    if (!options.json) {
      const status =
        subReport.exit_code === 0
          ? `  locked (${subReport.summary.invariant_count ?? 0} invariants, ${subReport.summary.protected_file_count ?? 0} protected files)`
          : `  failed (exit ${subReport.exit_code})${subReport.error ? `: ${subReport.error.message}` : ""}`;
      output.stdout(`${status}\n\n`);
    }
  }

  const exitCode = aggregateExitCode(subReports);

  if (options.json) {
    const passed = subReports.filter((report) => report.exit_code === 0).length;
    const failed = subReports.length - passed;
    const aggregate = {
      schema_version: "1" as const,
      tool: "@stele/cli",
      command: "lock",
      generated_at: new Date().toISOString(),
      cwd: rootDir,
      projects: subReports,
      max_exit_code: exitCode,
      passed,
      failed,
    };
    const jsonOutput = `${JSON.stringify(aggregate, null, 2)}\n`;
    output.stdout(jsonOutput);
    return { exitCode, subReports, jsonOutput };
  }

  output.stdout(formatRecursiveSummary(subReports));
  return { exitCode, subReports };
}

async function runSingleProjectLock(projectDir: string, options: LockOptions): Promise<SubReport> {
  try {
    const result = await lockProject(projectDir, options);
    return {
      project: projectDir,
      exit_code: 0,
      summary: {
        invariant_count: result.invariantCount,
        protected_file_count: result.protectedFileCount,
      },
    };
  } catch (error) {
    const exitCode = getExitCode(error) ?? 1;
    const message = error instanceof Error ? error.message : String(error);
    const code = error instanceof SteleError ? error.code : undefined;
    return {
      project: projectDir,
      exit_code: exitCode,
      summary: {},
      error: { message, code },
    };
  }
}
