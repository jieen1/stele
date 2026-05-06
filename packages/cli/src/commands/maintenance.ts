import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { buildRawCheckReport, prepareCheckContext } from "./check.js";
import { buildRuleIndex } from "./rules.js";

const execFileAsync = promisify(execFile);

export type MaintenanceSummaryOptions = {
  from?: string;
  output?: string;
};

export async function runMaintenanceSummary(projectDir: string, options: MaintenanceSummaryOptions = {}): Promise<void> {
  const summary = await buildMaintenanceSummary(projectDir, options);

  if (options.output === undefined) {
    process.stdout.write(summary);
    return;
  }

  const outputPath = resolve(projectDir, options.output);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, summary, "utf8");
  process.stdout.write(`OK wrote Stele maintenance summary to ${options.output}.\n`);
}

async function buildMaintenanceSummary(projectDir: string, options: MaintenanceSummaryOptions): Promise<string> {
  const index = await buildRuleIndex(projectDir);
  const changedFiles = await collectChangedFiles(projectDir, options.from);
  const checkStatus = await collectCheckStatus(projectDir);
  const lines = [
    "# Stele Maintenance Summary",
    "",
    "## Contract inventory",
    `- Invariants: ${index.summary.invariant_count}`,
    `- Code-shape rules: ${index.summary.code_shape_count}`,
    `- Scenarios: ${index.summary.scenario_count}`,
    `- Protected globs: ${index.protected.join(", ")}`,
    "",
    "## Recent changed files",
    ...formatChangedFiles(changedFiles),
    "",
    "## Current check status",
    checkStatus,
    "",
    "## Candidate questions for newly learned behavior",
    "- Did recent work reveal a domain invariant that should be checked every time?",
    "- Did a repeated bug pattern suggest a boundary, type-policy, or invariant?",
    "- Can the new knowledge be added as a new rule without modifying or deleting existing contract material?",
    "",
    "## Agent maintenance instructions",
    "- Additions: use `stele propose invariant --apply --id <ID> --severity <level> --description <text> --assert <expr>`.",
    "- Modifications and deletions require explicit user review before editing existing contract files.",
    "- Do not run `stele lock` or baseline updates unless the user approved the contract change and reason.",
  ];

  return `${lines.join("\n")}\n`;
}

async function collectChangedFiles(projectDir: string, from: string | undefined): Promise<string[] | undefined> {
  if (from === undefined) {
    return undefined;
  }

  try {
    const { stdout } = await execFileAsync("git", ["diff", "--name-only", `${from}...HEAD`], {
      cwd: projectDir,
      windowsHide: true,
    });

    return stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  } catch {
    return undefined;
  }
}

async function collectCheckStatus(projectDir: string): Promise<string> {
  try {
    const context = await prepareCheckContext(projectDir);
    const report = await buildRawCheckReport(context, "maintenance-summary");
    const activeCount = report.summary.active_violation_count ?? report.violations.filter((violation) => (violation.status ?? "active") === "active").length;

    return activeCount === 0 ? "- Stele check report: no active violations detected." : `- Stele check report: ${activeCount} active violation(s) need attention.`;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return `- Stele check report unavailable: ${detail}`;
  }
}

function formatChangedFiles(changedFiles: string[] | undefined): string[] {
  if (changedFiles === undefined) {
    return ["- Git diff scope unavailable; agent should summarize recent work from conversation and local context."];
  }

  if (changedFiles.length === 0) {
    return ["- <none>"];
  }

  return changedFiles.map((file) => `- ${file}`);
}
