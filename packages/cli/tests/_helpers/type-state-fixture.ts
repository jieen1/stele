/**
 * Fixture-runner helpers for the type-state end-to-end test suite
 * (Phase B, T4.5).
 *
 * Each fixture lives under `packages/cli/tests/fixtures/type-state/<N-name>/`
 * and is a self-contained tiny TS project:
 *   - `contract/main.stele`       — declares one or more `(type-state ...)`
 *                                   forms (and optionally `(type-state-binding ...)`)
 *   - `src/*.ts`                  — TypeScript source exercising the rule
 *   - `tsconfig.json`             — minimal compiler config so the extractor
 *                                   can build a `ts.Program`
 *   - `expected-violations.json`  — array of `ExpectedViolation` records
 *
 * `runTypeStateFixture()` loads the contract, extracts the call graph via
 * `tsCallGraphExtractor`, then invokes `evaluateTypeStates({ contract,
 * callGraph, extractor: tsTypeStateInferenceExtractor })`. The runner is
 * intentionally tolerant: if either `@stele/type-state-evaluator` or the TS
 * inference extractor is not yet built (T4.2 or T4.3 in flight), the
 * top-level loader returns `null` and individual tests should skip cleanly.
 *
 * `assertViolationsMatch()` mirrors the trace-policy helper — loose match
 * on `rule_id` (exact), `rule_kind`, `severity`, `priority`, regex on
 * `group_id_pattern`, and substring on `cause.summary_contains`.
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { expect } from "vitest";

import type { Violation } from "@stele/core";
import { loadContract } from "@stele/core";
import type { CallGraph } from "@stele/call-graph-core";
import { tsCallGraphExtractor } from "@stele/backend-typescript";

// ---------------------------------------------------------------------------
// Loose-match expectation type
// ---------------------------------------------------------------------------

/**
 * Loose match for a single expected type-state finding.
 *
 *   - `rule_id`                  — exact match
 *   - `rule_kind`                — exact match (omit to skip)
 *   - `severity`                 — exact match (omit to skip)
 *   - `priority`                 — exact match (omit to skip)
 *   - `group_id_pattern`         — regex tested against actual `group_id`
 *   - `location.path`            — exact match against actual `location.path`
 *   - `cause.summary_contains`   — substring contained in actual `cause.summary`
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

export interface TypeStateFixtureResult {
  readonly contractPath: string;
  readonly callGraph: CallGraph;
  readonly violations: readonly Violation[];
  readonly notices: readonly Violation[];
}

// ---------------------------------------------------------------------------
// Module shape probes — keep us isolated from upstream type drift.
// ---------------------------------------------------------------------------

/**
 * Minimal local model of `evaluateTypeStates` from `@stele/type-state-evaluator`.
 * Used only at the boundary of the dynamic import; nothing else in the
 * codebase should rely on this shape.
 */
interface TypeStateEvaluatorModule {
  evaluateTypeStates: (options: {
    readonly contract: Awaited<ReturnType<typeof loadContract>>;
    readonly callGraph: CallGraph;
    readonly extractor: TypeStateExtractorLike;
    readonly strictMode?: boolean;
  }) => Promise<{
    readonly violations: readonly Violation[];
    readonly notices: readonly Violation[];
  }>;
}

/**
 * Minimal local model of `tsTypeStateInferenceExtractor` from
 * `@stele/backend-typescript`. Treated opaquely — the evaluator drives it.
 */
interface TypeStateExtractorLike {
  readonly language: string;
}

function asTypeStateEvaluatorModule(mod: unknown): TypeStateEvaluatorModule | null {
  if (mod === null || typeof mod !== "object") {
    return null;
  }
  const candidate = (mod as { evaluateTypeStates?: unknown }).evaluateTypeStates;
  if (typeof candidate !== "function") {
    return null;
  }
  return mod as TypeStateEvaluatorModule;
}

function asTypeStateExtractor(value: unknown): TypeStateExtractorLike | null {
  if (value === null || typeof value !== "object") {
    return null;
  }
  const lang = (value as { language?: unknown }).language;
  if (typeof lang !== "string") {
    return null;
  }
  return value as TypeStateExtractorLike;
}

const TYPE_STATE_EVALUATOR_REL = "../../../type-state-evaluator/dist/index.js";
const BACKEND_TS_REL = "../../../backend-typescript/dist/index.js";

/**
 * Dynamic-only import that hides the specifier from TypeScript's static
 * module resolver. `@stele/type-state-evaluator` is intentionally not
 * declared as a `@stele/cli` dependency yet — wiring lives in T4.4 — so a
 * bare `import("@stele/type-state-evaluator")` would not typecheck. We
 * launder the specifier through a typed alias so the lookup happens at
 * runtime only.
 */
const dynamicImport: (specifier: string) => Promise<unknown> = (specifier) =>
  import(/* @vite-ignore */ specifier);

/**
 * Try to import `@stele/type-state-evaluator`. Returns the module when
 * available, otherwise `null` (T4.2 not built). Never throws.
 */
export async function loadTypeStateEvaluator(): Promise<TypeStateEvaluatorModule | null> {
  try {
    const mod: unknown = await dynamicImport("@stele/type-state-evaluator");
    const narrowed = asTypeStateEvaluatorModule(mod);
    if (narrowed !== null) {
      return narrowed;
    }
  } catch {
    /* fall through */
  }
  try {
    const url = new URL(TYPE_STATE_EVALUATOR_REL, import.meta.url).href;
    const mod: unknown = await dynamicImport(url);
    return asTypeStateEvaluatorModule(mod);
  } catch {
    return null;
  }
}

/**
 * Try to import `tsTypeStateInferenceExtractor` from `@stele/backend-typescript`.
 * Returns the extractor when available, otherwise `null` (T4.3 not built).
 * Never throws.
 */
export async function loadTsTypeStateExtractor(): Promise<TypeStateExtractorLike | null> {
  const probe = (modUnknown: unknown): TypeStateExtractorLike | null => {
    if (modUnknown === null || typeof modUnknown !== "object") {
      return null;
    }
    const named = (modUnknown as { tsTypeStateInferenceExtractor?: unknown })
      .tsTypeStateInferenceExtractor;
    return asTypeStateExtractor(named);
  };

  try {
    const mod: unknown = await dynamicImport("@stele/backend-typescript");
    const narrowed = probe(mod);
    if (narrowed !== null) {
      return narrowed;
    }
  } catch {
    /* fall through */
  }
  try {
    const url = new URL(BACKEND_TS_REL, import.meta.url).href;
    const mod: unknown = await dynamicImport(url);
    return probe(mod);
  } catch {
    return null;
  }
}

/**
 * `true` iff both the evaluator and the TS inference extractor are loadable.
 * Use this in test bodies to skip cleanly when either upstream is in flight.
 */
export async function isTypeStateInfrastructureAvailable(): Promise<boolean> {
  const ev = await loadTypeStateEvaluator();
  if (ev === null) {
    return false;
  }
  const ex = await loadTsTypeStateExtractor();
  return ex !== null;
}

// ---------------------------------------------------------------------------
// Fixture loader / runner
// ---------------------------------------------------------------------------

export interface RunTypeStateFixtureOptions {
  readonly strictMode?: boolean;
}

/**
 * Load and evaluate a single type-state fixture directory. Throws when the
 * type-state infrastructure is not importable — callers (the test runner)
 * should pre-check with `isTypeStateInfrastructureAvailable()` and skip.
 */
export async function runTypeStateFixture(
  fixturePath: string,
  options: RunTypeStateFixtureOptions = {},
): Promise<TypeStateFixtureResult> {
  const contractPath = resolve(fixturePath, "contract/main.stele");
  if (!existsSync(contractPath)) {
    throw new Error(
      `type-state-fixture: missing contract file at ${contractPath}`,
    );
  }
  const tsconfigPath = resolve(fixturePath, "tsconfig.json");

  const contract = await loadContract(contractPath);

  const callGraph = await tsCallGraphExtractor.extract({
    projectRoot: fixturePath,
    tsconfigPath: existsSync(tsconfigPath) ? tsconfigPath : undefined,
  });

  const evaluator = await loadTypeStateEvaluator();
  if (evaluator === null) {
    throw new Error(
      "type-state-fixture: @stele/type-state-evaluator not importable. " +
        "Run `pnpm --filter @stele/type-state-evaluator build` first.",
    );
  }
  const extractor = await loadTsTypeStateExtractor();
  if (extractor === null) {
    throw new Error(
      "type-state-fixture: tsTypeStateInferenceExtractor not exported by " +
        "@stele/backend-typescript. Wait for T4.3 to ship and rebuild.",
    );
  }

  const result = await evaluator.evaluateTypeStates({
    contract,
    callGraph,
    extractor,
    strictMode: options.strictMode,
  });

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
 * Returns the index of the first actual that matches `expected`, or `-1`.
 *
 * Field semantics (all optional — only fields present in `expected` are
 * checked):
 *   - `rule_id`              : strict equality.
 *   - `rule_kind`            : strict equality.
 *   - `severity`             : strict equality.
 *   - `priority`             : strict equality.
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
    return "  (no findings emitted)";
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
    return "  (no findings expected)";
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
 * match defined by `findMatchingViolation`. Each expected entry is removed
 * from a working copy of `actuals` once paired, so duplicate expectations
 * and duplicate actuals line up correctly. Fails with a structured diff
 * when counts differ or any expected entry has no matching actual.
 */
export function assertViolationsMatch(
  actuals: readonly Violation[],
  expected: readonly ExpectedViolation[],
): void {
  if (actuals.length !== expected.length) {
    throw new Error(
      `type-state-fixture: finding count mismatch — expected ${expected.length}, got ${actuals.length}.\n` +
        `expected:\n${formatExpectedSummary(expected)}\n` +
        `actual:\n${formatActualSummary(actuals)}`,
    );
  }

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
      `type-state-fixture: ${unmatched.length} expected finding(s) had no matching actual.\n` +
        `unmatched expected:\n${formatExpectedSummary(unmatched)}\n` +
        `remaining actual:\n${formatActualSummary(remaining)}\n` +
        `all actual:\n${formatActualSummary(actuals)}`,
    );
  }

  expect(unmatched.length).toBe(0);
}
