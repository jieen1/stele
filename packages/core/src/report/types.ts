import { createHash } from "node:crypto";

function uniqueSortedStrings(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

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
  baseline_path?: string;
  line?: number;
  column?: number;
};

export type FailureWitnessOperator = "forall" | "exists" | "where" | "none";

/**
 * Single-step failure witness for quantifier operators.
 *
 * Emitted by language backend runtimes when `forall` / `exists` / `where` /
 * `none` fail at runtime, then surfaced through `ViolationCause.failure_witness`
 * so `stele why <id>` can show "which element, which value, which predicate".
 *
 * Schema is shared across backends; see EP07 §3.1
 * (docs/design/phase-1/07-stele-why-witness.md).
 */
export type FailureWitness = {
  operator: FailureWitnessOperator;
  collection_size: number;
  failed_at_index?: number;
  failed_item?: unknown;
  predicate_source?: string;
  truncated: boolean;
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
  failure_witness?: FailureWitness;
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

export type ContractNoticeKind = "above-ideal";

/**
 * Advisory notice: emitted when a metric exceeds the ideal boundary but
 * remains within the max boundary. Unlike violations, notices do not cause
 * non-zero exit codes.
 */
export type ContractNotice = {
  id: string;
  kind: ContractNoticeKind;
  nodeId: string;
  target: string;
  metric: string;
  value: number;
  ideal: number;
  max: number;
  summary: string;
};

export type ViolationReport = {
  schema_version: "1";
  tool: string;
  command: string;
  ok: boolean;
  summary: ViolationReportSummary;
  violations: Violation[];
  notices: ContractNotice[];
};

export type ViolationReportInput = Omit<ViolationReport, "schema_version" | "violations" | "notices"> & {
  violations: Array<Violation | ViolationInput>;
  notices?: ContractNotice[];
};

/**
 * Single-step trace node for CDL expression evaluation.
 *
 * Each node records the original CDL sub-expression, whether it evaluated
 * true/false/unknown, and an optional human explanation from the (explain)
 * operator.
 */
export type ExplainTrace = {
  expression: string;
  evaluated: boolean | null;
  children?: ExplainTrace[];
  explanation?: string;
  failureDetail?: string;
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
    schema_version: "1",
    tool: input.tool,
    command: input.command,
    ok: input.ok,
    summary: {
      ...input.summary,
      violation_count: input.violations.length,
    },
    violations: input.violations.map((violation) => ("fingerprint" in violation ? cloneViolation(violation) : createViolation(violation))),
    notices: input.notices ?? [],
  };
}

export function buildViolationFingerprint(violation: Omit<Violation, "fingerprint" | "status" | "suppressed_by">): string {
  // Only stable fields participate in fingerprint — human-readable text (cause.summary/detail,
  // fix.summary) are excluded so baseline drift is not triggered by copywriting changes.
  const payload = {
    rule_id: violation.rule_id,
    rule_kind: violation.rule_kind,
    severity: violation.severity,
    source: violation.source,
    location: violation.location,
    cause: buildFingerprintCause(violation.cause),
    scope_paths: uniqueSortedStrings(violation.scope_paths),
  };

  return createHash("sha256").update(stableStringify(payload)).digest("hex");
}

/**
 * Extract only stable identifiers from the cause for fingerprinting.
 * Human-readable summary/detail are deliberately excluded.
 */
function buildFingerprintCause(cause: ViolationCause): ViolationCause {
  return {
    summary: "",
    missing: cause.missing === undefined ? undefined : uniqueSortedStrings(cause.missing),
    changed: cause.changed === undefined ? undefined : uniqueSortedStrings(cause.changed),
    extra: cause.extra === undefined ? undefined : uniqueSortedStrings(cause.extra),
    new_files: cause.new_files === undefined ? undefined : uniqueSortedStrings(cause.new_files),
    failure_witness: cause.failure_witness === undefined ? undefined : { ...cause.failure_witness },
  };
}

function normalizeCause(cause: ViolationCause): ViolationCause {
  return {
    ...cause,
    missing: cause.missing === undefined ? undefined : uniqueSortedStrings(cause.missing),
    changed: cause.changed === undefined ? undefined : uniqueSortedStrings(cause.changed),
    extra: cause.extra === undefined ? undefined : uniqueSortedStrings(cause.extra),
    new_files: cause.new_files === undefined ? undefined : uniqueSortedStrings(cause.new_files),
    failure_witness: cause.failure_witness === undefined ? undefined : { ...cause.failure_witness },
  };
}

// ---------------------------------------------------------------------------
// FailureWitness helpers (EP07 §3.2)
// ---------------------------------------------------------------------------

const MAX_WITNESS_BYTES = 64 * 1024;
const MAX_PREDICATE_SOURCE_BYTES = 4 * 1024;
const MAX_FAILED_ITEM_BYTES = 8 * 1024;
const MAX_ARRAY_ITEMS = 100;

const DEFAULT_REDACTION_PATTERNS: readonly RegExp[] = [
  /password/i,
  /token/i,
  /secret/i,
  /api[_-]?key/i,
];

/**
 * Defensive serialization for failure-witness payloads.
 *
 * - Walks the tree up to `maxDepth`; deeper subtrees become the sentinel
 *   string `"<depth-limit>"` and `truncated` is set.
 * - Arrays longer than `MAX_ARRAY_ITEMS` (100) are sliced and `truncated` is
 *   set.
 * - Object keys matching any of `redactionPatterns` (case-insensitive by
 *   default for `password|token|secret|api[_-]?key`) are replaced with the
 *   sentinel string `"<redacted>"` regardless of their nested value.
 * - The whole serialized JSON length is capped at 64 KB; on overflow the
 *   payload is replaced with `{ _truncated, _original_size }` and `truncated`
 *   is set.
 *
 * Returns the prepared shallow value plus a `truncated` boolean so callers
 * can record it on `FailureWitness.truncated`. Mirrors Python `_safe_serialize`.
 */
export function safeSerialize(
  value: unknown,
  maxDepth: number,
  redactionPatterns: readonly RegExp[] = DEFAULT_REDACTION_PATTERNS,
): { serialized: unknown; truncated: boolean } {
  let truncated = false;

  const visit = (node: unknown, depth: number): unknown => {
    if (depth > maxDepth) {
      truncated = true;
      return "<depth-limit>";
    }
    if (node === null || node === undefined) {
      return node;
    }
    if (typeof node !== "object") {
      return node;
    }
    if (Array.isArray(node)) {
      if (node.length > MAX_ARRAY_ITEMS) {
        truncated = true;
      }
      const limited = node.slice(0, MAX_ARRAY_ITEMS);
      return limited.map((entry) => visit(entry, depth + 1));
    }
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(node as Record<string, unknown>)) {
      if (redactionPatterns.some((pattern) => pattern.test(key))) {
        out[key] = "<redacted>";
        continue;
      }
      out[key] = visit(entry, depth + 1);
    }
    return out;
  };

  let result = visit(value, 0);
  let serialized: string;
  try {
    serialized = JSON.stringify(result);
  } catch {
    truncated = true;
    return { serialized: { _truncated: true, _serialize_error: true }, truncated };
  }
  if (serialized !== undefined && serialized.length > MAX_WITNESS_BYTES) {
    truncated = true;
    result = { _truncated: true, _original_size: serialized.length };
  }
  return { serialized: result, truncated };
}

/**
 * Assemble a `FailureWitness`.
 *
 * Centralises field-level capping (predicate_source ≤ 4 KB, failed_item ≤ 8
 * KB) so all backends emit the same shape. Used by `@stele/backend-typescript`
 * runtime and equivalent Python helper.
 */
export function buildFailureWitness(
  operator: FailureWitnessOperator,
  collectionSize: number,
  failedIndex: number | undefined,
  failedItem: unknown,
  predicateSource: string,
): FailureWitness {
  let truncated = false;

  let predicate: string | undefined = predicateSource;
  if (predicate !== undefined && predicate.length > MAX_PREDICATE_SOURCE_BYTES) {
    predicate = `${predicate.slice(0, MAX_PREDICATE_SOURCE_BYTES)}...<truncated>`;
    truncated = true;
  }

  let item: unknown = undefined;
  if (failedItem !== undefined) {
    const serialized = safeSerialize(failedItem, 2);
    item = serialized.serialized;
    if (serialized.truncated) {
      truncated = true;
    }
    const itemBytes = JSON.stringify(item ?? null);
    if (itemBytes.length > MAX_FAILED_ITEM_BYTES) {
      item = { _truncated: true, _original_size: itemBytes.length };
      truncated = true;
    }
  }

  const witness: FailureWitness = {
    operator,
    collection_size: collectionSize,
    truncated,
  };
  if (failedIndex !== undefined) {
    witness.failed_at_index = failedIndex;
  }
  if (item !== undefined) {
    witness.failed_item = item;
  }
  if (predicate !== undefined) {
    witness.predicate_source = predicate;
  }
  return witness;
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

/**
 * Stable JSON.stringify variant: sorts object keys recursively so byte output
 * is stable regardless of property insertion order. Used by violation
 * fingerprinting (this file) and the EP05 hash manifest (operator registry +
 * config hashing) — both must be deterministic across runs.
 */
export function stableStringify(value: unknown): string {
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
