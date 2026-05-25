/**
 * Fixture-runner helpers for the effect-policy end-to-end test suite
 * (Phase B, T5.5).
 *
 * Each fixture lives under `packages/cli/tests/fixtures/effect/<N-name>/`
 * and is a self-contained tiny TS project:
 *   - `contract/main.stele`       — declares (effect-declarations),
 *                                   (effect-annotation), (effect-policy),
 *                                   and optionally (effect-suppression)
 *   - `src/*.ts`                  — TypeScript source exercising the rule
 *   - `tsconfig.json`             — minimal compiler config so the extractor
 *                                   can build a `ts.Program`
 *   - `expected-violations.json`  — array of `ExpectedViolation` records,
 *                                   OR a single `{ "expected_parse_error": "E0357" }`
 *                                   marker for parse-error fixtures
 *
 * `runEffectFixture()` loads the contract, extracts the call graph via
 * `tsCallGraphExtractor`, then invokes `evaluateEffects({ contract,
 * callGraph, extractor: tsEffectAnnotationExtractor })`.
 *
 * The runner is intentionally tolerant: if either `@stele/effect-evaluator`
 * (T5.2) or `tsEffectAnnotationExtractor` (T5.3) is not yet built, the
 * `isEffectInfrastructureAvailable()` probe returns `false` and the caller
 * should skip cleanly. This lets the fixture suite land independently of
 * the upstream tasks.
 *
 * Closeout 1 (2026-05-25): the prior strictMode fixture knob is gone.
 * Unresolved-call emission is now gated by per-policy `target-scope`
 * membership inside the evaluator, so there is nothing for a fixture to
 * opt into or out of. The legacy `.fixture-config.json` file is ignored.
 *
 * Parse-error fixtures: a fixture whose `expected-violations.json` is a
 * single object with a string `expected_parse_error` field (instead of an
 * array) expects `loadContract` to throw a `SteleError` whose `.code`
 * equals that marker. `assertViolationsMatch()` is not used for those — the
 * runner handles them via `runEffectFixtureExpectingParseError()`.
 */

import { existsSync, readFileSync } from "node:fs";
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
 * Loose match for a single expected effect finding.
 *
 *   - `rule_id`                  — exact match
 *   - `rule_kind`                — exact match (omit to skip)
 *   - `rule_kind_pattern`        — regex on actual `rule_kind` (omit to skip)
 *   - `severity`                 — exact match (omit to skip)
 *   - `priority`                 — exact match (omit to skip)
 *   - `group_id_pattern`         — regex tested against actual `group_id`
 *   - `location.path`            — exact match against actual `location.path`
 *   - `cause.summary_contains`   — substring contained in actual `cause.summary`
 */
export interface ExpectedViolation {
  readonly rule_id: string;
  readonly rule_kind?: string;
  readonly rule_kind_pattern?: string;
  readonly severity?: "error" | "warning" | "info";
  readonly priority?: "blocking" | "major" | "minor";
  readonly group_id_pattern?: string;
  readonly location?: { readonly path?: string };
  readonly cause?: { readonly summary_contains?: string };
}

/**
 * Parse-error marker recorded inside `expected-violations.json` when the
 * fixture is meant to fail contract loading rather than emit findings.
 */
export interface ExpectedParseErrorMarker {
  readonly expected_parse_error: string;
}

export type ExpectedFixtureSpec =
  | readonly ExpectedViolation[]
  | ExpectedParseErrorMarker;

export interface EffectFixtureResult {
  readonly contractPath: string;
  readonly callGraph: CallGraph;
  readonly violations: readonly Violation[];
  readonly notices: readonly Violation[];
}

// ---------------------------------------------------------------------------
// Module shape probes — keep us isolated from upstream type drift.
// ---------------------------------------------------------------------------

interface EffectEvaluatorModule {
  evaluateEffects: (options: {
    readonly contract: Awaited<ReturnType<typeof loadContract>>;
    readonly callGraph: CallGraph;
    readonly extractor: EffectAnnotationExtractorLike;
  }) => Promise<{
    readonly violations: readonly Violation[];
    readonly notices: readonly Violation[];
  }>;
}

/**
 * Minimal local model of `tsEffectAnnotationExtractor` from
 * `@stele/backend-typescript`. Treated opaquely — the evaluator drives it.
 */
interface EffectAnnotationExtractorLike {
  readonly language: string;
}

function asEffectEvaluatorModule(mod: unknown): EffectEvaluatorModule | null {
  if (mod === null || typeof mod !== "object") {
    return null;
  }
  const candidate = (mod as { evaluateEffects?: unknown }).evaluateEffects;
  if (typeof candidate !== "function") {
    return null;
  }
  return mod as EffectEvaluatorModule;
}

function asEffectAnnotationExtractor(
  value: unknown,
): EffectAnnotationExtractorLike | null {
  if (value === null || typeof value !== "object") {
    return null;
  }
  const lang = (value as { language?: unknown }).language;
  if (typeof lang !== "string") {
    return null;
  }
  return value as EffectAnnotationExtractorLike;
}

const EFFECT_EVALUATOR_REL = "../../../effect-evaluator/dist/index.js";
const BACKEND_TS_REL = "../../../backend-typescript/dist/index.js";

/**
 * Dynamic-only import that hides the specifier from TypeScript's static
 * module resolver. `@stele/effect-evaluator` is intentionally not declared
 * as a `@stele/cli` dependency yet — wiring lives in T5.4 — so a bare
 * `import("@stele/effect-evaluator")` would not typecheck. We launder the
 * specifier through a typed alias so the lookup happens at runtime only.
 */
const dynamicImport: (specifier: string) => Promise<unknown> = (specifier) =>
  import(/* @vite-ignore */ specifier);

/**
 * Try to import `@stele/effect-evaluator`. Returns the module when
 * available, otherwise `null` (T5.2 not built). Never throws.
 */
export async function loadEffectEvaluator(): Promise<EffectEvaluatorModule | null> {
  try {
    const mod: unknown = await dynamicImport("@stele/effect-evaluator");
    const narrowed = asEffectEvaluatorModule(mod);
    if (narrowed !== null) {
      return narrowed;
    }
  } catch {
    /* fall through */
  }
  try {
    const url = new URL(EFFECT_EVALUATOR_REL, import.meta.url).href;
    const mod: unknown = await dynamicImport(url);
    return asEffectEvaluatorModule(mod);
  } catch {
    return null;
  }
}

/**
 * Try to import `tsEffectAnnotationExtractor` from `@stele/backend-typescript`.
 * Returns the extractor when available, otherwise `null` (T5.3 not built).
 * Never throws.
 */
export async function loadTsEffectExtractor(): Promise<EffectAnnotationExtractorLike | null> {
  const probe = (modUnknown: unknown): EffectAnnotationExtractorLike | null => {
    if (modUnknown === null || typeof modUnknown !== "object") {
      return null;
    }
    const named = (modUnknown as { tsEffectAnnotationExtractor?: unknown })
      .tsEffectAnnotationExtractor;
    return asEffectAnnotationExtractor(named);
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
 * `true` iff both the evaluator and the TS effect-annotation extractor are
 * loadable. Use this in test bodies to skip cleanly when either upstream is
 * in flight.
 */
export async function isEffectInfrastructureAvailable(): Promise<boolean> {
  const ev = await loadEffectEvaluator();
  if (ev === null) {
    return false;
  }
  const ex = await loadTsEffectExtractor();
  return ex !== null;
}

// ---------------------------------------------------------------------------
// Fixture-config detection (Closeout 1: no per-fixture knobs)
// ---------------------------------------------------------------------------

/**
 * Closeout 1 (2026-05-25) removed the strictMode knob. Loader is retained
 * as a zero-arg no-op for source compatibility with the fixture runner
 * call site; any legacy `.fixture-config.json` is ignored.
 */
export function loadFixtureConfig(_fixturePath: string): Record<string, never> {
  return {};
}

// ---------------------------------------------------------------------------
// Expected-spec loading + parse-error marker detection
// ---------------------------------------------------------------------------

/**
 * Load `expected-violations.json` and disambiguate between an array of
 * `ExpectedViolation` and a single `ExpectedParseErrorMarker` object.
 */
export function loadExpectedSpec(fixturePath: string): ExpectedFixtureSpec {
  const file = resolve(fixturePath, "expected-violations.json");
  const raw = readFileSync(file, "utf-8");
  const parsed: unknown = JSON.parse(raw);
  if (Array.isArray(parsed)) {
    return parsed as readonly ExpectedViolation[];
  }
  if (parsed !== null && typeof parsed === "object") {
    const marker = (parsed as { expected_parse_error?: unknown })
      .expected_parse_error;
    if (typeof marker === "string") {
      return { expected_parse_error: marker };
    }
  }
  throw new Error(
    `effect-fixture: expected-violations.json at ${file} must be either a JSON array of ExpectedViolation records or a { "expected_parse_error": "Exxxx" } marker.`,
  );
}

export function isParseErrorSpec(
  spec: ExpectedFixtureSpec,
): spec is ExpectedParseErrorMarker {
  return !Array.isArray(spec) && "expected_parse_error" in spec;
}

// ---------------------------------------------------------------------------
// Fixture loader / runner
// ---------------------------------------------------------------------------

// Closeout 1: kept as an empty struct so call sites that pass `{}` still
// typecheck. There are no per-call knobs to thread anymore.
export interface RunEffectFixtureOptions {
  readonly _placeholder?: never;
}

/**
 * Load and evaluate a single effect fixture directory. Throws when the
 * effect infrastructure is not importable — callers (the test runner)
 * should pre-check with `isEffectInfrastructureAvailable()` and skip.
 */
export async function runEffectFixture(
  fixturePath: string,
  _options: RunEffectFixtureOptions = {},
): Promise<EffectFixtureResult> {
  const contractPath = resolve(fixturePath, "contract/main.stele");
  if (!existsSync(contractPath)) {
    throw new Error(
      `effect-fixture: missing contract file at ${contractPath}`,
    );
  }
  const tsconfigPath = resolve(fixturePath, "tsconfig.json");

  const contract = await loadContract(contractPath);

  const callGraph = await tsCallGraphExtractor.extract({
    projectRoot: fixturePath,
    tsconfigPath: existsSync(tsconfigPath) ? tsconfigPath : undefined,
  });

  const evaluator = await loadEffectEvaluator();
  if (evaluator === null) {
    throw new Error(
      "effect-fixture: @stele/effect-evaluator not importable. " +
        "Run `pnpm --filter @stele/effect-evaluator build` first.",
    );
  }
  const extractor = await loadTsEffectExtractor();
  if (extractor === null) {
    throw new Error(
      "effect-fixture: tsEffectAnnotationExtractor not exported by " +
        "@stele/backend-typescript. Wait for T5.3 to ship and rebuild.",
    );
  }

  const result = await evaluator.evaluateEffects({
    contract,
    callGraph,
    extractor,
  });

  return {
    contractPath,
    callGraph,
    violations: result.violations,
    notices: result.notices,
  };
}

// ---------------------------------------------------------------------------
// Parse-error fixture runner
// ---------------------------------------------------------------------------

/**
 * Drive a parse-error fixture: load the contract and assert that
 * `loadContract` (or its delegate validators) throws a SteleError whose
 * `.code` matches `expected.expected_parse_error`. Returns the thrown
 * error on success, throws on mismatch.
 */
export async function runEffectFixtureExpectingParseError(
  fixturePath: string,
  expected: ExpectedParseErrorMarker,
): Promise<{ readonly code: string; readonly message: string }> {
  const contractPath = resolve(fixturePath, "contract/main.stele");
  if (!existsSync(contractPath)) {
    throw new Error(
      `effect-fixture: missing contract file at ${contractPath}`,
    );
  }

  let thrown: unknown;
  try {
    await loadContract(contractPath);
  } catch (err) {
    thrown = err;
  }

  if (thrown === undefined) {
    throw new Error(
      `effect-fixture: expected loadContract to throw ${expected.expected_parse_error} ` +
        `for fixture ${fixturePath}, but it returned successfully.`,
    );
  }

  const errAsObj = thrown as { code?: unknown; message?: unknown };
  const actualCode = typeof errAsObj.code === "string" ? errAsObj.code : "";
  const actualMessage =
    typeof errAsObj.message === "string" ? errAsObj.message : String(thrown);

  if (actualCode !== expected.expected_parse_error) {
    throw new Error(
      `effect-fixture: expected loadContract to throw ${expected.expected_parse_error}, ` +
        `got code=${actualCode || "<none>"} message="${actualMessage}".`,
    );
  }

  return { code: actualCode, message: actualMessage };
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
 *   - `rule_kind_pattern`    : `RegExp(pattern)` test against `rule_kind`.
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
    if (expected.rule_kind_pattern !== undefined) {
      const re = new RegExp(expected.rule_kind_pattern);
      if (!re.test(actual.rule_kind ?? "")) continue;
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
        `  [${i}] rule_id=${v.rule_id} rule_kind=${v.rule_kind} group_id=${
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
        (e.rule_kind !== undefined ? ` rule_kind=${e.rule_kind}` : "") +
        (e.rule_kind_pattern !== undefined
          ? ` rule_kind_pattern=${e.rule_kind_pattern}`
          : "") +
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
 *
 * Accepts the union `ExpectedFixtureSpec`; if a parse-error marker is
 * provided here (the test runner should normally route those through
 * `runEffectFixtureExpectingParseError` instead), throws a clear error.
 */
export function assertViolationsMatch(
  actuals: readonly Violation[],
  expected: ExpectedFixtureSpec,
): void {
  if (isParseErrorSpec(expected)) {
    throw new Error(
      `effect-fixture: assertViolationsMatch was called with a parse-error marker ` +
        `(expected_parse_error=${expected.expected_parse_error}). Use ` +
        `runEffectFixtureExpectingParseError() for this fixture instead.`,
    );
  }

  const expectedList = expected;
  if (actuals.length !== expectedList.length) {
    throw new Error(
      `effect-fixture: finding count mismatch — expected ${expectedList.length}, got ${actuals.length}.\n` +
        `expected:\n${formatExpectedSummary(expectedList)}\n` +
        `actual:\n${formatActualSummary(actuals)}`,
    );
  }

  const remaining = actuals.slice();
  const unmatched: ExpectedViolation[] = [];
  for (const e of expectedList) {
    const idx = findMatchingViolation(remaining, e);
    if (idx < 0) {
      unmatched.push(e);
      continue;
    }
    remaining.splice(idx, 1);
  }

  if (unmatched.length > 0) {
    throw new Error(
      `effect-fixture: ${unmatched.length} expected finding(s) had no matching actual.\n` +
        `unmatched expected:\n${formatExpectedSummary(unmatched)}\n` +
        `remaining actual:\n${formatActualSummary(remaining)}\n` +
        `all actual:\n${formatActualSummary(actuals)}`,
    );
  }

  expect(unmatched.length).toBe(0);
}
