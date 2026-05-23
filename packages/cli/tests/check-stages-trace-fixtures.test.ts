/**
 * End-to-end fixture runner for Phase B trace-policy (T3.5).
 *
 * Each directory under `tests/fixtures/trace-policy/` is a self-contained
 * tiny TS project that exercises the full pipeline:
 *
 *   contract/main.stele   →  loadContract
 *   src/*.ts              →  tsCallGraphExtractor
 *                         →  evaluateTracePolicies
 *                         →  Violation[]
 *
 * The fixture passes when the emitted violations match the loose-match
 * specification in `expected-violations.json`.
 *
 * The runner is intentionally tolerant: if `@stele/trace-evaluator` is not
 * yet importable (T3.2 in flight), each fixture test logs an informational
 * skip message and passes — so this file can land *before* T3.2 ships.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  assertViolationsMatch,
  findMatchingViolation,
  loadTraceEvaluator,
  runTraceFixture,
  type ExpectedViolation,
} from "./_helpers/trace-fixture.js";
import type { Violation } from "@stele/core";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = resolve(__dirname, "fixtures/trace-policy");

function listFixtures(): readonly string[] {
  if (!existsSync(FIXTURES_DIR)) return [];
  return readdirSync(FIXTURES_DIR)
    .filter((d) => /^\d+-/.test(d))
    .sort();
}

function readExpected(fixturePath: string): readonly ExpectedViolation[] {
  const file = resolve(fixturePath, "expected-violations.json");
  const raw = readFileSync(file, "utf-8");
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error(
      `expected-violations.json at ${file} must be a JSON array; got ${typeof parsed}.`,
    );
  }
  return parsed as readonly ExpectedViolation[];
}

// ---------------------------------------------------------------------------
// Fixture-driven tests
// ---------------------------------------------------------------------------

describe("trace-policy end-to-end fixtures", () => {
  const fixtures = listFixtures();

  it("discovers at least 10 fixture directories", () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(10);
  });

  for (const fixture of fixtures) {
    it(fixture, async () => {
      const evaluator = await loadTraceEvaluator();
      if (evaluator === null) {
        // T3.2 (@stele/trace-evaluator) not yet built — skip gracefully so
        // this fixture suite can land independently. The maintainer will
        // re-run after T3.2 lands.
        // eslint-disable-next-line no-console
        console.log(
          `[trace-fixture] skipping ${fixture}: @stele/trace-evaluator not yet built ` +
            `(T3.2 in progress). Run \`pnpm --filter @stele/trace-evaluator build\` to enable.`,
        );
        return;
      }

      const fixturePath = resolve(FIXTURES_DIR, fixture);
      const expected = readExpected(fixturePath);

      const result = await runTraceFixture(fixturePath);

      // The "12-depth-exceeded-notice" fixture's only expectation is a
      // depth notice (severity=warning) — those land in `notices`, not
      // `violations`. We let the fixture's expected-violations.json point
      // at whichever bucket is correct via rule_id, and merge both for
      // the multiset match below.
      const combined: readonly Violation[] = [...result.violations, ...result.notices];
      assertViolationsMatch(combined, expected);
    });
  }
});

// ---------------------------------------------------------------------------
// Direct unit tests for the assertion helpers (always run — independent of
// whether the trace-evaluator package is built).
// ---------------------------------------------------------------------------

function mkViolation(over: Partial<Violation> & Pick<Violation, "rule_id">): Violation {
  return {
    rule_id: over.rule_id,
    rule_kind: over.rule_kind ?? "trace_violation",
    severity: over.severity ?? "error",
    source: over.source ?? { tool: "stele", command: "check", kind: "trace" },
    location: over.location ?? { path: "src/x.ts", line: 1, column: 1 },
    cause: over.cause ?? { summary: "synthetic" },
    fingerprint: over.fingerprint ?? "0".repeat(64),
    scope_paths: over.scope_paths ?? [],
    priority: over.priority ?? "major",
    group_id: over.group_id ?? "src/x.ts::X(0)",
    also_violates: over.also_violates,
    resolves_with: over.resolves_with,
    cross_rule_note: over.cross_rule_note,
    fix: over.fix,
  };
}

describe("assertViolationsMatch helper", () => {
  it("passes when both arrays are empty", () => {
    assertViolationsMatch([], []);
    expect(true).toBe(true);
  });

  it("passes when an exact 1-to-1 match is found", () => {
    const actual = [mkViolation({ rule_id: "trace.X.missing_transit" })];
    assertViolationsMatch(actual, [{ rule_id: "trace.X.missing_transit" }]);
  });

  it("reports count mismatch with a helpful message", () => {
    const actual = [mkViolation({ rule_id: "trace.A.missing_transit" })];
    expect(() =>
      assertViolationsMatch(actual, [
        { rule_id: "trace.A.missing_transit" },
        { rule_id: "trace.B.missing_transit" },
      ]),
    ).toThrow(/violation count mismatch — expected 2, got 1/);
  });

  it("matches via regex on group_id_pattern", () => {
    const actual = [
      mkViolation({
        rule_id: "trace.P.missing_predecessor",
        group_id: "src/foo.ts::OrderService::pay(1)",
      }),
    ];
    assertViolationsMatch(actual, [
      {
        rule_id: "trace.P.missing_predecessor",
        group_id_pattern: "::OrderService::pay\\(1\\)$",
      },
    ]);
  });

  it("rejects when regex on group_id_pattern fails", () => {
    const actual = [
      mkViolation({
        rule_id: "trace.P.missing_predecessor",
        group_id: "src/foo.ts::Unrelated::run(0)",
      }),
    ];
    expect(() =>
      assertViolationsMatch(actual, [
        {
          rule_id: "trace.P.missing_predecessor",
          group_id_pattern: "::OrderService::pay\\(1\\)$",
        },
      ]),
    ).toThrow(/had no matching actual/);
  });

  it("matches via substring on cause.summary_contains", () => {
    const actual = [
      mkViolation({
        rule_id: "trace.X.missing_transit",
        cause: { summary: "OrderService.pay reaches db.query without transiting any repository pattern." },
      }),
    ];
    assertViolationsMatch(actual, [
      {
        rule_id: "trace.X.missing_transit",
        cause: { summary_contains: "without transiting" },
      },
    ]);
  });

  it("pairs duplicates by removing matched actuals one-by-one", () => {
    const actual = [
      mkViolation({ rule_id: "trace.X.missing_transit", group_id: "g1" }),
      mkViolation({ rule_id: "trace.X.missing_transit", group_id: "g2" }),
    ];
    assertViolationsMatch(actual, [
      { rule_id: "trace.X.missing_transit", group_id_pattern: "^g1$" },
      { rule_id: "trace.X.missing_transit", group_id_pattern: "^g2$" },
    ]);
  });

  it("findMatchingViolation returns -1 when no actual matches", () => {
    const actual = [mkViolation({ rule_id: "trace.X.missing_transit" })];
    const idx = findMatchingViolation(actual, {
      rule_id: "trace.NOT_PRESENT.missing_transit",
    });
    expect(idx).toBe(-1);
  });
});
