import { describe, expect, it } from "vitest";
import {
  buildCanonicalGeneratedPaths,
  mergeExpectedGeneratedPaths,
  normalizeGeneratedFiles,
  assertGeneratedFilesMatchExpectedLayout,
} from "../src/generator/layout.js";
import type { Contract, ContractFile } from "../src/validator/structure.js";
import type { ListNode } from "../src/ast/types.js";
import type { ParsedFile } from "../src/ast/types.js";
import type { LanguageBackend, GeneratedFile } from "../src/generator/types.js";

function makeContract(overrides: Partial<Contract> = {}): Contract {
  const span = { file: "t.stele", line: 1, column: 1 };
  const node: ListNode = { kind: "list", head: "invariant", items: [], span };
  const parsed: ParsedFile = { kind: "file", body: [], file: "t.stele" };
  const file: ContractFile = {
    path: "t.stele",
    parsed,
    imports: [],
    operators: [],
    checkers: [],
    scenarios: [],
    groups: [],
    invariants: [],
    codeShapes: [],
    agents: [],
    scopes: [],
    interAgentContracts: [],
    conflicts: [],
    coreNodes: [],
    architectures: [],
  };
  return {
    rootPath: ".",
    files: [file],
    metadata: [],
    imports: [],
    operators: [],
    checkers: [],
    scenarios: [],
    groups: [],
    invariants: [],
    codeShapes: [],
    agents: [],
    scopes: [],
    interAgentContracts: [],
    conflicts: [],
    coreNodes: [],
    architectures: [],
    warnings: [],
    ...overrides,
  };
}

const pythonBackend: LanguageBackend = {
  name: "python",
  framework: "pytest",
  fileExtension: ".py",
  version: "0.1.0",
  generate: () => [],
};

describe("buildCanonicalGeneratedPaths", () => {
  it("returns runtime path for python backend", () => {
    const paths = buildCanonicalGeneratedPaths(makeContract(), pythonBackend, "tests/contract");
    expect(paths).toContain("tests/contract/_stele_runtime.py");
  });

  it("adds test_contract when invariants present", () => {
    const span = { file: "t.stele", line: 1, column: 1 };
    const inv = {
      kind: "invariant" as const,
      id: "X",
      filePath: "t.stele",
      node: { kind: "list" as const, head: "invariant", items: [], span },
      span,
      severity: "error",
      description: "test",
      assertExpression: { kind: "identifier" as const, value: "True", span },
      dependsOn: [],
    };
    const paths = buildCanonicalGeneratedPaths(makeContract({ invariants: [inv] }), pythonBackend, "tests/contract");
    expect(paths).toContain("tests/contract/test_contract.py");
  });

  it("no test_contract when no invariants", () => {
    const paths = buildCanonicalGeneratedPaths(makeContract(), pythonBackend, "tests/contract");
    expect(paths).not.toContain("test_contract");
  });

  it("paths are sorted", () => {
    const paths = buildCanonicalGeneratedPaths(makeContract(), pythonBackend, "tests/contract");
    const sorted = [...paths].sort();
    expect(paths).toEqual(sorted);
  });
});

describe("mergeExpectedGeneratedPaths", () => {
  it("merges canonical and support paths", () => {
    const result = mergeExpectedGeneratedPaths(
      ["a.py", "b.py"],
      ["c.py", "d.py"],
    );
    expect(result).toEqual(["a.py", "b.py", "c.py", "d.py"]);
  });

  it("deduplicates identical paths", () => {
    expect(() => mergeExpectedGeneratedPaths(["a.py", "a.py"], [])).toThrow("Duplicate");
  });

  it("detects case-insensitive collisions", () => {
    expect(() => mergeExpectedGeneratedPaths(["A.py", "a.py"], [])).toThrow("Case-insensitive");
  });
});

describe("normalizeGeneratedFiles", () => {
  it("normalizes valid files", () => {
    const files: GeneratedFile[] = [
      { path: "tests/contract/test_a.py", content: "content_a" },
      { path: "tests/contract/test_b.py", content: "content_b" },
    ];
    const result = normalizeGeneratedFiles(files, "tests/contract");
    expect(result).toHaveLength(2);
    expect(result[0]?.path).toBe("tests/contract/test_a.py");
  });

  it("rejects files outside output directory", () => {
    const files: GeneratedFile[] = [
      { path: "src/bad.py", content: "x" },
    ];
    expect(() => normalizeGeneratedFiles(files, "tests/contract")).toThrow("is outside");
  });

  it("rejects invalid file entries", () => {
    expect(() => normalizeGeneratedFiles([{ path: "x" } as any], "out")).toThrow("invalid generated file entry");
  });
});

describe("assertGeneratedFilesMatchExpectedLayout", () => {
  it("passes when files match", () => {
    const files: GeneratedFile[] = [
      { path: "out/a.py", content: "a" },
      { path: "out/b.py", content: "b" },
    ];
    expect(() => assertGeneratedFilesMatchExpectedLayout(files, ["out/a.py", "out/b.py"], "test")).not.toThrow();
  });

  it("throws for missing files", () => {
    const files: GeneratedFile[] = [
      { path: "out/a.py", content: "a" },
    ];
    expect(() => assertGeneratedFilesMatchExpectedLayout(files, ["out/a.py", "out/b.py"], "test")).toThrow("did not emit the canonical");
  });

  it("throws for unexpected files", () => {
    const files: GeneratedFile[] = [
      { path: "out/a.py", content: "a" },
      { path: "out/extra.py", content: "e" },
    ];
    expect(() => assertGeneratedFilesMatchExpectedLayout(files, ["out/a.py"], "test")).toThrow("did not emit the canonical");
  });
});
