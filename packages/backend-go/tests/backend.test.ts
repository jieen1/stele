import { describe, it, expect } from "vitest";
import backend from "../src/backend.js";
import { writeFixtureBootstrap } from "../src/conformance-bootstrap.js";
import type { Contract, ConformanceFixture } from "@stele/core";

// ---------------------------------------------------------------------------
// Backend metadata tests
// ---------------------------------------------------------------------------

describe("LanguageBackend metadata", () => {
  it("has name 'go'", () => {
    expect(backend.name).toBe("go");
  });

  it("has framework 'testing'", () => {
    expect(backend.framework).toBe("testing");
  });

  it("has fileExtension '_test.go'", () => {
    expect(backend.fileExtension).toBe(".go");
  });

  it("has version '0.1.0'", () => {
    expect(backend.version).toBe("0.1.0");
  });
});

// ---------------------------------------------------------------------------
// generate() tests
// ---------------------------------------------------------------------------

describe("generate()", () => {
  it("returns runtime file", () => {
    const files = backend.generate(createTestContract(), { projectRoot: "/tmp" });
    const runtime = files.find((f) => f.path.endsWith("stele_runtime_test.go"));
    expect(runtime).toBeDefined();
    expect(runtime!.content).toContain("package contract_test");
  });

  it("returns test_contract_test.go for top-level invariants", () => {
    const files = backend.generate(createTestContract(), { projectRoot: "/tmp" });
    const testFile = files.find((f) => f.path.endsWith("test_contract_test.go"));
    expect(testFile).toBeDefined();
    expect(testFile!.content).toContain("func TestBalance_positive");
  });

  it("returns group test files", () => {
    const contract = createContractWithGroup("account", [createInvariant("balance-positive")]);
    const files = backend.generate(contract, { projectRoot: "/tmp" });
    const groupFile = files.find((f) => f.path.endsWith("test_account_test.go"));
    expect(groupFile).toBeDefined();
  });

  it("uses custom output directory", () => {
    const files = backend.generate(createTestContract(), { projectRoot: "/tmp", outputDir: "contract_test" });
    const testFile = files.find((f) => f.path.includes("contract_test/"));
    expect(testFile).toBeDefined();
  });

  it("includes package declaration in generated files", () => {
    const files = backend.generate(createTestContract(), { projectRoot: "/tmp" });
    const testFile = files.find((f) => f.path.endsWith("test_contract_test.go"));
    expect(testFile!.content).toContain("package contract_test");
  });

  it("generates deterministic output", () => {
    const files1 = backend.generate(createTestContract(), { projectRoot: "/tmp" });
    const files2 = backend.generate(createTestContract(), { projectRoot: "/tmp" });
    expect(files1).toEqual(files2);
  });

  it("skips test_contract_test.go when no top-level invariants", () => {
    const contract = createContractWithGroup("account", [createInvariant("balance-positive")]);
    contract.invariants = [];
    const files = backend.generate(contract, { projectRoot: "/tmp" });
    const testFile = files.find((f) => f.path.endsWith("test_contract_test.go"));
    expect(testFile).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// supportFiles() tests
// ---------------------------------------------------------------------------

describe("supportFiles()", () => {
  it("returns empty array (setup_test.go provided by init)", () => {
    const files = backend.supportFiles!(createTestContract(), { projectRoot: "/tmp" });
    expect(files).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// writeFixtureBootstrap() tests
// ---------------------------------------------------------------------------

describe("writeFixtureBootstrap()", () => {
  it("returns setup_test.go", () => {
    const fixture = createFixture({ accounts: [{ id: 1, balance: 100 }] });
    const result = writeFixtureBootstrap(fixture);
    expect(result.name).toBe("setup_test.go");
  });

  it("generates Go package declaration", () => {
    const fixture = createFixture({ accounts: [] });
    const result = writeFixtureBootstrap(fixture);
    expect(result.content).toContain("package contract_test");
  });

  it("converts string values to Go literals", () => {
    const fixture = createFixture({ name: "test" });
    const result = writeFixtureBootstrap(fixture);
    expect(result.content).toContain(`ctx.Data["name"] = "test"`);
  });

  it("converts number values to Go literals", () => {
    const fixture = createFixture({ count: 42 });
    const result = writeFixtureBootstrap(fixture);
    expect(result.content).toContain("ctx.Data[\"count\"] = 42");
  });

  it("converts boolean values to Go literals", () => {
    const fixture = createFixture({ active: true });
    const result = writeFixtureBootstrap(fixture);
    expect(result.content).toContain("ctx.Data[\"active\"] = true");
  });

  it("converts null to nil", () => {
    const fixture = createFixture({ value: null });
    const result = writeFixtureBootstrap(fixture);
    expect(result.content).toContain("ctx.Data[\"value\"] = nil");
  });

  it("converts arrays to []any{}", () => {
    const fixture = createFixture({ ids: [1, 2, 3] });
    const result = writeFixtureBootstrap(fixture);
    expect(result.content).toContain("[]any{1, 2, 3}");
  });

  it("converts nested objects to map[string]any{}", () => {
    const fixture = createFixture({ account: { id: 1, balance: 100 } });
    const result = writeFixtureBootstrap(fixture);
    expect(result.content).toContain("map[string]any{");
  });

  it("generates SetupSteleContext function", () => {
    const fixture = createFixture({});
    const result = writeFixtureBootstrap(fixture);
    expect(result.content).toContain("func SetupSteleContext()");
    expect(result.content).toContain("ctx := NewContext()");
    expect(result.content).toContain("return ctx");
  });
});

// ---------------------------------------------------------------------------
// Test data helpers
// ---------------------------------------------------------------------------

function createTestContract(): Contract {
  return {
    rootPath: "test.cdl",
    files: [],
    metadata: [],
    imports: [],
    operators: [],
    checkers: [],
    scenarios: [],
    groups: [],
    invariants: [createInvariant("balance-positive")],
    codeShapes: [],
    agents: [],
    scopes: [],
    interAgentContracts: [],
    architectures: [],
    coreNodes: [],
    brandedIds: [],
    smartCtors: [],
    conflicts: [],
    warnings: [],
  };
}

function createInvariant(id: string): any {
  return {
    kind: "invariant",
    filePath: "test.cdl",
    node: { kind: "list", head: "invariant", items: [], span: { file: "test.cdl", line: 1, column: 0 } },
    span: { file: "test.cdl", line: 1, column: 0 },
    id,
    severity: "error",
    description: "Test invariant",
    assertExpression: {
      kind: "list",
      head: "gt",
      items: [
        { kind: "list", head: "path", items: [{ kind: "identifier", value: "balance", span: { file: "test.cdl", line: 1, column: 0 } }], span: { file: "test.cdl", line: 1, column: 0 } },
        { kind: "number", value: 0, raw: "0", span: { file: "test.cdl", line: 1, column: 0 } },
      ],
      span: { file: "test.cdl", line: 1, column: 0 },
    },
    dependsOn: [],
  };
}

function createContractWithGroup(groupId: string, invariants: any[]): Contract {
  return {
    rootPath: "test.cdl",
    files: [],
    metadata: [],
    imports: [],
    operators: [],
    checkers: [],
    scenarios: [],
    groups: [
      {
        kind: "group",
        filePath: "test.cdl",
        node: { kind: "list", head: "group", items: [], span: { file: "test.cdl", line: 1, column: 0 } },
        span: { file: "test.cdl", line: 1, column: 0 },
        id: groupId,
        invariants,
      },
    ],
    invariants,
    codeShapes: [],
    agents: [],
    scopes: [],
    interAgentContracts: [],
    architectures: [],
    coreNodes: [],
    brandedIds: [],
    smartCtors: [],
    conflicts: [],
    warnings: [],
  };
}

function createFixture(appState: Record<string, unknown>): ConformanceFixture {
  return {
    id: "test-fixture",
    dir: "/tmp/fixture",
    appState,
  };
}
