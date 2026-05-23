import { SteleError } from "@stele/core";
import { getExitCode } from "../errors.js";
import { discoverProjects } from "../recursive-discovery.js";
import { aggregateExitCode, formatRecursiveHeader, formatRecursiveSummary, type SubReport } from "./recursive.js";
import { type CheckCommandOptions, isCheckCommandError, checkProject } from "./check.js";

// ----------------------------------------------------------------
// Types
// ----------------------------------------------------------------

export type RecursiveCheckResult = {
  exitCode: number;
  subReports: SubReport[];
  jsonOutput?: string;
};

// ----------------------------------------------------------------
// Recursive check
// ----------------------------------------------------------------

export async function runCheckRecursive(
  rootDir: string,
  options: CheckCommandOptions,
  output: { stdout: (chunk: string) => void; stderr: (chunk: string) => void },
): Promise<RecursiveCheckResult> {
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
  const subOptions: CheckCommandOptions = { ...options, recursive: false, json: false, reportFile: undefined };

  for (let i = 0; i < projects.length; i++) {
    const project = projects[i];
    const indexLabel = `[${i + 1}/${projects.length}]`;

    if (!options.json) {
      output.stdout(`${indexLabel} checking ${project}\n`);
    }

    const subReport = await runSingleProjectCheck(project, subOptions);
    subReports.push(subReport);

    if (!options.json) {
      const status =
        subReport.exit_code === 0
          ? `  passed (${subReport.summary.invariant_count ?? 0} invariants, ${subReport.summary.violation_count ?? 0} violations)`
          : `  failed (exit ${subReport.exit_code}): ${subReport.summary.violation_count ?? 0} violation${subReport.summary.violation_count === 1 ? "" : "s"}`;
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
      command: "check",
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

async function runSingleProjectCheck(projectDir: string, options: CheckCommandOptions): Promise<SubReport> {
  try {
    const result = await checkProject(projectDir, options);
    return {
      project: projectDir,
      exit_code: 0,
      summary: {
        invariant_count: result.summary.invariantCount,
        generated_file_count: result.summary.generatedFileCount,
        protected_file_count: result.summary.protectedFileCount,
        violation_count: result.report.summary.violation_count ?? 0,
      },
      violations: result.report.violations,
    };
  } catch (error) {
    if (isCheckCommandError(error)) {
      return {
        project: projectDir,
        exit_code: error.exitCode,
        summary: {
          invariant_count: error.report.summary.invariant_count,
          generated_file_count: error.report.summary.generated_file_count,
          protected_file_count: error.report.summary.protected_file_count,
          violation_count: error.report.summary.violation_count ?? 0,
        },
        violations: error.report.violations,
      };
    }

    const exitCode = getExitCode(error) ?? 1;
    const message = error instanceof Error ? error.message : String(error);
    const code = error instanceof SteleError ? error.code : undefined;

    return {
      project: projectDir,
      exit_code: exitCode,
      summary: { violation_count: 0 },
      error: { message, code },
    };
  }
}
