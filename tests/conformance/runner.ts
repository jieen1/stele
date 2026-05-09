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

      test(`on ${label} backend`, async (context) => {
        const result = await runFixtureOnBackend(fixture, spec);

        if (result.runnerSkipped) {
          // pytest unavailable (or other runner missing): structural shape
          // check then a clean vitest skip via context.skip().
          expect(result.report.schema_version, "schema_version").toBe("1");
          expect(Array.isArray(result.report.violations), "violations is array").toBe(true);
          // Vitest 1.4 context.skip() takes no args; log reason then skip.
          console.log(`[skip] ${label}: ${result.runnerSkipReason ?? "test runner unavailable"}`);
          context.skip();
          return;
        }

        assertViolationReportsEqual(result.report, fixture.expectedViolations);
      });
    }
  });
}
