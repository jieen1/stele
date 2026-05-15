import type { Violation, ViolationReport, ViolationSeverity } from "@stele/core";

/**
 * SARIF 2.1.0 formatter.
 *
 * Kept in CLI (not core) — SARIF is a tooling-integration format, not a domain
 * primitive. Putting SARIF schema knowledge in @stele/core would carry it as
 * a transitive dependency for MCP server, agent hooks, and any downstream SDK.
 *
 * Uses `uriBaseId` (%CWD%) so paths stay relative — avoids leaking absolute
 * filesystem paths in CI security dashboards.
 *
 * Version parameter: Accepts `version` string from shared `STELE_VERSION`
 * constant (packages/cli/src/version.ts). This prevents version drift between
 * SARIF output and CLI --version.
 *
 * For web-facing consumption consider a proper HTML sanitizer (e.g.
 * `@microsoft/sarif-multi-tool` or DOMPurify). The `sanitizeMessage` helper
 * strips basic `<...>` tags only.
 */

const SARIF_SCHEMA =
  "https://raw.githubusercontent.com/oar-team/sarif-spec/main/schemas/sarif-2.1/json-schemas/sarif-schema-2.1.0.json";

// SARIF 2.1.0 types — minimal subset needed for Stele output.

type SarifLevel = "error" | "warning" | "note";

interface SarifLog {
  $schema: string;
  version: string;
  runs: SarifRun[];
}

interface SarifRun {
  tool: SarifTool;
  results: SarifResult[];
}

interface SarifTool {
  driver: SarifToolDriver;
}

interface SarifToolDriver {
  name: string;
  version: string;
  rules: SarifRule[];
}

interface SarifRule {
  id: string;
  name: string;
  shortDescription?: { text: string };
}

interface SarifResult {
  ruleId: string;
  level: SarifLevel;
  message: { text: string };
  locations?: SarifLocation[];
  properties?: Record<string, unknown>;
}

interface SarifLocation {
  physicalLocation: SarifPhysicalLocation;
}

interface SarifPhysicalLocation {
  artifactLocation: {
    uri: string;
    uriBaseId: string;
  };
  region?: {
    startLine?: number;
    startColumn?: number;
  };
}

function severityToLevel(severity: ViolationSeverity): SarifLevel {
  switch (severity) {
    case "error":
      return "error";
    case "warning":
      return "warning";
    case "info":
      return "note";
  }
}

/**
 * Sanitize a violation message for SARIF output.
 * Strips HTML tags and normalizes whitespace — prevents injection if
 * invariant descriptions contain user-authored HTML/Markdown.
 */
function sanitizeMessage(text: string): string {
  return text
    .replace(/<[^>]*>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function violationToResult(violation: Violation): SarifResult {
  const result: SarifResult = {
    ruleId: violation.rule_id,
    level: severityToLevel(violation.severity),
    message: { text: sanitizeMessage(violation.cause.summary) },
  };

  const { location } = violation;
  const filePath = location.path ?? location.manifest_path ?? location.generated_dir;

  if (filePath !== undefined) {
    const loc: SarifLocation = {
      physicalLocation: {
        artifactLocation: {
          uri: filePath,
          uriBaseId: "%CWD%",
        },
      },
    };
    if (location.line !== undefined || location.column !== undefined) {
      loc.physicalLocation.region = {};
      if (location.line !== undefined) {
        loc.physicalLocation.region.startLine = location.line;
      }
      if (location.column !== undefined) {
        loc.physicalLocation.region.startColumn = location.column;
      }
    }
    result.locations = [loc];
  }

  const props: Record<string, unknown> = {};
  props["fingerprint"] = violation.fingerprint;
  props["rule_kind"] = violation.rule_kind;
  if (violation.status !== undefined) {
    props["status"] = violation.status;
  }
  if (violation.suppressed_by !== undefined) {
    props["suppressed_by"] = violation.suppressed_by;
  }
  if (violation.scope_paths.length > 0) {
    props["scope_paths"] = violation.scope_paths;
  }
  if (violation.cause.detail !== undefined) {
    props["detail"] = sanitizeMessage(violation.cause.detail);
  }
  if (violation.fix?.summary !== undefined) {
    props["fix_summary"] = violation.fix.summary;
  }
  if (violation.fix?.command !== undefined) {
    props["fix_command"] = violation.fix.command;
  }
  if (violation.introduced_in !== undefined) {
    props["introduced_in"] = violation.introduced_in;
  }

  result.properties = props;
  return result;
}

function violationToRule(violation: Violation): SarifRule {
  return {
    id: violation.rule_id,
    name: violation.rule_id,
    shortDescription: {
      text: sanitizeMessage(violation.cause.summary),
    },
  };
}

/**
 * Convert a ViolationReport to SARIF 2.1.0 JSON string.
 *
 * @param report — the violation report
 * @param version — Stele CLI version (from STELE_VERSION constant)
 *
 * Only active violations are included in results. Suppressed and out-of-scope
 * violations are tracked in properties metadata.
 */
export function formatViolationReportSarif(report: ViolationReport, version: string): string {
  const activeViolations = report.violations.filter(
    (v) => v.status === "active" || v.status === undefined,
  );

  const ruleIds = new Set(activeViolations.map((v) => v.rule_id));
  const rules: SarifRule[] = [];

  for (const ruleId of ruleIds) {
    const v = activeViolations.find((v) => v.rule_id === ruleId)!;
    rules.push(violationToRule(v));
  }

  const results: SarifResult[] = activeViolations.map(violationToResult);

  const log: SarifLog = {
    $schema: SARIF_SCHEMA,
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: "stele",
            version,
            rules,
          },
        },
        results,
      },
    ],
  };

  return JSON.stringify(log, null, 2);
}
