import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { ViolationReport } from "@stele/core";
import { isMissingFileError } from "./utils/shared-utils.js";

/**
 * Path (relative to a project root) where `stele check` persists the most
 * recent run for `stele why <id>` to consume. EP07 §6 requires a single file
 * with no extra config flags or env vars.
 */
export const STELE_LAST_CHECK_REPORT_FILE = "contract/.last-check-report.json";

export type LastCheckReport = {
  schema_version: "1";
  generated_at: string;
  report: ViolationReport;
};

/**
 * Persist a violation report so `stele why <id>` can show the most recent
 * failure witness. Writes are atomic (write-then-rename) so a partial file
 * never appears on disk if the process is interrupted mid-flush.
 *
 * The persisted shape preserves every violation in the report including
 * baseline-suppressed and out-of-scope ones (status flags are kept). EP07 §7:
 * suppressed violations still surface their witness through `stele why`.
 */
export async function writeLastReport(projectDir: string, report: ViolationReport): Promise<string> {
  const absolutePath = resolve(projectDir, STELE_LAST_CHECK_REPORT_FILE);
  await mkdir(dirname(absolutePath), { recursive: true });

  const payload: LastCheckReport = {
    schema_version: "1",
    generated_at: new Date().toISOString(),
    report,
  };

  const tempPath = `${absolutePath}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await rename(tempPath, absolutePath);

  return absolutePath;
}

/**
 * Read the persisted report if it exists. Returns `undefined` when the file
 * is missing or malformed so `stele why` can fall back to a graceful
 * "no report" message.
 */
export async function readLastReport(projectDir: string): Promise<LastCheckReport | undefined> {
  const absolutePath = resolve(projectDir, STELE_LAST_CHECK_REPORT_FILE);

  let raw: string;
  try {
    raw = await readFile(absolutePath, "utf8");
  } catch (error) {
    if (isMissingFileError(error)) {
      return undefined;
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }

  if (!isLastCheckReport(parsed)) {
    return undefined;
  }

  return parsed;
}

function isLastCheckReport(value: unknown): value is LastCheckReport {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.schema_version !== "1") {
    return false;
  }
  if (typeof candidate.generated_at !== "string") {
    return false;
  }
  const report = candidate.report;
  if (typeof report !== "object" || report === null) {
    return false;
  }
  const reportCandidate = report as Record<string, unknown>;
  return (
    reportCandidate.schema_version === "1" &&
    typeof reportCandidate.tool === "string" &&
    typeof reportCandidate.command === "string" &&
    typeof reportCandidate.ok === "boolean" &&
    Array.isArray(reportCandidate.violations)
  );
}
