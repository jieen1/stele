/**
 * End-to-end fixture runner for Phase B type-state (T4.5).
 *
 * Each directory under `tests/fixtures/type-state/` is a self-contained
 * tiny TS project that exercises the full pipeline:
 *
 *   contract/main.stele   →  loadContract
 *   src/*.ts              →  tsCallGraphExtractor
 *                         →  tsTypeStateInferenceExtractor (T4.3)
 *                         →  evaluateTypeStates (T4.2)
 *                         →  Violation[] / notices[]
 *
 * The fixture passes when the emitted findings match the loose-match
 * specification in `expected-violations.json`.
 *
 * The runner is intentionally tolerant: if either `@stele/type-state-evaluator`
 * (T4.2) or `tsTypeStateInferenceExtractor` (T4.3) is not yet importable,
 * every fixture test logs an informational skip message and passes — so this
 * file can land *before* T4.3 ships.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import type { Violation } from "@stele/core";
import {
  assertViolationsMatch,
  findMatchingViolation,
  isTypeStateInfrastructureAvailable,
  runTypeStateFixture,
  type ExpectedViolation,
} from "./_helpers/type-state-fixture.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = resolve(__dirname, "fixtures/type-state");

/**
 * Fixture names that should be evaluated in lenient mode (strictMode=false).
 * Inference failures become notices (severity=warning) instead of violations
 * in this mode.
 */
const LENIENT_FIXTURES = new Set<string>([
  "08-inference-fail-lenient-notice",
]);

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

describe("type-state end-to-end fixtures", () => {
  const fixtures = listFixtures();

  it("discovers at least 10 fixture directories", () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(10);
  });

  for (const fixture of fixtures) {
    it(fixture, async () => {
      if (!(await isTypeStateInfrastructureAvailable())) {
        // Round 3 P1-7: pre-Phase-B grace period for missing dist is over —
        // missing infra is a regression. Fail-fast unless the maintainer
        // opts in via STELE_FIXTURE_ALLOW_SKIP=1.
        if (process.env.STELE_FIXTURE_ALLOW_SKIP === "1") {
          // eslint-disable-next-line no-console
          console.log(
            `[type-state-fixture] STELE_FIXTURE_ALLOW_SKIP=1 set; skipping ${fixture}.`,
          );
          return;
        }
        throw new Error(
          `[type-state-fixture] type-state-evaluator + tsTypeStateInferenceExtractor not built ` +
            `for fixture "${fixture}". Build both packages, or set ` +
            `STELE_FIXTURE_ALLOW_SKIP=1 to skip during local development.`,
        );
      }

      const fixturePath = resolve(FIXTURES_DIR, fixture);
      const expected = readExpected(fixturePath);
      const strictMode = !LENIENT_FIXTURES.has(fixture);

      const result = await runTypeStateFixture(fixturePath, { strictMode });

      // Inference notices land in `result.notices`, blocking findings in
      // `result.violations`. We merge them for the multiset match — each
      // fixture's expected-violations.json picks the correct severity, so
      // the matcher disambiguates automatically.
      const combined: readonly Violation[] = [
        ...result.violations,
        ...result.notices,
      ];
      assertViolationsMatch(combined, expected);
    });
  }
});

// ---------------------------------------------------------------------------
// Direct unit tests for the helper functions (always run — independent of
// whether T4.2 / T4.3 are built).
// ---------------------------------------------------------------------------

function mkViolation(over: Partial<Violation> & Pick<Violation, "rule_id">): Violation {
  return {
    rule_id: over.rule_id,
    rule_kind: over.rule_kind ?? "type_state_violation",
    severity: over.severity ?? "error",
    source: over.source ?? { tool: "stele", command: "check", kind: "type-state" },
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

describe("assertViolationsMatch helper (type-state)", () => {
  it("passes when both arrays are empty", () => {
    assertViolationsMatch([], []);
    expect(true).toBe(true);
  });

  it("passes when an exact 1-to-1 match is found", () => {
    const actual = [mkViolation({ rule_id: "typestate.ORDER.disallowed_op" })];
    assertViolationsMatch(actual, [
      { rule_id: "typestate.ORDER.disallowed_op" },
    ]);
  });

  it("reports count mismatch with a helpful message", () => {
    const actual = [mkViolation({ rule_id: "typestate.A.disallowed_op" })];
    expect(() =>
      assertViolationsMatch(actual, [
        { rule_id: "typestate.A.disallowed_op" },
        { rule_id: "typestate.B.disallowed_op" },
      ]),
    ).toThrow(/finding count mismatch — expected 2, got 1/);
  });

  it("matches via regex on group_id_pattern", () => {
    const actual = [
      mkViolation({
        rule_id: "typestate.ORDER.disallowed_op",
        group_id: "src/scenario.ts::main(0)",
      }),
    ];
    assertViolationsMatch(actual, [
      {
        rule_id: "typestate.ORDER.disallowed_op",
        group_id_pattern: "::main\\(0\\)$",
      },
    ]);
  });

  it("rejects when regex on group_id_pattern fails", () => {
    const actual = [
      mkViolation({
        rule_id: "typestate.ORDER.disallowed_op",
        group_id: "src/scenario.ts::other(0)",
      }),
    ];
    expect(() =>
      assertViolationsMatch(actual, [
        {
          rule_id: "typestate.ORDER.disallowed_op",
          group_id_pattern: "::main\\(0\\)$",
        },
      ]),
    ).toThrow(/had no matching actual/);
  });

  it("matches via substring on cause.summary_contains", () => {
    const actual = [
      mkViolation({
        rule_id: "typestate.ORDER.disallowed_op",
        cause: { summary: "Method `addItem` is not allowed when `order` is in state `Paid`." },
      }),
    ];
    assertViolationsMatch(actual, [
      {
        rule_id: "typestate.ORDER.disallowed_op",
        cause: { summary_contains: "addItem" },
      },
    ]);
  });

  it("findMatchingViolation returns -1 when no actual matches", () => {
    const actual = [mkViolation({ rule_id: "typestate.X.disallowed_op" })];
    const idx = findMatchingViolation(actual, {
      rule_id: "typestate.NOT_PRESENT.disallowed_op",
    });
    expect(idx).toBe(-1);
  });

  it("pairs duplicate matches by removing actuals one-by-one", () => {
    const actual = [
      mkViolation({ rule_id: "typestate.X.disallowed_op", group_id: "g1" }),
      mkViolation({ rule_id: "typestate.X.disallowed_op", group_id: "g2" }),
    ];
    assertViolationsMatch(actual, [
      { rule_id: "typestate.X.disallowed_op", group_id_pattern: "^g1$" },
      { rule_id: "typestate.X.disallowed_op", group_id_pattern: "^g2$" },
    ]);
  });
});
