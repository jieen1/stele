// tsc diagnostic parser — parses `tsc --pretty false` output into Stele violations.

import type { TscDiagnostic, ToolchainViolation } from "./types.js";

export interface TypeScriptToolchainOptions {
  tsconfigPath?: string;
  command?: string;
}

// Default tsc command for no-emit checks.
export const DEFAULT_TSC_COMMAND = "tsc --noEmit --pretty false";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse raw `tsc --pretty false` output into structured diagnostics.
 *
 * Expected format: `path/to/file.ts(123,45): error TS2322: Type string...`
 * Variants:
 *   - With line/col: `file.ts(123,45): error TS2322: message`
 *   - With line only: `file.ts(123): error TS2322: message`
 *   - No location: `file.ts: error TS2322: message`
 */
export function parseTscOutput(raw: string): TscDiagnostic[] {
  if (!raw || !raw.trim()) return [];

  const diagnostics: TscDiagnostic[] = [];
  const lines = raw.split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const diagnostic = parseDiagnosticLine(trimmed);
    if (diagnostic) {
      diagnostics.push(diagnostic);
    }
  }

  return diagnostics;
}

/**
 * Parse raw tsc output and convert directly to ToolchainViolation array.
 */
export function parseTscOutputToViolations(raw: string, projectDir: string): ToolchainViolation[] {
  const diagnostics = parseTscOutput(raw);
  return diagnostics.map((d) => diagnosticToViolation(d, projectDir));
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Parse a single tsc diagnostic line.
 *
 * Formats handled:
 *   file.ts(123,45): error TS2322: message
 *   file.ts(123): error TS2322: message
 *   file.ts: error TS2322: message
 *   file.ts(123,45): error TS2322: message\n  Related message on continuation
 */
function parseDiagnosticLine(line: string): TscDiagnostic | undefined {
  // Pattern: file(path,col): error CODE: message
  // Also handles Windows paths like C:\project\file.ts(123,45)
  const withLocation = /^([^(]+?)\((\d+)(?:,(\d+))?\):\s+(error|warning)\s+(TS\d+):(.+)$/.exec(line);
  if (withLocation) {
    const file = withLocation[1].trim();
    const parsedFile = normalizeFilePath(file);
    const diag: TscDiagnostic = {
      file: parsedFile,
      code: withLocation[5],
      message: withLocation[6].trim(),
    };
    const lineNum = parseInt(withLocation[2], 10);
    diag.line = Number.isFinite(lineNum) ? lineNum : undefined;
    if (withLocation[3]) {
      const colNum = parseInt(withLocation[3], 10);
      diag.column = Number.isFinite(colNum) ? colNum : undefined;
    }
    return diag;
  }

  // Pattern: file.ts: error CODE: message (no line/column)
  const withoutLocation = /^([^:]+?):\s+(error|warning)\s+(TS\d+):(.+)$/.exec(line);
  if (withoutLocation) {
    const file = withoutLocation[1].trim();
    const parsedFile = normalizeFilePath(file);
    return {
      file: parsedFile,
      code: withoutLocation[3],
      message: withoutLocation[4].trim(),
    };
  }

  // Skip non-diagnostic lines (e.g., "Found X errors. X.ts file(s).")
  return undefined;
}

// ---------------------------------------------------------------------------
// Conversion
// ---------------------------------------------------------------------------

function diagnosticToViolation(d: TscDiagnostic, projectDir: string): ToolchainViolation {
  const normalizedFile = d.file.includes(projectDir) ? d.file : d.file;

  return {
    ruleId: `typedriven.typescript.diagnostic.${d.code}`,
    ruleKind: "typescript-diagnostic",
    file: normalizedFile,
    line: d.line,
    column: d.column,
    code: d.code,
    message: d.message,
    severity: "error",
    fix: `Fix TypeScript error ${d.code} in ${d.file}.`,
  };
}

/**
 * Normalize file path: convert backslashes to forward slashes for consistency.
 */
function normalizeFilePath(file: string): string {
  return file.replace(/\\/g, "/");
}
