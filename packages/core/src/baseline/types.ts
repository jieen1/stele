import type { Violation, ViolationLocation, ViolationReport, ViolationSource } from "../report/types.js";

export type BaselineVersion = "1";

export type BaselineViolation = {
  rule_id: string;
  rule_kind: string;
  first_seen: string;
  source: ViolationSource;
  location: ViolationLocation;
  scope_paths: string[];
};

export type ViolationBaseline = {
  version: BaselineVersion;
  generated_at: string;
  reason: string;
  violations: Record<string, BaselineViolation>;
};

export type CreateViolationBaselineOptions = {
  reason: string;
  violations: Violation[];
  existing?: ViolationBaseline;
  generatedAt?: string;
};

export type FilterViolationReportOptions = {
  baseline?: ViolationBaseline;
  diffScopePaths?: Iterable<string>;
  isSuppressible?: (violation: Violation) => boolean;
};

export function createViolationBaseline(options: CreateViolationBaselineOptions): ViolationBaseline {
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const entries = Object.fromEntries(
    options.violations
      .slice()
      .sort((left, right) => left.fingerprint.localeCompare(right.fingerprint))
      .map((violation) => {
        const existing = options.existing?.violations[violation.fingerprint];

        return [
          violation.fingerprint,
          {
            rule_id: violation.rule_id,
            rule_kind: violation.rule_kind,
            first_seen: existing?.first_seen ?? generatedAt,
            source: { ...violation.source },
            location: { ...violation.location },
            scope_paths: uniqueSortedStrings(violation.scope_paths),
          } satisfies BaselineViolation,
        ] as const;
      }),
  );

  return {
    version: "1",
    generated_at: generatedAt,
    reason: options.reason,
    violations: entries,
  };
}

export function filterViolationReport(report: ViolationReport, options: FilterViolationReportOptions = {}): ViolationReport {
  const diffScopePaths = options.diffScopePaths === undefined ? undefined : new Set([...options.diffScopePaths].map(normalizePath));
  const isSuppressible = options.isSuppressible ?? (() => true);
  const violations = report.violations.map((violation) => {
    const normalized = {
      ...violation,
      source: { ...violation.source },
      location: { ...violation.location },
      cause: {
        ...violation.cause,
        missing: violation.cause.missing === undefined ? undefined : [...violation.cause.missing],
        changed: violation.cause.changed === undefined ? undefined : [...violation.cause.changed],
        extra: violation.cause.extra === undefined ? undefined : [...violation.cause.extra],
        new_files: violation.cause.new_files === undefined ? undefined : [...violation.cause.new_files],
      },
      scope_paths: uniqueSortedStrings(violation.scope_paths),
      fix: violation.fix === undefined ? undefined : { ...violation.fix },
    };

    if (
      diffScopePaths !== undefined &&
      isSuppressible(normalized) &&
      normalized.scope_paths.length > 0 &&
      !normalized.scope_paths.some((path) => diffScopePaths.has(normalizePath(path)))
    ) {
      return {
        ...normalized,
        status: "out_of_scope" as const,
        suppressed_by: undefined,
      };
    }

    if (options.baseline?.violations[normalized.fingerprint] !== undefined && isSuppressible(normalized)) {
      return {
        ...normalized,
        status: "suppressed" as const,
        suppressed_by: "baseline" as const,
      };
    }

    return {
      ...normalized,
      status: "active" as const,
      suppressed_by: undefined,
    };
  });
  const activeViolationCount = violations.filter((violation) => violation.status === "active").length;
  const suppressedViolationCount = violations.filter((violation) => violation.status === "suppressed").length;
  const outOfScopeViolationCount = violations.filter((violation) => violation.status === "out_of_scope").length;

  return {
    ...report,
    ok: activeViolationCount === 0,
    summary: {
      ...report.summary,
      violation_count: violations.length,
      active_violation_count: activeViolationCount,
      suppressed_violation_count: suppressedViolationCount,
      out_of_scope_violation_count: outOfScopeViolationCount,
    },
    violations,
  };
}

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/");
}

function uniqueSortedStrings(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}
