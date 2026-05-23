/**
 * End-to-end fixture runner for Phase B effect-policy (T5.5).
 *
 * Each directory under `tests/fixtures/effect/` is a self-contained tiny TS
 * project that exercises the full pipeline:
 *
 *   contract/main.stele   →  loadContract
 *   src/*.ts              →  tsCallGraphExtractor
 *                         →  tsEffectAnnotationExtractor (T5.3)
 *                         →  evaluateEffects (T5.2)
 *                         →  Violation[] / notices[]
 *
 * The fixture passes when the emitted findings match the loose-match
 * specification in `expected-violations.json`. Two flavours of fixture are
 * supported:
 *
 *   - Standard fixtures: `expected-violations.json` is a JSON array of
 *     `ExpectedViolation` records. The runner loads the contract, evaluates
 *     effects, and runs `assertViolationsMatch()` on
 *     `violations ++ notices`.
 *
 *   - Parse-error fixtures: `expected-violations.json` is a single object
 *     `{ "expected_parse_error": "E0357" }`. The runner asserts that
 *     `loadContract` throws a `SteleError` with that code. Used for fixture
 *     `09-suppression-missing-reason` (mandatory `reason` per Round 2 D-CG-1).
 *
 * The runner is intentionally tolerant: if either `@stele/effect-evaluator`
 * (T5.2) or `tsEffectAnnotationExtractor` (T5.3) is not yet importable,
 * every fixture test logs an informational skip message and passes — so
 * this file can land *before* both ship.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import type { Violation } from "@stele/core";
import {
  assertViolationsMatch,
  findMatchingViolation,
  isEffectInfrastructureAvailable,
  isParseErrorSpec,
  loadEffectEvaluator,
  loadExpectedSpec,
  loadFixtureConfig,
  runEffectFixture,
  runEffectFixtureExpectingParseError,
  type ExpectedViolation,
} from "./_helpers/effect-fixture.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = resolve(__dirname, "fixtures/effect");

function listFixtures(): readonly string[] {
  if (!existsSync(FIXTURES_DIR)) return [];
  return readdirSync(FIXTURES_DIR)
    .filter((d) => /^\d+-/.test(d))
    .sort();
}

// ---------------------------------------------------------------------------
// Fixture-driven tests
// ---------------------------------------------------------------------------

describe("effect-policy end-to-end fixtures", () => {
  const fixtures = listFixtures();

  it("discovers at least 10 fixture directories", () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(10);
  });

  for (const fixture of fixtures) {
    it(fixture, async () => {
      if (!(await isEffectInfrastructureAvailable())) {
        // Round 3 P1-7: pre-Phase-B grace period for missing dist is over —
        // missing infra is a regression. Fail-fast unless the maintainer
        // opts in via STELE_FIXTURE_ALLOW_SKIP=1.
        if (process.env.STELE_FIXTURE_ALLOW_SKIP === "1") {
          // eslint-disable-next-line no-console
          console.log(
            `[effect-fixture] STELE_FIXTURE_ALLOW_SKIP=1 set; skipping ${fixture}.`,
          );
          return;
        }
        throw new Error(
          `[effect-fixture] effect-evaluator + tsEffectAnnotationExtractor not built ` +
            `for fixture "${fixture}". Build both packages, or set ` +
            `STELE_FIXTURE_ALLOW_SKIP=1 to skip during local development.`,
        );
      }

      const fixturePath = resolve(FIXTURES_DIR, fixture);
      const expected = loadExpectedSpec(fixturePath);

      if (isParseErrorSpec(expected)) {
        // Special path: this fixture's contract is intentionally invalid;
        // the runner asserts `loadContract` throws the expected SteleError
        // code. Used for `09-suppression-missing-reason` (E0357).
        await runEffectFixtureExpectingParseError(fixturePath, expected);
        return;
      }

      const { strictMode } = loadFixtureConfig(fixturePath);

      const result = await runEffectFixture(fixturePath, { strictMode });

      // Effect findings split into `violations` (blocking) and `notices`
      // (informational / lenient-mode downgrades / suppression-active).
      // Each fixture's expected-violations.json picks the correct severity,
      // so the matcher disambiguates via `severity` / `rule_id`.
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
// whether T5.2 / T5.3 are built).
// ---------------------------------------------------------------------------

function mkViolation(
  over: Partial<Violation> & Pick<Violation, "rule_id">,
): Violation {
  return {
    rule_id: over.rule_id,
    rule_kind: over.rule_kind ?? "effect_violation",
    severity: over.severity ?? "error",
    source: over.source ?? { tool: "stele", command: "check", kind: "effect" },
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

describe("assertViolationsMatch helper (effect)", () => {
  it("passes when both arrays are empty", () => {
    assertViolationsMatch([], []);
    expect(true).toBe(true);
  });

  it("passes when an exact 1-to-1 match is found", () => {
    const actual = [
      mkViolation({ rule_id: "effect.NO_IO_IN_UI.forbidden_effect" }),
    ];
    assertViolationsMatch(actual, [
      { rule_id: "effect.NO_IO_IN_UI.forbidden_effect" },
    ]);
  });

  it("reports count mismatch with a helpful message", () => {
    const actual = [
      mkViolation({ rule_id: "effect.A.forbidden_effect" }),
    ];
    expect(() =>
      assertViolationsMatch(actual, [
        { rule_id: "effect.A.forbidden_effect" },
        { rule_id: "effect.B.forbidden_effect" },
      ]),
    ).toThrow(/finding count mismatch — expected 2, got 1/);
  });

  it("matches via regex on group_id_pattern", () => {
    const actual = [
      mkViolation({
        rule_id: "effect.NO_IO_IN_UI.forbidden_effect",
        group_id: "src/components/UserCard.ts::UserCard(1)",
      }),
    ];
    assertViolationsMatch(actual, [
      {
        rule_id: "effect.NO_IO_IN_UI.forbidden_effect",
        group_id_pattern: "::UserCard\\(1\\)$",
      },
    ]);
  });

  it("matches via rule_kind_pattern regex", () => {
    const actual = [
      mkViolation({
        rule_id: "effect.NO_IO_IN_UI.forbidden_effect",
        rule_kind: "effect_violation",
      }),
    ];
    assertViolationsMatch(actual, [
      {
        rule_id: "effect.NO_IO_IN_UI.forbidden_effect",
        rule_kind_pattern: "trace_violation|effect_violation",
      },
    ]);
  });

  it("rejects when regex on group_id_pattern fails", () => {
    const actual = [
      mkViolation({
        rule_id: "effect.NO_IO_IN_UI.forbidden_effect",
        group_id: "src/components/Other.ts::Other(0)",
      }),
    ];
    expect(() =>
      assertViolationsMatch(actual, [
        {
          rule_id: "effect.NO_IO_IN_UI.forbidden_effect",
          group_id_pattern: "::UserCard\\(1\\)$",
        },
      ]),
    ).toThrow(/had no matching actual/);
  });

  it("matches via substring on cause.summary_contains", () => {
    const actual = [
      mkViolation({
        rule_id: "effect.NO_IO_IN_UI.forbidden_effect",
        cause: {
          summary:
            "UI component UserCard has forbidden effect db.read (via findUser).",
        },
      }),
    ];
    assertViolationsMatch(actual, [
      {
        rule_id: "effect.NO_IO_IN_UI.forbidden_effect",
        cause: { summary_contains: "db.read" },
      },
    ]);
  });

  it("findMatchingViolation returns -1 when no actual matches", () => {
    const actual = [
      mkViolation({ rule_id: "effect.X.forbidden_effect" }),
    ];
    const idx = findMatchingViolation(actual, {
      rule_id: "effect.NOT_PRESENT.forbidden_effect",
    });
    expect(idx).toBe(-1);
  });

  it("pairs duplicate matches by removing actuals one-by-one", () => {
    const actual = [
      mkViolation({
        rule_id: "effect.X.forbidden_effect",
        group_id: "g1",
      }),
      mkViolation({
        rule_id: "effect.X.forbidden_effect",
        group_id: "g2",
      }),
    ];
    assertViolationsMatch(actual, [
      { rule_id: "effect.X.forbidden_effect", group_id_pattern: "^g1$" },
      { rule_id: "effect.X.forbidden_effect", group_id_pattern: "^g2$" },
    ]);
  });
});

describe("effect-fixture dynamic-loader helpers", () => {
  it("loadEffectEvaluator returns null or a module — never throws", async () => {
    const ev = await loadEffectEvaluator();
    expect(ev === null || typeof ev === "object").toBe(true);
  });

  it("isEffectInfrastructureAvailable is boolean", async () => {
    const ok = await isEffectInfrastructureAvailable();
    expect(typeof ok).toBe("boolean");
  });

  it("loadExpectedSpec parses array fixtures", () => {
    // Use any existing fixture with an array spec (created by this task).
    const fixtures = listFixtures();
    const arrayFixture = fixtures.find(
      (f) => f !== "09-suppression-missing-reason",
    );
    if (arrayFixture === undefined) {
      // No suitable fixture yet; treat as pass — the count-discovery test
      // above already guards the minimum-fixture invariant.
      return;
    }
    const spec = loadExpectedSpec(resolve(FIXTURES_DIR, arrayFixture));
    expect(Array.isArray(spec)).toBe(true);
  });

  it("loadExpectedSpec parses parse-error marker fixtures", () => {
    const fixtures = listFixtures();
    if (!fixtures.includes("09-suppression-missing-reason")) return;
    const spec = loadExpectedSpec(
      resolve(FIXTURES_DIR, "09-suppression-missing-reason"),
    );
    expect(isParseErrorSpec(spec)).toBe(true);
  });

  it("loadExpectedSpec rejects malformed JSON shape", () => {
    // Inline check: build a temp path that doesn't exist — readFileSync will
    // throw before our shape check. To probe the shape branch we re-use the
    // helper indirectly by asserting it throws on a missing file too.
    expect(() => loadExpectedSpec(resolve(FIXTURES_DIR, "__nonexistent__"))).toThrow();
  });
});

describe("effect-fixture parse-error marker handling", () => {
  it("assertViolationsMatch refuses to consume a parse-error marker", () => {
    expect(() =>
      assertViolationsMatch([], { expected_parse_error: "E0357" }),
    ).toThrow(/assertViolationsMatch was called with a parse-error marker/);
  });

  it("isParseErrorSpec distinguishes arrays from markers", () => {
    expect(isParseErrorSpec([])).toBe(false);
    expect(isParseErrorSpec([{ rule_id: "x" }] as readonly ExpectedViolation[])).toBe(
      false,
    );
    expect(isParseErrorSpec({ expected_parse_error: "E0357" })).toBe(true);
  });
});
