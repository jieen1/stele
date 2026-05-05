import { createHash } from "node:crypto";

export type ViolationSeverity = "error" | "warning" | "info";
export type ViolationStatus = "active" | "suppressed" | "out_of_scope";
export type ViolationSuppressionReason = "baseline";

export type ViolationSource = {
  tool: string;
  command: string;
  kind: string;
};

export type ViolationLocation = {
  path?: string;
  manifest_path?: string;
  generated_dir?: string;
  line?: number;
  column?: number;
};

export type ViolationCause = {
  summary: string;
  detail?: string;
  missing?: string[];
  changed?: string[];
  extra?: string[];
  new_files?: string[];
  expected_hash?: string;
  actual_hash?: string;
};

export type ViolationFix = {
  summary: string;
  command?: string;
};

export type Violation = {
  rule_id: string;
  rule_kind: string;
  severity: ViolationSeverity;
  source: ViolationSource;
  location: ViolationLocation;
  cause: ViolationCause;
  fingerprint: string;
  scope_paths: string[];
  status?: ViolationStatus;
  suppressed_by?: ViolationSuppressionReason;
  fix?: ViolationFix;
  introduced_in?: string;
};

export type ViolationInput = Omit<Violation, "fingerprint">;

export type ViolationReportSummary = {
  message?: string;
  invariant_count?: number;
  generated_file_count?: number;
  protected_file_count?: number;
  violation_count: number;
  active_violation_count?: number;
  suppressed_violation_count?: number;
  out_of_scope_violation_count?: number;
};

export type ViolationReport = {
  schema_version: "1";
  tool: string;
  command: string;
  ok: boolean;
  summary: ViolationReportSummary;
  violations: Violation[];
};

export type ViolationReportInput = Omit<ViolationReport, "schema_version" | "violations"> & {
  violations: Array<Violation | ViolationInput>;
};

export function createViolation(input: ViolationInput): Violation {
  const normalized: ViolationInput = {
    ...input,
    source: {
      ...input.source,
    },
    location: {
      ...input.location,
    },
    cause: normalizeCause(input.cause),
    scope_paths: uniqueSortedStrings(input.scope_paths),
    status: input.status ?? "active",
    suppressed_by: input.suppressed_by,
    fix: input.fix === undefined ? undefined : { ...input.fix },
  };

  return {
    ...normalized,
    fingerprint: buildViolationFingerprint(normalized),
  };
}

export function createViolationReport(input: ViolationReportInput): ViolationReport {
  return {
    ...input,
    schema_version: "1",
    summary: {
      ...input.summary,
      violation_count: input.violations.length,
    },
    violations: input.violations.map((violation) => ("fingerprint" in violation ? cloneViolation(violation) : createViolation(violation))),
  };
}

export function buildViolationFingerprint(violation: Omit<Violation, "fingerprint" | "status" | "suppressed_by">): string {
  const payload = {
    rule_id: violation.rule_id,
    rule_kind: violation.rule_kind,
    severity: violation.severity,
    source: violation.source,
    location: violation.location,
    cause: normalizeCause(violation.cause),
    scope_paths: uniqueSortedStrings(violation.scope_paths),
    fix: violation.fix,
  };

  return createHash("sha256").update(stableStringify(payload)).digest("hex");
}

function normalizeCause(cause: ViolationCause): ViolationCause {
  return {
    ...cause,
    missing: cause.missing === undefined ? undefined : uniqueSortedStrings(cause.missing),
    changed: cause.changed === undefined ? undefined : uniqueSortedStrings(cause.changed),
    extra: cause.extra === undefined ? undefined : uniqueSortedStrings(cause.extra),
    new_files: cause.new_files === undefined ? undefined : uniqueSortedStrings(cause.new_files),
  };
}

function uniqueSortedStrings(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function cloneViolation(violation: Violation): Violation {
  return {
    ...violation,
    source: {
      ...violation.source,
    },
    location: {
      ...violation.location,
    },
    cause: normalizeCause(violation.cause),
    scope_paths: uniqueSortedStrings(violation.scope_paths),
    status: violation.status ?? "active",
    suppressed_by: violation.suppressed_by,
    fix: violation.fix === undefined ? undefined : { ...violation.fix },
  };
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sortValue(item));
  }

  if (value === null || typeof value !== "object") {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, sortValue(entry)]),
  );
}
