import type { ViolationReport } from "@stele/core";
import { formatViolationReportHuman, formatViolationReportJson } from "@stele/core";
import { formatViolationReportSarif } from "./sarif.js";
import { STELE_VERSION } from "../version.js";
import { ConfigError } from "../errors.js";

/**
 * Report formatter interface.
 *
 * Extension point: new formatters are added to the FORMATTERS map without
 * modifying existing code. SARIF is kept in CLI (not core) — see sarif.ts.
 */
export type ReportFormatter = (report: ViolationReport) => string;

export const FORMATTERS: Record<string, ReportFormatter> = {
  human: formatViolationReportHuman,
  json: formatViolationReportJson,
  sarif: (report) => formatViolationReportSarif(report, STELE_VERSION),
};

export const SUPPORTED_FORMATS = Object.keys(FORMATTERS).join(", ");

/**
 * Format a report using the named formatter.
 *
 * @param report — the violation report
 * @param format — format name (human, json, sarif)
 * @returns formatted string
 */
export function formatCheckReport(report: ViolationReport, format: string): string {
  const formatter = FORMATTERS[format];
  if (!formatter) {
    throw new ConfigError(
      `Unknown format: "${format}". Supported: ${SUPPORTED_FORMATS}.`,
    );
  }
  return formatter(report);
}
