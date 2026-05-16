import { describe, expect, test } from "vitest";
import backend from "../src/backend.js";
import { getRustRuntimeSource } from "../src/runtime.js";
import { writeFixtureBootstrap } from "../src/conformance-bootstrap.js";
import type { Contract, ConformanceFixture, InvariantDeclaration } from "@stele/core";

// ---------------------------------------------------------------------------
// Helper: build minimal Contract for testing
// ---------------------------------------------------------------------------

function makeSpan(file = "test.cdl"): import("@stele/core").SourceSpan {
    return { file, line: 1, column: 0 };
}

function list(head: string, items: import("@stele/core").AstNode[]): import("@stele/core").ListNode {
    return { kind: "list", head, items, span: makeSpan() };
}

function ident(value: string): import("@stele/core").AstNode {
    return { kind: "identifier", value, span: makeSpan() };
}

function num(value: number, raw = `${value}`): import("@stele/core").AstNode {
    return { kind: "number", value, raw, span: makeSpan() };
}

function makeInvariant(id: string, assertExpr: import("@stele/core").AstNode, groupId?: string): InvariantDeclaration {
    return {
        kind: "invariant",
        filePath: "test.cdl",
        node: list("invariant", []) as any,
        span: makeSpan(),
        id,
        groupId,
        severity: "error",
        description: `Test invariant: ${id}`,
        assertExpression: assertExpr,
        dependsOn: [],
    };
}

function makeContract(invariants: InvariantDeclaration[], groups?: import("@stele/core").GroupDeclaration[]): Contract {
    return {
        rootPath: "/test",
        files: [],
        metadata: [],
        imports: [],
        operators: [],
        checkers: [],
        scenarios: [],
        groups: groups ?? [],
        invariants,
        codeShapes: [],
        agents: [],
        scopes: [],
        interAgentContracts: [],
        conflicts: [],
        warnings: [],
    };
}

// ---------------------------------------------------------------------------
// LanguageBackend interface tests
// ---------------------------------------------------------------------------

describe("LanguageBackend — interface", () => {
    test("has correct name", () => {
        expect(backend.name).toBe("rust");
    });

    test("has correct framework", () => {
        expect(backend.framework).toBe("cargo-test");
    });

    test("has correct file extension", () => {
        expect(backend.fileExtension).toBe(".rs");
    });

    test("has version", () => {
        expect(backend.version).toBe("0.1.0");
    });
});

// ---------------------------------------------------------------------------
// generate() tests
// ---------------------------------------------------------------------------

describe("backend.generate()", () => {
    test("emits runtime file", () => {
        const contract = makeContract([]);
        const files = backend.generate(contract, { projectRoot: "/test", outputDir: "tests/contract" });
        const runtimeFile = files.find((f) => f.path.endsWith("_stele_runtime.rs"));
        expect(runtimeFile).toBeDefined();
        expect(runtimeFile!.content).toContain("SteleValue");
    });

    test("emits test_contract.rs for top-level invariants", () => {
        const invariant = makeInvariant("inv-1", list("eq", [num(1), num(1)]));
        const contract = makeContract([invariant]);
        const files = backend.generate(contract, { projectRoot: "/test", outputDir: "tests/contract" });
        const testFile = files.find((f) => f.path.endsWith("test_contract.rs"));
        expect(testFile).toBeDefined();
        expect(testFile!.content).toContain("#[test]");
    });

    test("does NOT emit test_contract.rs when no top-level invariants", () => {
        const invariant = makeInvariant("inv-1", list("eq", [num(1), num(1)]), "group-a");
        const group: import("@stele/core").GroupDeclaration = {
            kind: "group",
            filePath: "test.cdl",
            node: list("group", []) as any,
            span: makeSpan(),
            id: "group-a",
            invariants: [invariant],
        };
        const contract = makeContract([], [group]);
        const files = backend.generate(contract, { projectRoot: "/test", outputDir: "tests/contract" });
        const testFile = files.find((f) => f.path.endsWith("test_contract.rs"));
        expect(testFile).toBeUndefined();
    });

    test("emits group test files", () => {
        const invariant = makeInvariant("inv-1", list("eq", [num(1), num(1)]), "group-a");
        const group: import("@stele/core").GroupDeclaration = {
            kind: "group",
            filePath: "test.cdl",
            node: list("group", []) as any,
            span: makeSpan(),
            id: "group-a",
            invariants: [invariant],
        };
        const contract = makeContract([], [group]);
        const files = backend.generate(contract, { projectRoot: "/test", outputDir: "tests/contract" });
        const groupFile = files.find((f) => f.path.endsWith("test_group_a.rs"));
        expect(groupFile).toBeDefined();
    });

    test("uses custom outputDir", () => {
        const invariant = makeInvariant("inv-1", list("eq", [num(1), num(1)]));
        const contract = makeContract([invariant]);
        const files = backend.generate(contract, { projectRoot: "/test", outputDir: "custom/tests" });
        const testFile = files.find((f) => f.path.includes("custom/tests"));
        expect(testFile).toBeDefined();
    });

    test("runtime content matches getRustRuntimeSource()", () => {
        const contract = makeContract([]);
        const files = backend.generate(contract, { projectRoot: "/test", outputDir: "tests/contract" });
        const runtimeFile = files.find((f) => f.path.endsWith("_stele_runtime.rs"));
        expect(runtimeFile!.content).toBe(getRustRuntimeSource());
    });

    test("all files are within outputDir", () => {
        const invariant = makeInvariant("inv-1", list("eq", [num(1), num(1)]));
        const contract = makeContract([invariant]);
        const files = backend.generate(contract, { projectRoot: "/test", outputDir: "tests/contract" });
        for (const file of files) {
            expect(file.path).toMatch(/^tests\/contract\//);
        }
    });

    test("returns deterministic file order", () => {
        const invariant = makeInvariant("inv-1", list("eq", [num(1), num(1)]));
        const contract = makeContract([invariant]);
        const files1 = backend.generate(contract, { projectRoot: "/test", outputDir: "tests/contract" });
        const files2 = backend.generate(contract, { projectRoot: "/test", outputDir: "tests/contract" });
        expect(files1.map((f) => f.path)).toEqual(files2.map((f) => f.path));
    });
});

// ---------------------------------------------------------------------------
// supportFiles() tests
// ---------------------------------------------------------------------------

describe("backend.supportFiles()", () => {
    test("returns empty array", () => {
        const contract = makeContract([]);
        const files = backend.supportFiles?.(contract, { projectRoot: "/test", outputDir: "tests/contract" });
        expect(files).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// writeFixtureBootstrap() tests
// ---------------------------------------------------------------------------

describe("writeFixtureBootstrap", () => {
    test("generates valid JSON fixture", () => {
        const fixture: ConformanceFixture = {
            id: "simple",
            dir: "/test",
            appState: { balance: 100 },
        };
        const content = writeFixtureBootstrap(fixture);
        const parsed = JSON.parse(content);
        expect(parsed).toEqual({ balance: 100 });
    });

    test("handles map appState", () => {
        const fixture: ConformanceFixture = {
            id: "map-fixture",
            dir: "/test",
            appState: { balance: 100, name: "alice" },
        };
        const content = writeFixtureBootstrap(fixture);
        const parsed = JSON.parse(content);
        expect(parsed.balance).toBe(100);
        expect(parsed.name).toBe("alice");
    });

    test("handles list appState", () => {
        const fixture: ConformanceFixture = {
            id: "list-fixture",
            dir: "/test",
            appState: [1, 2, 3],
        };
        const content = writeFixtureBootstrap(fixture);
        const parsed = JSON.parse(content);
        expect(parsed).toEqual([1, 2, 3]);
    });

    test("handles nested structures", () => {
        const fixture: ConformanceFixture = {
            id: "nested",
            dir: "/test",
            appState: {
                accounts: [
                    { balance: 100, name: "alice" },
                    { balance: 50, name: "bob" },
                ],
            },
        };
        const content = writeFixtureBootstrap(fixture);
        const parsed = JSON.parse(content);
        expect(parsed.accounts).toHaveLength(2);
        expect(parsed.accounts[0].balance).toBe(100);
    });

    test("handles null appState", () => {
        const fixture: ConformanceFixture = {
            id: "null-state",
            dir: "/test",
            appState: null,
        };
        const content = writeFixtureBootstrap(fixture);
        const parsed = JSON.parse(content);
        expect(parsed).toBeNull();
    });

    test("generates pretty-printed JSON", () => {
        const fixture: ConformanceFixture = {
            id: "formatting",
            dir: "/test",
            appState: { key: "value" },
        };
        const content = writeFixtureBootstrap(fixture);
        // Should be indented with 2 spaces
        expect(content).toMatch(/\n\s{2}/);
    });
});
