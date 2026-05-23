import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { assertViolationReportsEqual } from "./comparators.js";
import { loadFixtures, parseBackendSpecs, runFixtureOnBackend } from "./runner-impl.js";

const FIXTURES_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "fixtures");
const BACKEND_SPECS = parseBackendSpecs(process.env.STELE_CONFORMANCE_BACKENDS);
const FIXTURES = await loadFixtures(FIXTURES_DIR);

if (FIXTURES.length === 0) {
  describe("conformance suite", () => {
    test.skip("no fixtures discovered under tests/conformance/fixtures/", () => {
      // intentionally empty
    });
  });
}

for (const fixture of FIXTURES) {
  describe(`fixture ${fixture.id}`, () => {
    for (const spec of BACKEND_SPECS) {
      const label = `${spec.language}:${spec.framework}`;

      // EP06 code-shape only on Python today; skip on other backends.
      if (fixture.requiresCodeShape === true && spec.language !== "python") {
        test.skip(`on ${label} backend (code-shape unsupported)`, () => {
          // intentionally empty
        });
        continue;
      }

      // Round 3 P0-9: Phase B mechanisms are TypeScript-only until
      // per-language call-graph extractors land for Python / Go / Rust /
      // Java. Mark the fixtures with a `phase-b-` prefix so they skip
      // cleanly on every other backend.
      if (fixture.requiresPhaseB === true && spec.language !== "typescript") {
        test.skip(`on ${label} backend (Phase B mechanisms TS-only today)`, () => {
          // intentionally empty
        });
        continue;
      }

      test(`on ${label} backend`, async (context) => {
        const result = await runFixtureOnBackend(fixture, spec);

        if (result.runnerSkipped) {
          // Round 3 P0-9: Phase B fixtures derive their entire expected
          // output from `stele check --json` (the trace/type-state/effect
          // evaluators run inside the CLI itself), so a missing framework
          // test runner is irrelevant — we still get a meaningful report.
          // Fall through to assertViolationReportsEqual for those.
          if (fixture.requiresPhaseB !== true) {
            // Round 4 F-D-04: auto-skip when the runner is unavailable
            // because the framework binary (pytest / go / cargo / mvn)
            // isn't installed on this machine. The legacy "throw unless
            // STELE_CONFORMANCE_ALLOW_SKIP=1" behavior is preserved for
            // explicit-non-binary failures — but the common "pytest not
            // installed" / "go not installed" case shouldn't drown the
            // local-dev test signal in 7 spurious failures.
            const skipReason = result.runnerSkipReason ?? "";
            const isMissingFrameworkBinary =
              /not installed|test runner missing|runner not yet wired/i.test(skipReason);
            if (
              process.env.STELE_CONFORMANCE_ALLOW_SKIP !== "1" &&
              !isMissingFrameworkBinary
            ) {
              throw new Error(
                `Conformance runner unavailable for ${label}: ${result.runnerSkipReason ?? "test runner missing"}. ` +
                "Set STELE_CONFORMANCE_ALLOW_SKIP=1 to skip during local development.",
              );
            }
            expect(result.report.schema_version, "schema_version").toBe("1");
            expect(Array.isArray(result.report.violations), "violations is array").toBe(true);
            process.stderr.write(`[skip] ${label}: ${result.runnerSkipReason ?? "test runner unavailable"}\n`);
            context.skip();
            return;
          }
          process.stderr.write(
            `[phase-b] ${label}: framework runner unavailable (${result.runnerSkipReason ?? "n/a"}); ` +
            `validating stele check --json output only.\n`,
          );
        }

        assertViolationReportsEqual(result.report, fixture.expectedViolations);
      });
    }
  });
}
