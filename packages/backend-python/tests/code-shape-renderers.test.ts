import { describe, expect, it } from "vitest";
import { renderCodeShapeTest } from "../src/code-shape-renderers.js";
import type { CodeShapeDeclaration, ClassShapeDeclaration, FunctionShapeDeclaration } from "@stele/core";

function makeClassShape(overrides?: Partial<ClassShapeDeclaration>): ClassShapeDeclaration {
  return {
    kind: "class-shape",
    id: "test_class_shape",
    filePath: "contract/main.stele",
    lang: "python",
    target: "app/model.py::Model",
    mustHaveFields: [],
    mustHaveMethods: [],
    mustExtend: [],
    node: { kind: "list", head: "class-shape", items: [], span: { file: "", line: 1, column: 1 } },
    span: { file: "", line: 1, column: 1 },
    ...overrides,
  };
}

function makeFunctionShape(overrides?: Partial<FunctionShapeDeclaration>): FunctionShapeDeclaration {
  return {
    kind: "function-shape",
    id: "test_func_shape",
    filePath: "contract/main.stele",
    lang: "python",
    target: "app/utils.py::format_total",
    mustHaveCalls: [],
    mustHaveDecorators: [],
    mustHaveParameters: [],
    node: { kind: "list", head: "function-shape", items: [], span: { file: "", line: 1, column: 1 } },
    span: { file: "", line: 1, column: 1 },
    ...overrides,
  };
}

describe("renderCodeShapeTest", () => {
  it("renders class-shape test", () => {
    const decl = makeClassShape();
    const lines = renderCodeShapeTest(decl as any, "test_model");
    expect(lines[0]).toBe("def test_model(stele_context):");
    expect(lines[1]).toContain("stele_resolve_class");
  });

  it("renders function-shape test", () => {
    const decl = makeFunctionShape();
    const lines = renderCodeShapeTest(decl as any, "test_format_total");
    expect(lines[0]).toBe("def test_format_total(stele_context):");
    expect(lines[1]).toContain("stele_resolve_function");
  });

  it("renders boundary test", () => {
    const decl = {
      kind: "boundary" as const,
      id: "test_boundary",
      filePath: "contract/main.stele",
      lang: "python" as const,
      target: "src/**/*.py",
      denyImports: ["os"],
      denyCalls: [],
      allowTargets: ["app"],
      node: { kind: "list" as const, head: "boundary", items: [], span: { file: "", line: 1, column: 1 } },
      span: { file: "", line: 1, column: 1 },
    };
    const lines = renderCodeShapeTest(decl, "test_boundary");
    expect(lines[0]).toBe("def test_boundary(stele_context):");
    expect(lines[1]).toContain("stele_glob");
  });

  it("renders type-policy test", () => {
    const decl = {
      kind: "type-policy" as const,
      id: "test_type_policy",
      filePath: "contract/main.stele",
      lang: "python" as const,
      target: "src/**/*.py",
      denyTypes: [],
      requireTypes: [],
      node: { kind: "list" as const, head: "type-policy", items: [], span: { file: "", line: 1, column: 1 } },
      span: { file: "", line: 1, column: 1 },
    };
    const lines = renderCodeShapeTest(decl, "test_type_policy");
    expect(lines[0]).toBe("def test_type_policy(stele_context):");
  });

  it("renders file-policy test", () => {
    const decl = {
      kind: "file-policy" as const,
      id: "test_file_policy",
      filePath: "contract/main.stele",
      lang: "python" as const,
      target: "src/**/*.py",
      mustContain: [],
      mustEndWith: [],
      node: { kind: "list" as const, head: "file-policy", items: [], span: { file: "", line: 1, column: 1 } },
      span: { file: "", line: 1, column: 1 },
    };
    const lines = renderCodeShapeTest(decl, "test_file_policy");
    expect(lines[0]).toBe("def test_file_policy(stele_context):");
  });

  it("renders class-shape with required fields", () => {
    const decl = makeClassShape({
      mustHaveFields: [
        { name: "id", span: { file: "", line: 1, column: 1 } },
        { name: "name", type: "str", span: { file: "", line: 1, column: 1 } },
      ],
    });
    const lines = renderCodeShapeTest(decl as any, "test_model");
    expect(lines.some((l) => l.includes("stele_has_field"))).toBe(true);
    expect(lines.some((l) => l.includes('expected_type="str"'))).toBe(true);
  });

  it("renders class-shape with required methods", () => {
    const decl = makeClassShape({ mustHaveMethods: ["save"] });
    const lines = renderCodeShapeTest(decl as any, "test_model");
    expect(lines.some((l) => l.includes("stele_has_callable"))).toBe(true);
  });

  it("throws for class-shape without class selector", () => {
    const decl = makeClassShape({ target: "src/**/*.py" });
    expect(() => renderCodeShapeTest(decl as any, "test_model")).toThrow('must specify a class name');
  });
});
