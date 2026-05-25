// Closeout 3a (2026-05-25): unit tests for the class-shape evaluator's
// free-function dispatch paths.
//
// The class-shape evaluator now binds to three target kinds:
//   1. TypeScript `class` declarations (existing path — regression guard).
//   2. Module-level free functions, with required-method / required-field
//      lookup scoped by an explicit `(aggregate-members …)` enumeration.
//   3. Factory functions whose declared return type is a literal object
//      type, with required-method / required-field lookup against the
//      return type's members.

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadContract } from "@stele/core";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, STELE_CONFIG_FILE } from "../../src/config/defaults.js";
import { evaluateCodeShapes } from "../../src/code-shape/evaluate.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.allSettled(
    tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  );
});

async function createCloseout3aProject(options: {
  contractSource: string;
  files: Record<string, string>;
}): Promise<string> {
  const projectDir = await mkdtemp(join(tmpdir(), "stele-cs-3a-"));
  tempDirs.push(projectDir);

  await writeProjectFile(projectDir, STELE_CONFIG_FILE, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`);
  await writeProjectFile(
    projectDir,
    "contract/main.stele",
    [
      "(invariant ROOT_RULE",
      "  (severity high)",
      '  (description "Root rule for fixture project.")',
      "  (assert (eq 1 1)))",
      "",
      options.contractSource,
    ].join("\n"),
  );
  await writeProjectFile(
    projectDir,
    "tests/contract/conftest.py",
    "import pytest\n\n@pytest.fixture\ndef stele_context():\n    return {}\n",
  );
  for (const [relativePath, content] of Object.entries(options.files)) {
    await writeProjectFile(projectDir, relativePath, content);
  }
  return projectDir;
}

async function writeProjectFile(projectDir: string, relativePath: string, content: string): Promise<void> {
  const fullPath = join(projectDir, relativePath);
  await mkdir(dirname(fullPath), { recursive: true });
  await writeFile(fullPath, content, "utf8");
}

describe("class-shape evaluator — class target (regression guard for Closeout 3a)", () => {
  it("binds to a TypeScript class and reports method violations as before", async () => {
    const projectDir = await createCloseout3aProject({
      contractSource: [
        "(class-shape regression_class_shape",
        "  (lang typescript)",
        '  (target "src/services.ts::OrderService")',
        '  (must-have-method "place")',
        '  (must-have-method "cancel"))',
      ].join("\n"),
      files: {
        "src/services.ts": [
          "export class OrderService {",
          "  place(): void {}",
          // `cancel` deliberately missing — should trigger a violation.
          "}",
          "",
        ].join("\n"),
      },
    });

    const contract = await loadContract(join(projectDir, "contract", "main.stele"));
    const violations = await evaluateCodeShapes(projectDir, contract, "check");
    const csViolations = violations.filter((v) => v.rule_id === "regression_class_shape");
    expect(csViolations).toHaveLength(1);
    expect(csViolations[0]!.cause.summary).toContain('method "cancel"');
  });
});

describe("class-shape evaluator — module-function target (Closeout 3a)", () => {
  it("passes when every required method is a real sibling and listed in aggregate-members", async () => {
    const projectDir = await createCloseout3aProject({
      contractSource: [
        "(class-shape module_fn_pass",
        "  (lang typescript)",
        '  (target "src/check.ts::runCheck")',
        '  (must-have-method "runCheck")',
        '  (must-have-method "prepareCheckContextWithContract")',
        '  (aggregate-members "prepareCheckContextWithContract" "runCheckImpl"))',
      ].join("\n"),
      files: {
        "src/check.ts": [
          "export function runCheck(): void {}",
          "export function prepareCheckContextWithContract(): void {}",
          "export function runCheckImpl(): void {}",
          "",
        ].join("\n"),
      },
    });

    const contract = await loadContract(join(projectDir, "contract", "main.stele"));
    const violations = await evaluateCodeShapes(projectDir, contract, "check");
    const ruleViolations = violations.filter((v) => v.rule_id === "module_fn_pass");
    expect(ruleViolations).toEqual([]);
  });

  it("fires a violation when a required-method sibling is missing from the module", async () => {
    const projectDir = await createCloseout3aProject({
      contractSource: [
        "(class-shape module_fn_missing_method",
        "  (lang typescript)",
        '  (target "src/check.ts::runCheck")',
        '  (must-have-method "runCheck")',
        '  (must-have-method "prepareCheckContextWithContract")',
        '  (aggregate-members "prepareCheckContextWithContract"))',
      ].join("\n"),
      files: {
        // `prepareCheckContextWithContract` is missing.
        "src/check.ts": [
          "export function runCheck(): void {}",
          "",
        ].join("\n"),
      },
    });

    const contract = await loadContract(join(projectDir, "contract", "main.stele"));
    const violations = await evaluateCodeShapes(projectDir, contract, "check");
    const ruleViolations = violations.filter((v) => v.rule_id === "module_fn_missing_method");
    expect(ruleViolations.length).toBeGreaterThan(0);
    const summaries = ruleViolations.map((v) => v.cause.summary);
    // Two failures: the aggregate-member sanity check + the required-method
    // check. Both name `prepareCheckContextWithContract`.
    expect(summaries.some((s) => s.includes("prepareCheckContextWithContract"))).toBe(true);
  });

  it("passes when a required-field sibling is present as a top-level const", async () => {
    const projectDir = await createCloseout3aProject({
      contractSource: [
        "(class-shape module_fn_field_pass",
        "  (lang typescript)",
        '  (target "src/registry.ts::getRegistry")',
        '  (must-have-field "REGISTRY_KEY")',
        '  (aggregate-members "REGISTRY_KEY"))',
      ].join("\n"),
      files: {
        "src/registry.ts": [
          "export const REGISTRY_KEY = Symbol(\"reg\");",
          "export function getRegistry(): void {}",
          "",
        ].join("\n"),
      },
    });

    const contract = await loadContract(join(projectDir, "contract", "main.stele"));
    const violations = await evaluateCodeShapes(projectDir, contract, "check");
    const ruleViolations = violations.filter((v) => v.rule_id === "module_fn_field_pass");
    expect(ruleViolations).toEqual([]);
  });

  it("fires a violation when a required-field sibling is missing from the module", async () => {
    const projectDir = await createCloseout3aProject({
      contractSource: [
        "(class-shape module_fn_field_missing",
        "  (lang typescript)",
        '  (target "src/registry.ts::getRegistry")',
        '  (must-have-field "REGISTRY_KEY")',
        '  (aggregate-members "REGISTRY_KEY"))',
      ].join("\n"),
      files: {
        // `REGISTRY_KEY` is not declared anywhere.
        "src/registry.ts": [
          "export function getRegistry(): void {}",
          "",
        ].join("\n"),
      },
    });

    const contract = await loadContract(join(projectDir, "contract", "main.stele"));
    const violations = await evaluateCodeShapes(projectDir, contract, "check");
    const ruleViolations = violations.filter((v) => v.rule_id === "module_fn_field_missing");
    expect(ruleViolations.length).toBeGreaterThan(0);
    expect(ruleViolations.some((v) => v.cause.summary.includes("REGISTRY_KEY"))).toBe(true);
  });

  it("emits an enumeration violation when a required-method is outside aggregate-members", async () => {
    const projectDir = await createCloseout3aProject({
      contractSource: [
        "(class-shape module_fn_out_of_scope",
        "  (lang typescript)",
        '  (target "src/check.ts::runCheck")',
        '  (must-have-method "stealthySibling")',
        '  (aggregate-members "knownSibling"))',
      ].join("\n"),
      files: {
        "src/check.ts": [
          "export function runCheck(): void {}",
          "export function knownSibling(): void {}",
          "export function stealthySibling(): void {}",
          "",
        ].join("\n"),
      },
    });

    const contract = await loadContract(join(projectDir, "contract", "main.stele"));
    const violations = await evaluateCodeShapes(projectDir, contract, "check");
    const ruleViolations = violations.filter((v) => v.rule_id === "module_fn_out_of_scope");
    expect(ruleViolations.length).toBeGreaterThan(0);
    expect(
      ruleViolations.some((v) =>
        v.cause.summary.includes("stealthySibling") &&
        v.cause.summary.includes("aggregate-members"),
      ),
    ).toBe(true);
  });
});

describe("class-shape evaluator — factory target (Closeout 3a)", () => {
  it("passes when every required method is present on the literal return type", async () => {
    const projectDir = await createCloseout3aProject({
      contractSource: [
        "(class-shape factory_pass",
        "  (lang typescript)",
        '  (target "src/factory.ts::makeRegistry")',
        '  (must-have-method "add")',
        '  (must-have-method "get"))',
      ].join("\n"),
      files: {
        "src/factory.ts": [
          "export function makeRegistry(): { add(): void; get(): unknown } {",
          "  return { add() {}, get() { return undefined; } };",
          "}",
          "",
        ].join("\n"),
      },
    });

    const contract = await loadContract(join(projectDir, "contract", "main.stele"));
    const violations = await evaluateCodeShapes(projectDir, contract, "check");
    const ruleViolations = violations.filter((v) => v.rule_id === "factory_pass");
    expect(ruleViolations).toEqual([]);
  });

  it("fires a violation when a required method is absent from the literal return type", async () => {
    const projectDir = await createCloseout3aProject({
      contractSource: [
        "(class-shape factory_missing_method",
        "  (lang typescript)",
        '  (target "src/factory.ts::makeRegistry")',
        '  (must-have-method "add")',
        '  (must-have-method "remove"))',
      ].join("\n"),
      files: {
        // `remove` is missing from the return type.
        "src/factory.ts": [
          "export function makeRegistry(): { add(): void } {",
          "  return { add() {} };",
          "}",
          "",
        ].join("\n"),
      },
    });

    const contract = await loadContract(join(projectDir, "contract", "main.stele"));
    const violations = await evaluateCodeShapes(projectDir, contract, "check");
    const ruleViolations = violations.filter((v) => v.rule_id === "factory_missing_method");
    expect(ruleViolations).toHaveLength(1);
    expect(ruleViolations[0]!.cause.summary).toContain("remove");
  });

  it("fires a violation when a required field is absent from the literal return type", async () => {
    const projectDir = await createCloseout3aProject({
      contractSource: [
        "(class-shape factory_missing_field",
        "  (lang typescript)",
        '  (target "src/factory.ts::makeBag")',
        '  (must-have-field "count"))',
      ].join("\n"),
      files: {
        // The return type declares `add()` but not the `count` field.
        "src/factory.ts": [
          "export function makeBag(): { add(): void } {",
          "  return { add() {} };",
          "}",
          "",
        ].join("\n"),
      },
    });

    const contract = await loadContract(join(projectDir, "contract", "main.stele"));
    const violations = await evaluateCodeShapes(projectDir, contract, "check");
    const ruleViolations = violations.filter((v) => v.rule_id === "factory_missing_field");
    expect(ruleViolations).toHaveLength(1);
    expect(ruleViolations[0]!.cause.summary).toContain("count");
  });
});

describe("class-shape evaluator — target not found (Closeout 3a)", () => {
  it("emits the unified not-found violation when the selector is neither class, function, nor factory", async () => {
    const projectDir = await createCloseout3aProject({
      contractSource: [
        "(class-shape unknown_selector",
        "  (lang typescript)",
        '  (target "src/empty.ts::doesNotExist")',
        '  (must-have-method "foo"))',
      ].join("\n"),
      files: {
        "src/empty.ts": "export const SOMETHING_ELSE = 1;\n",
      },
    });

    const contract = await loadContract(join(projectDir, "contract", "main.stele"));
    const violations = await evaluateCodeShapes(projectDir, contract, "check");
    const ruleViolations = violations.filter((v) => v.rule_id === "unknown_selector");
    expect(ruleViolations).toHaveLength(1);
    expect(ruleViolations[0]!.cause.summary).toContain('"doesNotExist"');
    expect(ruleViolations[0]!.cause.summary).toContain("was not found");
  });
});
