import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Contract } from "../src/index";
import * as stele from "../src/index";

const tempDirs: string[] = [];

describe("normalizer edge cases", () => {
  afterEach(async () => {
    await Promise.allSettled(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it("normalizes empty contract", async () => {
    const project = await createTempProject({
      "main.stele": [""],
    });

    const contract = await loadContract(project.rootPath);
    const normalized = normalizeContract(contract);

    expect(normalized).toBe("");
    expect(contract.invariants).toHaveLength(0);
    expect(contract.codeShapes).toHaveLength(0);
    expect(contract.scenarios).toHaveLength(0);
  });

  it("normalizes contract with only metadata", async () => {
    const project = await createTempProject({
      "main.stele": [
        '(metadata (stele-version "0.1") (project "test") (target-language python))',
      ],
    });

    const contract = await loadContract(project.rootPath);
    const normalized = normalizeContract(contract);

    expect(contract.metadata).toHaveLength(1);
    expect(contract.invariants).toHaveLength(0);
    expect(normalized).toContain('(metadata (stele-version "0.1") (project "test") (target-language python))');
  });

  it("normalizes contract with only imports", async () => {
    const project = await createTempProject({
      "main.stele": ['(import "module.stele")'],
      "module.stele": [
        "(invariant IMPORTED",
        '  (description "Imported invariant.")',
        "  (severity low)",
        "  (assert (eq 1 1)))",
      ],
    });

    const contract = await loadContract(project.rootPath);
    const normalized = normalizeContract(contract);

    expect(contract.invariants).toHaveLength(1);
    expect(normalized).toContain("(invariant IMPORTED");
  });

  it("handles large contract with many declarations", async () => {
    const invariants: string[] = [];
    for (let i = 0; i < 50; i++) {
      invariants.push(
        `(invariant RULE_${String(i).padStart(3, "0")}` +
          `\n  (description "Rule number ${i}.")` +
          `\n  (severity low)` +
          `\n  (assert (eq ${i} ${i})))`,
      );
    }

    const project = await createTempProject({
      "main.stele": [invariants.join("\n")],
    });

    const contract = await loadContract(project.rootPath);
    const normalized = normalizeContract(contract);

    expect(contract.invariants).toHaveLength(50);
    expect(normalized).toContain("RULE_000");
    expect(normalized).toContain("RULE_049");
  });

  it("preserves unicode identifiers", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(invariant RULE_CAFE",
        '  (description "Identifier with unicode: \u00e9\u00e8\u00ea.")',
        "  (severity high)",
        "  (assert (eq 1 1)))",
      ],
    });

    const contract = await loadContract(project.rootPath);
    const normalized = normalizeContract(contract);

    expect(contract.invariants[0].id).toBe("RULE_CAFE");
    expect(normalized).toContain("RULE_CAFE");
  });

  it("handles invariant with unicode description", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(invariant UNICODE_DESC",
        '  (description "\u4e2d\u6587\u63cf\u8ff0\u8bed\u6d4b\u8bd5.")',
        "  (severity high)",
        "  (assert (eq 1 1)))",
      ],
    });

    const contract = await loadContract(project.rootPath);
    const normalized = normalizeContract(contract);

    expect(normalized).toContain("\u4e2d\u6587\u63cf\u8ff0\u8bed\u6d4b\u8bd5");
    expect(contract.invariants[0].description).toBe("\u4e2d\u6587\u63cf\u8ff0\u8bed\u6d4b\u8bd5.");
  });

  it("normalizes invariant with uses-checker reference", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(checker balance_checker)",
        "(invariant BALANCE_CHECK",
        '  (description "Uses external checker.")',
        "  (severity high)",
        "  (uses-checker balance_checker))",
      ],
    });

    const contract = await loadContract(project.rootPath);
    const normalized = normalizeContract(contract);

    expect(normalized).toContain("(uses-checker balance_checker)");
  });

  it("normalizes contract with multiple files sorted by path", async () => {
    const project = await createTempProject({
      "main.stele": [
        '(import "z_last.stele")',
        '(import "a_first.stele")',
        "(invariant ROOT",
        '  (description "Root invariant.")',
        "  (severity high)",
        "  (assert (eq 1 1)))",
      ],
      "a_first.stele": [
        "(invariant ALPHA",
        '  (description "First alphabetically.")',
        "  (severity low)",
        "  (assert (eq 1 1)))",
      ],
      "z_last.stele": [
        "(invariant ZULU",
        '  (description "Last alphabetically.")',
        "  (severity low)",
        "  (assert (eq 1 1)))",
      ],
    });

    const contract = await loadContract(project.rootPath);
    const normalized = normalizeContract(contract);

    expect(contract.files).toHaveLength(3);
    expect(normalized).toContain("(invariant ALPHA");
    expect(normalized).toContain("(invariant ROOT");
    expect(normalized).toContain("(invariant ZULU");
  });

  it("normalizes code-shape declarations", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(boundary api_boundary",
        "  (lang python)",
        '  (target "src/api/*.py")',
        '  (deny-import "requests"))',
      ],
    });

    const contract = await loadContract(project.rootPath);
    const normalized = normalizeContract(contract);

    expect(normalized).toContain("(boundary api_boundary");
  });

  it("handles contract with mixed declaration types", async () => {
    const project = await createTempProject({
      "main.stele": [
        '(metadata (stele-version "0.1") (project "mixed"))',
        "(checker integrity_checker)",
        "(invariant CHECK_INTEGRITY",
        '  (description "Uses checker.")',
        "  (severity high)",
        "  (uses-checker integrity_checker))",
        "(invariant SIMPLE_CHECK",
        '  (description "Simple check.")',
        "  (severity high)",
        "  (assert (eq 1 1)))",
        "(operator custom_op)",
      ],
    });

    const contract = await loadContract(project.rootPath);
    const normalized = normalizeContract(contract);

    expect(contract.metadata).toHaveLength(1);
    expect(contract.checkers).toHaveLength(1);
    expect(contract.invariants).toHaveLength(2);
    expect(contract.operators).toHaveLength(1);
    expect(normalized).toContain("(operator custom_op");
  });

  it("normalizes scenario declarations", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(scenario my-scenario",
        "  (sandbox transactional)",
        "  (executor python-import)",
        '  (step setup',
        '    (call "tests.contract_scenarios:create_fund")',
        "    (capture fund)))",
        "(invariant INV_WITH_SCENARIO",
        "  (uses-scenario my-scenario)",
        '  (description "References scenario.")',
        "  (severity high)",
        "  (assert (eq 1 1)))",
      ],
    });

    const contract = await loadContract(project.rootPath);

    expect(contract.scenarios).toHaveLength(1);
    expect(contract.scenarios[0].id).toBe("my-scenario");
    expect(contract.invariants[0].usesScenario?.scenarioId).toBe("my-scenario");
  });

  it("normalizes group declarations", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(group account-rules",
        "  (invariant ACCOUNT_ACTIVE",
        '    (description "Account must be active.")',
        "    (severity high)",
        "    (assert (eq 1 1))))",
      ],
    });

    const contract = await loadContract(project.rootPath);
    const normalized = normalizeContract(contract);

    expect(contract.groups).toHaveLength(1);
    expect(contract.groups[0].id).toBe("account-rules");
    expect(contract.invariants).toHaveLength(1);
    expect(contract.invariants[0].groupId).toBe("account-rules");
    expect(normalized).toContain("(group account-rules");
  });

  it("normalizes contract with all code-shape kinds together", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(boundary api_boundary",
        "  (lang python)",
        '  (target "src/api/*.py"))',
        "(class-shape service_class",
        "  (lang python)",
        '  (target "src/services.py::Service"))',
        "(function-shape handler_fn",
        "  (lang python)",
        '  (target "src/handlers.py::handle"))',
        "(type-policy typing_rules",
        "  (lang python)",
        '  (target "src/**/*.py"))',
        "(file-policy formatting_rules",
        "  (lang python)",
        '  (target "src/settings.py"))',
      ],
    });

    const contract = await loadContract(project.rootPath);
    const normalized = normalizeContract(contract);

    expect(contract.codeShapes).toHaveLength(5);
    expect(normalized).toContain("(boundary api_boundary");
    expect(normalized).toContain("(class-shape service_class");
    expect(normalized).toContain("(function-shape handler_fn");
    expect(normalized).toContain("(type-policy typing_rules");
    expect(normalized).toContain("(file-policy formatting_rules");
  });

  it("handles invariant with keyword tags", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(invariant KEYWORD_TAGS",
        '  (description "Tags with colons.")',
        "  (severity high)",
        "  (assert (eq 1 1))",
        "  (tags :ledger :critical))",
      ],
    });

    const contract = await loadContract(project.rootPath);
    const normalized = normalizeContract(contract);

    expect(normalized).toContain(":ledger");
    expect(normalized).toContain(":critical");
  });

  it("normalizes invariant with complex nested assert", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(invariant COMPLEX_ASSERT",
        '  (description "Complex nested assertion.")',
        "  (severity high)",
        "  (assert",
        "    (and",
        "      (eq 1 1)",
        "      (gt 2 1))))",
      ],
    });

    const contract = await loadContract(project.rootPath);
    const normalized = normalizeContract(contract);

    expect(normalized).toContain("(invariant COMPLEX_ASSERT");
    expect(normalized).toContain("(assert");
    expect(normalized).toContain("(and");
  });
});

// Helper functions

function loadContract(rootPath: string): Promise<Contract> {
  const loadContractValue = (stele as Record<string, unknown>).loadContract;
  expect(loadContractValue).toBeTypeOf("function");
  return (loadContractValue as (path: string) => Promise<Contract>)(rootPath);
}

function normalizeContract(contract: Contract): string {
  const normalizeContractValue = (stele as Record<string, unknown>).normalizeContract;
  expect(normalizeContractValue).toBeTypeOf("function");
  return (normalizeContractValue as (value: Contract) => string)(contract);
}

async function createTempProject(files: Record<string, string[]>): Promise<{ directory: string; rootPath: string }> {
  const directory = await mkdtemp(join(tmpdir(), "stele-core-normalizer-edge-"));
  tempDirs.push(directory);

  await Promise.all(
    Object.entries(files).map(async ([relativePath, lines]) => {
      const fullPath = join(directory, relativePath);
      await mkdir(dirname(fullPath), { recursive: true });
      await writeFile(fullPath, lines.join("\n"), "utf8");
    }),
  );

  return {
    directory,
    rootPath: join(directory, "main.stele"),
  };
}
