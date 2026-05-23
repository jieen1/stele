/**
 * Fixture-runner helpers for the trace-policy end-to-end test suite
 * (Phase B, T3.5).
 *
 * Each fixture lives under `packages/cli/tests/fixtures/trace-policy/<N-name>/`
 * and is a self-contained tiny TS project:
 *   - `contract/main.stele`   — declares one or more `(trace-policy ...)`
 *   - `src/*.ts`              — TypeScript source exercising the rule
 *   - `tsconfig.json`         — minimal compiler config so the extractor
 *                               can build a `ts.Program`
 *   - `expected-violations.json` — array of `ExpectedViolation` records
 *
 * `runTraceFixture()` loads the contract, extracts the call graph, evaluates
 * the trace policies, and returns the result. `assertViolationsMatch()`
 * performs a loose-match assertion (regex on group_id, substring on cause
 * summary, exact match on rule_id / severity / priority).
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { expect } from "vitest";
import type { Violation } from "@stele/core";
import { loadContract } from "@stele/core";
import type { CallGraph } from "@stele/call-graph-core";
import { tsCallGraphExtractor } from "@stele/backend-typescript";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Loose match for a single expected violation.
 *
 *   - `rule_id`               — exact match
 *   - `severity`              — exact match
 *   - `priority`              — exact match (omit to skip the assertion)
 *   - `group_id_pattern`      — regex tested against actual `group_id`
 *   - `location.path`         — exact match against actual `location.path`
 *   - `cause.summary_contains` — substring contained in actual `cause.summary`
 */
export interface ExpectedViolation {
  readonly rule_id: string;
  readonly rule_kind?: string;
  readonly severity?: "error" | "warning" | "info";
  readonly priority?: "blocking" | "major" | "minor";
  readonly group_id_pattern?: string;
  readonly location?: { readonly path?: string };
  readonly cause?: { readonly summary_contains?: string };
}

export interface TraceFixtureResult {
  readonly contractPath: string;
  readonly callGraph: CallGraph;
  readonly violations: readonly Violation[];
  readonly notices: readonly Violation[];
}

// ---------------------------------------------------------------------------
// Dynamic loader for @stele/trace-evaluator
// ---------------------------------------------------------------------------

/**
 * Probe whether the trace-evaluator package is built and importable.
 *
 * The fixture runner is intentionally tolerant: T3.5 ships *before* T3.2 is
 * guaranteed-done, so we resolve `@stele/trace-evaluator` via the workspace
 * relative path (which works without an explicit package.json dep) and gate
 * each test on its availability.
 */
type EvaluateTraceFn = (options: {
  contract: Parameters<typeof import("@stele/core").loadContract> extends unknown
    ? unknown
    : never;
  callGraph: CallGraph;
}) => {
  readonly violations: readonly Violation[];
  readonly notices: readonly Violation[];
  readonly stats: {
    readonly policiesEvaluated: number;
    readonly pathsEnumeratedTotal: number;
    readonly pathsCappedTotal: number;
  };
};

// `evaluateTracePolicies` from @stele/trace-evaluator. We can't import the
// type statically (it would link a hard dep), so we model it locally.
interface TraceEvaluatorModule {
  evaluateTracePolicies: (options: {
    readonly contract: Awaited<ReturnType<typeof loadContract>>;
    readonly callGraph: CallGraph;
    readonly maxDepth?: number;
    readonly maxPaths?: number;
  }) => {
    readonly violations: readonly Violation[];
    readonly notices: readonly Violation[];
    readonly stats: {
      readonly policiesEvaluated: number;
      readonly pathsEnumeratedTotal: number;
      readonly pathsCappedTotal: number;
    };
  };
}

// Defensive cast helper: narrows an unknown imported module to the shape we
// need without leaking `any` into call sites.
function asTraceEvaluatorModule(mod: unknown): TraceEvaluatorModule | null {
  if (mod === null || typeof mod !== "object") {
    return null;
  }
  const candidate = (mod as { evaluateTracePolicies?: unknown }).evaluateTracePolicies;
  if (typeof candidate !== "function") {
    return null;
  }
  return mod as TraceEvaluatorModule;
}

const TRACE_EVALUATOR_REL = "../../../trace-evaluator/dist/index.js";

/**
 * Try to import `@stele/trace-evaluator`. Returns the module when available,
 * otherwise `null` (T3.2 has not yet shipped). Never throws.
 */
export async function loadTraceEvaluator(): Promise<TraceEvaluatorModule | null> {
  // First, try the workspace package id (works once the consumer package
  // declares the dep — production code in T3.3 will). Fall back to the
  // relative path inside the monorepo so this test runs even when no dep
  // is declared.
  try {
    const mod: unknown = await import("@stele/trace-evaluator");
    const narrowed = asTraceEvaluatorModule(mod);
    if (narrowed !== null) {
      return narrowed;
    }
  } catch {
    // fall through
  }
  try {
    const mod: unknown = await import(
      /* @vite-ignore */ new URL(TRACE_EVALUATOR_REL, import.meta.url).href
    );
    return asTraceEvaluatorModule(mod);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Fixture loader / runner
// ---------------------------------------------------------------------------

export interface RunTraceFixtureOptions {
  readonly fixturePath: string;
}

/**
 * Load and evaluate a single trace-policy fixture directory. Throws when the
 * trace-evaluator package is not importable — callers (the test runner)
 * should pre-check with `loadTraceEvaluator()` and skip cleanly.
 */
export async function runTraceFixture(
  fixturePath: string,
): Promise<TraceFixtureResult> {
  const contractPath = resolve(fixturePath, "contract/main.stele");
  if (!existsSync(contractPath)) {
    throw new Error(
      `trace-fixture: missing contract file at ${contractPath}`,
    );
  }
  const tsconfigPath = resolve(fixturePath, "tsconfig.json");

  const contract = await loadContract(contractPath);

  const callGraph = await tsCallGraphExtractor.extract({
    projectRoot: fixturePath,
    tsconfigPath: existsSync(tsconfigPath) ? tsconfigPath : undefined,
  });

  const evaluator = await loadTraceEvaluator();
  if (evaluator === null) {
    throw new Error(
      "trace-fixture: @stele/trace-evaluator not importable. " +
        "Run `pnpm --filter @stele/trace-evaluator build` first.",
    );
  }

  const result = evaluator.evaluateTracePolicies({ contract, callGraph });

  return {
    contractPath,
    callGraph,
    violations: result.violations,
    notices: result.notices,
  };
}

// ---------------------------------------------------------------------------
// Matchers
// ---------------------------------------------------------------------------

/**
 * Test that a single expected violation has at least one match among the
 * actuals. Returns the matching index on success, `-1` on failure.
 *
 * Field semantics (all optional — only fields present in `expected` are
 * checked):
 *   - `rule_id`              : strict equality.
 *   - `severity`             : strict equality.
 *   - `priority`             : strict equality.
 *   - `rule_kind`            : strict equality.
 *   - `group_id_pattern`     : `RegExp(pattern)` test against `group_id ?? ""`.
 *   - `location.path`        : strict equality against `actual.location.path`.
 *   - `cause.summary_contains` : substring contained in `actual.cause.summary`.
 */
export function findMatchingViolation(
  actuals: readonly Violation[],
  expected: ExpectedViolation,
): number {
  for (let i = 0; i < actuals.length; i++) {
    const actual = actuals[i];
    if (actual === undefined) continue;
    if (actual.rule_id !== expected.rule_id) continue;
    if (
      expected.rule_kind !== undefined &&
      actual.rule_kind !== expected.rule_kind
    ) {
      continue;
    }
    if (
      expected.severity !== undefined &&
      actual.severity !== expected.severity
    ) {
      continue;
    }
    if (
      expected.priority !== undefined &&
      actual.priority !== expected.priority
    ) {
      continue;
    }
    if (expected.group_id_pattern !== undefined) {
      const re = new RegExp(expected.group_id_pattern);
      if (!re.test(actual.group_id ?? "")) continue;
    }
    if (
      expected.location?.path !== undefined &&
      actual.location.path !== expected.location.path
    ) {
      continue;
    }
    if (expected.cause?.summary_contains !== undefined) {
      if (!actual.cause.summary.includes(expected.cause.summary_contains)) {
        continue;
      }
    }
    return i;
  }
  return -1;
}

function formatActualSummary(actuals: readonly Violation[]): string {
  if (actuals.length === 0) {
    return "  (no violations emitted)";
  }
  return actuals
    .map(
      (v, i) =>
        `  [${i}] rule_id=${v.rule_id} group_id=${
          v.group_id ?? ""
        } severity=${v.severity} priority=${v.priority ?? ""} ` +
        `path=${v.location.path ?? ""} cause="${v.cause.summary}"`,
    )
    .join("\n");
}

function formatExpectedSummary(expected: readonly ExpectedViolation[]): string {
  if (expected.length === 0) {
    return "  (no violations expected)";
  }
  return expected
    .map(
      (e, i) =>
        `  [${i}] rule_id=${e.rule_id}` +
        (e.group_id_pattern !== undefined
          ? ` group_id_pattern=${e.group_id_pattern}`
          : "") +
        (e.severity !== undefined ? ` severity=${e.severity}` : "") +
        (e.priority !== undefined ? ` priority=${e.priority}` : "") +
        (e.cause?.summary_contains !== undefined
          ? ` summary_contains="${e.cause.summary_contains}"`
          : ""),
    )
    .join("\n");
}

/**
 * Assert that `actuals` matches `expected` as a multiset under the loose
 * match defined by `findMatchingViolation`. Each expected violation is
 * removed from a working copy of `actuals` as it is matched, so duplicate
 * expectations and duplicate actuals pair up correctly. Fails with a
 * structured diff message when counts differ or any expected violation
 * cannot find a match.
 */
export function assertViolationsMatch(
  actuals: readonly Violation[],
  expected: readonly ExpectedViolation[],
): void {
  // 1. Counts.
  if (actuals.length !== expected.length) {
    throw new Error(
      `trace-fixture: violation count mismatch — expected ${expected.length}, got ${actuals.length}.\n` +
        `expected:\n${formatExpectedSummary(expected)}\n` +
        `actual:\n${formatActualSummary(actuals)}`,
    );
  }

  // 2. Pairing — match each expected to a unique actual.
  const remaining = actuals.slice();
  const unmatched: ExpectedViolation[] = [];
  for (const e of expected) {
    const idx = findMatchingViolation(remaining, e);
    if (idx < 0) {
      unmatched.push(e);
      continue;
    }
    remaining.splice(idx, 1);
  }

  if (unmatched.length > 0) {
    throw new Error(
      `trace-fixture: ${unmatched.length} expected violation(s) had no matching actual.\n` +
        `unmatched expected:\n${formatExpectedSummary(unmatched)}\n` +
        `remaining actual:\n${formatActualSummary(remaining)}\n` +
        `all actual:\n${formatActualSummary(actuals)}`,
    );
  }

  // Sanity hook so this helper participates in vitest expectation accounting
  // even on trivial pass.
  expect(unmatched.length).toBe(0);
}
