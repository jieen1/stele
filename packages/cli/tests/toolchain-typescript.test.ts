import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  parseEslintReport,
} from "../src/toolchain/eslint.js";
import type { EslintReport } from "../src/toolchain/types.js";
import {
  parseTscOutput,
  parseTscOutputToViolations,
} from "../src/toolchain/typescript.js";
import {
  validateTsconfigPolicy,
} from "../src/toolchain/tsconfig-policy.js";

// ---------------------------------------------------------------------------
// Fixture paths
// ---------------------------------------------------------------------------

const FIXTURES_DIR = join(__dirname, "fixtures", "toolchain");

// ---------------------------------------------------------------------------
// tsconfig-policy — Strict option tests (5 tests)
// ---------------------------------------------------------------------------

describe("validateTsconfigPolicy — strict option", () => {
  it("strict option present and true → 0 violations", () => {
    const tsconfigPath = join(FIXTURES_DIR, "tsconfig-valid.json");
    const violations = validateTsconfigPolicy(
      FIXTURES_DIR,
      tsconfigPath,
      { strict: true },
    );
    expect(violations).toEqual([]);
  });

  it("strict option missing → violation", () => {
    // tsconfig-invalid.json has strict: false, so a "missing" strict is
    // simulated by requiring strict: true against a config that has strict: false.
    // We use tsconfig-invalid.json for this.
    const tsconfigPath = join(FIXTURES_DIR, "tsconfig-invalid.json");
    const violations = validateTsconfigPolicy(
      FIXTURES_DIR,
      tsconfigPath,
      { strict: true },
    );
    expect(violations).toHaveLength(1);
    expect(violations[0].ruleId).toBe("typedriven.typescript.config.strict");
    expect(violations[0].ruleKind).toBe("typescript-config-policy");
    expect(violations[0].severity).toBe("error");
  });

  it("strict option false → violation", () => {
    const tsconfigPath = join(FIXTURES_DIR, "tsconfig-invalid.json");
    const violations = validateTsconfigPolicy(
      FIXTURES_DIR,
      tsconfigPath,
      { strict: true },
    );
    expect(violations).toHaveLength(1);
    expect(violations[0].message).toContain("strict");
    expect(violations[0].message).toContain("false");
    expect(violations[0].message).toContain("true");
  });

  it("multiple required options, all missing → multiple violations", () => {
    // tsconfig-invalid.json: strict:false, exactOptionalPropertyTypes:false, no noUncheckedIndexedAccess
    const tsconfigPath = join(FIXTURES_DIR, "tsconfig-invalid.json");
    const violations = validateTsconfigPolicy(
      FIXTURES_DIR,
      tsconfigPath,
      {
        strict: true,
        exactOptionalPropertyTypes: true,
        noUncheckedIndexedAccess: true,
      },
    );
    expect(violations).toHaveLength(3);
    const ruleIds = violations.map((v) => v.ruleId);
    expect(ruleIds).toContain("typedriven.typescript.config.strict");
    expect(ruleIds).toContain("typedriven.typescript.config.exactOptionalPropertyTypes");
    expect(ruleIds).toContain("typedriven.typescript.config.noUncheckedIndexedAccess");
  });

  it("valid tsconfig satisfies all three required options → 0 violations", () => {
    const tsconfigPath = join(FIXTURES_DIR, "tsconfig-valid.json");
    const violations = validateTsconfigPolicy(
      FIXTURES_DIR,
      tsconfigPath,
      {
        strict: true,
        exactOptionalPropertyTypes: true,
        noUncheckedIndexedAccess: true,
      },
    );
    expect(violations).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// tsc parsing — 5 tests
// ---------------------------------------------------------------------------

describe("parseTscOutput — single error", () => {
  it("single error parsed correctly", () => {
    const raw = readFileSync(join(FIXTURES_DIR, "tsc-output-sample.txt"), "utf8");
    const diagnostics = parseTscOutput(raw);

    expect(diagnostics).toHaveLength(3);

    const first = diagnostics[0];
    expect(first.file).toBe("src/billing/domain/invoice/Invoice.ts");
    expect(first.line).toBe(42);
    expect(first.column).toBe(17);
    expect(first.code).toBe("TS2322");
    expect(first.message).toContain("Type 'string' is not assignable");
  });
});

describe("parseTscOutput — multiple errors", () => {
  it("multiple errors parsed from fixture", () => {
    const raw = readFileSync(join(FIXTURES_DIR, "tsc-output-sample.txt"), "utf8");
    const diagnostics = parseTscOutput(raw);

    expect(diagnostics).toHaveLength(3);
    expect(diagnostics[0].file).toBe("src/billing/domain/invoice/Invoice.ts");
    expect(diagnostics[1].file).toBe("src/customer/public/CustomerId.ts");
    expect(diagnostics[2].file).toBe("src/shared/domain/Money.ts");
  });
});

describe("parseTscOutput — Windows paths", () => {
  it("Windows path with backslashes is normalized", () => {
    const raw = `C:\\project\\src\\file.ts(10,5): error TS2345: Argument of type 'number'.`;
    const diagnostics = parseTscOutput(raw);

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].file).toBe("C:/project/src/file.ts");
    expect(diagnostics[0].line).toBe(10);
    expect(diagnostics[0].column).toBe(5);
    expect(diagnostics[0].code).toBe("TS2345");
  });
});

describe("parseTscOutput — no line/column", () => {
  it("diagnostic without line/column has undefined line/col", () => {
    const raw = `src/file.ts: error TS2304: Cannot find name 'missing'.`;
    const diagnostics = parseTscOutput(raw);

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].file).toBe("src/file.ts");
    expect(diagnostics[0].line).toBeUndefined();
    expect(diagnostics[0].column).toBeUndefined();
    expect(diagnostics[0].code).toBe("TS2304");
  });
});

describe("parseTscOutput — empty input", () => {
  it("empty output returns empty array", () => {
    expect(parseTscOutput("")).toEqual([]);
    expect(parseTscOutput("   ")).toEqual([]);
    expect(parseTscOutput("\n")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// parseTscOutputToViolations
// ---------------------------------------------------------------------------

describe("parseTscOutputToViolations", () => {
  it("converts diagnostics to violations with correct rule IDs", () => {
    const raw = `src/file.ts(10,5): error TS2322: Type mismatch.`;
    const violations = parseTscOutputToViolations(raw, "/project");

    expect(violations).toHaveLength(1);
    expect(violations[0].ruleId).toBe("typedriven.typescript.diagnostic.TS2322");
    expect(violations[0].ruleKind).toBe("typescript-diagnostic");
    expect(violations[0].severity).toBe("error");
    expect(violations[0].file).toBe("src/file.ts");
    expect(violations[0].line).toBe(10);
    expect(violations[0].column).toBe(5);
    expect(violations[0].code).toBe("TS2322");
  });
});

// ---------------------------------------------------------------------------
// ESLint parsing — 4 tests
// ---------------------------------------------------------------------------

describe("parseEslintReport — no relevant rules", () => {
  it("no relevant rules → empty violations", () => {
    const report: EslintReport = {
      results: [
        {
          filePath: "src/file.ts",
          messages: [
            { ruleId: "no-console", severity: 1, message: "Unexpected console." },
          ],
          errorCount: 0,
          warningCount: 1,
        },
      ],
    };
    const violations = parseEslintReport(report, ["@typescript-eslint/no-explicit-any"]);
    expect(violations).toEqual([]);
  });
});

describe("parseEslintReport — single rule match", () => {
  it("single rule match produces violation", () => {
    const report: EslintReport = {
      results: [
        {
          filePath: "src/file.ts",
          messages: [
            { ruleId: "@typescript-eslint/no-explicit-any", severity: 2, message: "Unexpected any.", line: 10, column: 5 },
          ],
          errorCount: 1,
          warningCount: 0,
        },
      ],
    };
    const violations = parseEslintReport(report, ["@typescript-eslint/no-explicit-any"]);
    expect(violations).toHaveLength(1);
    expect(violations[0].ruleId).toBe("typedriven.eslint.@typescript-eslint/no-explicit-any");
    expect(violations[0].ruleKind).toBe("eslint");
    expect(violations[0].severity).toBe("error");
    expect(violations[0].line).toBe(10);
    expect(violations[0].column).toBe(5);
  });
});

describe("parseEslintReport — multiple rule matches", () => {
  it("multiple rule matches produce multiple violations", () => {
    const report: EslintReport = {
      results: [
        {
          filePath: "src/file1.ts",
          messages: [
            { ruleId: "@typescript-eslint/no-explicit-any", severity: 2, message: "Unexpected any.", line: 5, column: 1 },
            { ruleId: "@typescript-eslint/no-non-null-assertion", severity: 1, message: "Non-null assertion.", line: 10, column: 3 },
          ],
          errorCount: 1,
          warningCount: 1,
        },
      ],
    };
    const violations = parseEslintReport(
      report,
      ["@typescript-eslint/no-explicit-any", "@typescript-eslint/no-non-null-assertion"],
    );
    expect(violations).toHaveLength(2);
    expect(violations[0].ruleId).toBe("typedriven.eslint.@typescript-eslint/no-explicit-any");
    expect(violations[0].severity).toBe("error");
    expect(violations[1].ruleId).toBe("typedriven.eslint.@typescript-eslint/no-non-null-assertion");
    expect(violations[1].severity).toBe("warning");
  });
});

describe("parseEslintReport — severity 1 mapped to warning", () => {
  it("severity 1 maps to warning", () => {
    const report: EslintReport = {
      results: [
        {
          filePath: "src/file.ts",
          messages: [
            { ruleId: "@typescript-eslint/no-explicit-any", severity: 1, message: "Warning level any.", line: 1, column: 1 },
          ],
          errorCount: 0,
          warningCount: 1,
        },
      ],
    };
    const violations = parseEslintReport(report, ["@typescript-eslint/no-explicit-any"]);
    expect(violations).toHaveLength(1);
    expect(violations[0].severity).toBe("warning");
  });
});
