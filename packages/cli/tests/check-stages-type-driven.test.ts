import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type {
  BrandedIdDeclaration,
  Contract,
  ContractFile,
  SmartCtorDeclaration,
} from "@stele/core";
import type {
  ListNode,
  ParsedFile,
} from "@stele/core";
import { buildTypeDrivenStage } from "../src/commands/check-stages-type-driven.js";
import type {
  PreparedCheckContext,
  ProtectedCheckState,
} from "../src/architecture/types.js";

const FIXTURES = resolve(__dirname, "fixtures", "typescript-shape");

function makeSpan() {
  return { file: "x.stele", line: 1, column: 1 };
}

function makeListNode(head: string): ListNode {
  return { kind: "list", head, items: [], span: makeSpan() };
}

function makeContract(
  brandedIds: BrandedIdDeclaration[] = [],
  smartCtors: SmartCtorDeclaration[] = [],
): Contract {
  const parsed: ParsedFile = { kind: "file", body: [], file: "x.stele" };
  const file: ContractFile = {
    path: "x.stele",
    parsed,
    imports: [],
    operators: [],
    checkers: [],
    scenarios: [],
    groups: [],
    invariants: [],
    codeShapes: [],
    architectures: [],
    coreNodes: [],
    brandedIds,
    smartCtors,
    tracePolicies: [],
    typeStates: [],
    typeStateBindings: [],
    effectDeclarations: [],
    effectAnnotations: [],
    effectPolicies: [],
    effectSuppressions: [],
  };
  return {
    rootPath: FIXTURES,
    files: [file],
    metadata: [],
    imports: [],
    operators: [],
    checkers: [],
    scenarios: [],
    groups: [],
    invariants: [],
    codeShapes: [],
    architectures: [],
    coreNodes: [],
    brandedIds,
    smartCtors,
    tracePolicies: [],
    typeStates: [],
    typeStateBindings: [],
    effectDeclarations: [],
    effectAnnotations: [],
    effectPolicies: [],
    effectSuppressions: [],
  };
}

function makePreparedContext(contract: Contract): PreparedCheckContext {
  return {
    projectDir: FIXTURES,
    config: {
      version: "0.1",
      contractDir: "contract",
      entry: "main.stele",
      generatedDir: "tests/contract",
      checkerImplDir: "contract/checker_impls",
      manifestPath: "contract/.manifest.json",
      targetLanguage: "python",
      testFramework: "pytest",
      pathMode: "auto",
      protected: [],
    },
    contract,
    generated: {
      ok: true,
      outputDir: "tests/contract",
      unchanged: [],
      missing: [],
      changed: [],
      extra: [],
      files: [],
    },
    invariantCount: 0,
  };
}

function makeProtectedState(): ProtectedCheckState {
  return {
    protectedPaths: [],
    contractHash: "",
    summary: {
      invariantCount: 0,
      generatedFileCount: 0,
      protectedFileCount: 0,
    },
  };
}

describe("buildTypeDrivenStage", () => {
  it("returns ok with no violations when contract has no branded-ids or smart-ctors", async () => {
    const contract = makeContract([], []);
    const ctx = makePreparedContext(contract);
    const protectedState = makeProtectedState();
    const report = await buildTypeDrivenStage(ctx, protectedState, "check");
    expect(report.ok).toBe(true);
    expect(report.violations).toHaveLength(0);
  });

  it("reports violations when branded-id source file is missing", async () => {
    const brandedId: BrandedIdDeclaration = {
      kind: "branded-id",
      filePath: "x.stele",
      node: makeListNode("branded-id"),
      span: makeSpan(),
      id: "MissingType",
      target: "nonexistent.ts::MissingType",
      baseType: "string",
    };
    const contract = makeContract([brandedId], []);
    const ctx = makePreparedContext(contract);
    const protectedState = makeProtectedState();
    const report = await buildTypeDrivenStage(ctx, protectedState, "check");
    expect(report.ok).toBe(false);
    expect(report.violations.length).toBeGreaterThan(0);
    expect(report.violations[0].rule_id).toContain("typedriven.branded-id.MissingType");
  });

  it("reports violations when entity-scope file uses raw string instead of branded ID", async () => {
    const brandedId: BrandedIdDeclaration = {
      kind: "branded-id",
      filePath: "x.stele",
      node: makeListNode("branded-id"),
      span: makeSpan(),
      id: "InvoiceId",
      target: "branded/InvoiceId.ts::InvoiceId",
      baseType: "string",
      entityScope: "branded-invalid/**/*.ts",
    };
    const contract = makeContract([brandedId], []);
    const ctx = makePreparedContext(contract);
    const protectedState = makeProtectedState();
    const report = await buildTypeDrivenStage(ctx, protectedState, "check");
    expect(report.ok).toBe(false);
    // Each violation references the rule_id for the InvoiceId branded type
    for (const v of report.violations) {
      expect(v.rule_id).toBe("typedriven.branded-id.InvoiceId");
      expect(v.rule_kind).toBe("typescript-branded-id");
      expect(v.location.path).toBeDefined();
    }
  });

  it("passes when entity-scope files correctly use branded ID", async () => {
    const brandedId: BrandedIdDeclaration = {
      kind: "branded-id",
      filePath: "x.stele",
      node: makeListNode("branded-id"),
      span: makeSpan(),
      id: "InvoiceId",
      target: "branded/InvoiceId.ts::InvoiceId",
      baseType: "string",
      entityScope: "branded/**/*.ts",
    };
    const contract = makeContract([brandedId], []);
    const ctx = makePreparedContext(contract);
    const protectedState = makeProtectedState();
    const report = await buildTypeDrivenStage(ctx, protectedState, "check");
    expect(report.ok).toBe(true);
  });

  it("skips smart-ctor enforcement when target is absent", async () => {
    const smartCtor: SmartCtorDeclaration = {
      kind: "smart-ctor",
      filePath: "x.stele",
      node: makeListNode("smart-ctor"),
      span: makeSpan(),
      id: "RuleId",
      constructorName: "parseRuleId",
      denyRaw: true,
    };
    const contract = makeContract([], [smartCtor]);
    const ctx = makePreparedContext(contract);
    const protectedState = makeProtectedState();
    const report = await buildTypeDrivenStage(ctx, protectedState, "check");
    expect(report.ok).toBe(true);
  });
});
