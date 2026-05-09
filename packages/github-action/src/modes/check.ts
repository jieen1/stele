import * as core from "@actions/core";
import type { Violation, ViolationReport, ViolationSeverity } from "@stele/core";
import { emitAnnotations } from "../annotate.js";
import { spawnCli, type CliResult } from "../cli-runner.js";
import { upsertPrComment } from "../pr-comment.js";

export type FailOn = "error" | "warning" | "all";

export interface RunCheckDeps {
  spawn?: (args: string[]) => Promise<CliResult>;
  emit?: typeof emitAnnotations;
  upsert?: typeof upsertPrComment;
  setFailed?: (message: string) => void;
}

export async function runCheck(deps: RunCheckDeps = {}): Promise<void> {
  const spawn = deps.spawn ?? ((args) => spawnCli(args));
  const emit = deps.emit ?? emitAnnotations;
  const upsert = deps.upsert ?? upsertPrComment;
  const setFailed = deps.setFailed ?? ((message: string) => core.setFailed(message));

  const diffFrom = core.getInput("diff-from");
  const failOn = parseFailOn(core.getInput("fail-on"));
  const annotate = readBooleanInput("annotate", true);
  const prComment = readBooleanInput("pr-comment", true);

  const cliArgs = ["check", "--json"];
  if (diffFrom && diffFrom.length > 0) {
    cliArgs.push("--diff-from", diffFrom);
  }

  const result = await spawn(cliArgs);

  if (result.exitCode === 3) {
    setFailed("Manifest drift detected. Run `stele lock` after reviewing.");
    return;
  }

  if (result.exitCode !== 0 && result.exitCode !== 2 && result.stdout.trim().length === 0) {
    // Non-zero exit with no JSON payload → propagate stderr so users can see why.
    setFailed(`stele check failed (exit ${result.exitCode}): ${result.stderr.trim() || "no output"}`);
    return;
  }

  let report: ViolationReport;
  try {
    report = JSON.parse(result.stdout) as ViolationReport;
  } catch (parseError) {
    setFailed(
      `Could not parse stele check JSON output: ${(parseError as Error).message}. Stderr: ${result.stderr.trim() || "(empty)"}`,
    );
    return;
  }

  const filtered = filterByFailOn(report.violations ?? [], failOn);

  if (annotate) {
    emit(filtered, report.violations?.length ?? 0, prComment);
  }
  if (prComment) {
    await upsert(filtered, report);
  }

  if (filtered.length > 0) {
    setFailed(`${filtered.length} contract violation${filtered.length === 1 ? "" : "s"} found.`);
  }
}

export function filterByFailOn(violations: Violation[], failOn: FailOn): Violation[] {
  switch (failOn) {
    case "error":
      return violations.filter((v) => v.severity === "error");
    case "warning":
      return violations.filter((v) => v.severity === "error" || v.severity === "warning");
    case "all":
      return violations;
  }
}

export function parseFailOn(raw: string | undefined): FailOn {
  switch ((raw ?? "error").toLowerCase()) {
    case "error":
      return "error";
    case "warning":
      return "warning";
    case "all":
      return "all";
    default:
      throw new Error(`Invalid fail-on value: ${raw}. Allowed: error | warning | all.`);
  }
}

function readBooleanInput(name: string, defaultValue: boolean): boolean {
  // `core.getBooleanInput` throws on empty strings, which happens when the
  // action is invoked from non-workflow contexts (e.g. tests). Fall back to
  // the default value in that case to keep behaviour predictable.
  try {
    return core.getBooleanInput(name);
  } catch {
    return defaultValue;
  }
}

// Severity exports for downstream callers if they want to introspect.
export type { ViolationSeverity };
