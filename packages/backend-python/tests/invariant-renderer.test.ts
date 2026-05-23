import { describe, expect, it } from "vitest";
import {
  compareInvariants,
  buildPytestImportLine,
  generatePytestSource,
} from "../src/invariant-renderer.js";
import type { InvariantDeclaration, Contract, ListNode } from "@stele/core";

function makeInvariant(id: string, severity = "error"): InvariantDeclaration {
  const span = { file: "contract/main.stele", line: 1, column: 1 };
  const node: ListNode = { kind: "list", head: "invariant", items: [], span };
  // Use a uses-checker expression so generatePytestSource does not need translateExpression
  // on a bare identifier — uses-checker path is self-contained
  return {
    kind: "invariant",
    id,
    filePath: "contract/main.stele",
    node,
    span,
    severity,
    description: "Test invariant",
    usesChecker: {
      checkerId: "stele_check_path",
      span,
      args: [],
      node: { kind: "list", head: "uses-checker", items: [], span },
    },
    dependsOn: [],
  };
}

function makeContract(invariants: InvariantDeclaration[]): Contract {
  return {
    rootPath: ".",
    files: [],
    metadata: [],
    imports: [],
    operators: [],
    checkers: [],
    scenarios: [],
    groups: [],
    invariants,
    codeShapes: [],
    architectures: [],
    coreNodes: [],
    brandedIds: [],
    smartCtors: [],
    tracePolicies: [],
    typeStates: [],
    typeStateBindings: [],
    effectDeclarations: [],
    effectAnnotations: [],
    effectPolicies: [],
    effectSuppressions: [],
  };
}

describe("compareInvariants", () => {
  it("sorts by file path first", () => {
    const a = makeInvariant("A");
    const b = makeInvariant("B");
    b.filePath = "contract/zzz.stele";
    expect(compareInvariants(a, b)).toBeLessThan(0);
  });

  it("sorts by line number when file path equal", () => {
    const a = makeInvariant("A");
    const b = makeInvariant("B");
    a.span.line = 1;
    b.span.line = 2;
    a.filePath = b.filePath = "contract/main.stele";
    expect(compareInvariants(a, b)).toBeLessThan(0);
  });
});

describe("buildPytestImportLine", () => {
  it("generates import line without scenarios", () => {
    const contract = makeContract([makeInvariant("TEST")]);
    const line = buildPytestImportLine(contract);
    expect(line).toMatch(/^from \._stele_runtime import /);
    expect(line).toContain("stele_call_checker");
  });

  it("includes scenario helpers when scenario used", () => {
    const inv = makeInvariant("TEST");
    inv.usesScenario = {
      scenarioId: "S1",
      span: { file: "", line: 1, column: 1 },
      node: { kind: "list", head: "uses-scenario", items: [], span: { file: "", line: 1, column: 1 } },
    };
    const contract = makeContract([inv]);
    const line = buildPytestImportLine(contract);
    expect(line).toContain("stele_run_scenario");
  });
});

describe("generatePytestSource", () => {
  it("generates valid pytest source", () => {
    const contract = makeContract([makeInvariant("EMAIL_FORMAT")]);
    const source = generatePytestSource(contract);
    expect(source).toContain("def test_EMAIL_FORMAT(");
    expect(source).toContain("from ._stele_runtime import");
  });

  it("generates empty source for no invariants", () => {
    const contract = makeContract([]);
    const source = generatePytestSource(contract);
    expect(source).toContain("from ._stele_runtime import");
    expect(source).not.toContain("def test_");
  });

  it("sorts invariants deterministically", () => {
    const a = makeInvariant("Z");
    const b = makeInvariant("A");
    a.filePath = "contract/zzz.stele";
    b.filePath = "contract/aaa.stele";
    const contract = makeContract([a, b]);
    const source = generatePytestSource(contract);
    // B (aaa.stele) should come before A (zzz.stele)
    const zIdx = source.indexOf("def test_Z(");
    const aIdx = source.indexOf("def test_A(");
    expect(aIdx).toBeLessThan(zIdx);
  });
});
