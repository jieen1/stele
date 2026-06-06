import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { runLint, type LintOptions, type LintResult } from "../src/commands/lint.js";

const tempDirs: string[] = [];

afterAll(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function lintFixture(cdl: string, opts: LintOptions = {}): Promise<LintResult> {
  const dir = await mkdtemp(join(tmpdir(), "stele-cli-lint-"));
  tempDirs.push(dir);
  await mkdir(join(dir, "contract"), { recursive: true });
  await writeFile(
    join(dir, "stele.config.json"),
    JSON.stringify({
      version: "0.1.0",
      entry: "contract/main.stele",
      contractDir: "contract",
      targetLanguage: "python",
      testFramework: "pytest",
    }),
    "utf8",
  );
  await writeFile(join(dir, "contract", "main.stele"), cdl, "utf8");
  return runLint(dir, opts);
}

describe("stele lint (end-to-end with z3)", () => {
  it("T1 reports a contradictory pair", async () => {
    const cdl = `
(invariant X_MIN (severity high) (description "d") (assert (gt (path x) 5)))
(invariant X_MAX (severity high) (description "d") (assert (lt (path x) 3)))
`;
    const human = await lintFixture(cdl);
    expect(human.exitCode).toBe(1);
    expect(human.report.findings).toEqual([
      { kind: "contradiction", invariants: ["X_MAX", "X_MIN"], minimal: true },
    ]);
    expect(human.report.coverage.translated).toBe(2);
    expect(human.report.coverage.skipped).toEqual([]);
    expect(human.text).toContain("CONTRADICTION");
    expect(human.text).toContain("conflicting set: X_MAX, X_MIN");

    const strict = await lintFixture(cdl, { strict: true });
    expect(strict.exitCode).toBe(1);
  });

  it("T2 reports a tautology and respects --strict", async () => {
    const cdl = `
(invariant X_TOTAL (severity high) (description "d") (assert (or (gt (path x) 0) (lte (path x) 0))))
`;
    const result = await lintFixture(cdl);
    expect(result.report.findings).toEqual([{ kind: "tautology", invariant: "X_TOTAL" }]);
    expect(result.exitCode).toBe(0);

    const strict = await lintFixture(cdl, { strict: true });
    expect(strict.exitCode).toBe(1);
  });

  it("T3 reports subsumption with correct direction", async () => {
    const cdl = `
(invariant X_GT_10 (severity high) (description "d") (assert (gt (path x) 10)))
(invariant X_GT_0 (severity high) (description "d") (assert (gt (path x) 0)))
`;
    const result = await lintFixture(cdl);
    expect(result.report.findings).toEqual([
      { kind: "subsumption", subsumes: "X_GT_10", redundant: "X_GT_0" },
    ]);
    expect(result.exitCode).toBe(0);

    const strict = await lintFixture(cdl, { strict: true });
    expect(strict.exitCode).toBe(1);
  });

  it("T4 reports a clean independent satisfiable set", async () => {
    const cdl = `
(invariant X_RANGE (severity high) (description "d") (assert (and (gt (path x) 0) (lt (path x) 100))))
(invariant Y_NAME (severity high) (description "d") (assert (eq (path y) "alice")))
`;
    const result = await lintFixture(cdl);
    expect(result.report.findings).toEqual([]);
    expect(result.report.coverage.translated).toBe(2);
    expect(result.exitCode).toBe(0);
    expect(result.text).toContain("no issues found");

    const strict = await lintFixture(cdl, { strict: true });
    expect(strict.exitCode).toBe(0);
  });

  it("T5 skips untranslatable invariants but still analyzes the rest", async () => {
    const cdl = `
(checker check_active (description "active"))
(invariant SKU_FMT (severity high) (description "d") (assert (matches (path sku) "^[A-Z]{3}$")))
(invariant POS_NONEMPTY (severity high) (description "d") (assert (forall p (collection positions) (gt (path p value) 0))))
(invariant ACCT_ACTIVE (severity high) (description "d") (uses-checker check_active))
(invariant X_MIN (severity high) (description "d") (assert (gt (path x) 5)))
(invariant X_MAX (severity high) (description "d") (assert (lt (path x) 3)))
`;
    const result = await lintFixture(cdl);
    expect(result.report.coverage.translated).toBe(2);
    expect(result.report.coverage.skipped).toEqual([
      { id: "ACCT_ACTIVE", reason: "uses-checker" },
      { id: "POS_NONEMPTY", reason: "unsupported-operator: forall" },
      { id: "SKU_FMT", reason: "unsupported-operator: matches" },
    ]);
    expect(result.report.findings).toEqual([
      { kind: "contradiction", invariants: ["X_MAX", "X_MIN"], minimal: true },
    ]);
    expect(result.exitCode).toBe(1);
  });

  it("T6 sound-skips an inconsistent-sort path and emits no false findings", async () => {
    const cdl = `
(invariant Z_NUM (severity high) (description "d") (assert (gt (path z) 5)))
(invariant Z_STR (severity high) (description "d") (assert (eq (path z) "active")))
`;
    const result = await lintFixture(cdl);
    expect(result.report.coverage.translated).toBe(0);
    expect(result.report.coverage.skipped).toEqual([
      { id: "Z_NUM", reason: "inconsistent-sort: z" },
      { id: "Z_STR", reason: "inconsistent-sort: z" },
    ]);
    expect(result.report.findings).toEqual([]);
    expect(result.exitCode).toBe(0);
  });

  it("T7 does NOT flag a satisfiable real-valued open interval (numeric-domain soundness regression)", async () => {
    // Regression for the Int-default false positive: 0 < discount_rate < 1 is
    // UNSAT over the integers but SAT over the reals (e.g. 0.5). Numeric paths
    // now resolve to Real, so this common business shape (rate/ratio/probability)
    // must report NO contradiction.
    const cdl = `
(invariant RATE_POS  (severity high) (description "d") (assert (gt (path discount_rate) 0)))
(invariant RATE_SUB1 (severity high) (description "d") (assert (lt (path discount_rate) 1)))
`;
    const result = await lintFixture(cdl);
    expect(result.report.findings).toEqual([]);
    expect(result.report.coverage.translated).toBe(2);
    expect(result.exitCode).toBe(0);

    const strict = await lintFixture(cdl, { strict: true });
    expect(strict.exitCode).toBe(0);
  });

  it("T8 still detects a genuine contradiction written with integer literals", async () => {
    // Soundness is preserved in the other direction: q == 5 AND q == 7 is unsat
    // over the reals too, so moving to the wide domain does not hide real bugs.
    const cdl = `
(invariant Q5 (severity high) (description "d") (assert (eq (path q) 5)))
(invariant Q7 (severity high) (description "d") (assert (eq (path q) 7)))
`;
    const result = await lintFixture(cdl);
    expect(result.report.findings).toEqual([
      { kind: "contradiction", invariants: ["Q5", "Q7"], minimal: true },
    ]);
    expect(result.exitCode).toBe(1);
  });

  it("emits deterministic JSON without wall-clock", async () => {
    const cdl = `
(invariant X_MIN (severity high) (description "d") (assert (gt (path x) 5)))
(invariant X_MAX (severity high) (description "d") (assert (lt (path x) 3)))
`;
    const a = await lintFixture(cdl, { json: true });
    const b = await lintFixture(cdl, { json: true });
    expect(a.text).toEqual(b.text);
    expect(a.text).not.toMatch(/generated_at|timestamp|duration/i);
    const parsed = JSON.parse(a.text) as { version: number };
    expect(parsed.version).toBe(1);
  });
});
