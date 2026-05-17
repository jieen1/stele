import { describe, expect, it } from "vitest";
import {
  generatePytestCodeShapeSource,
  parseCodeShapeTarget,
  fileToModulePath,
  codeShapeTestPrefix,
  renderCodeShapeTest,
} from "../src/code-shape-renderer.js";
import type { CodeShapeDeclaration } from "@stele/core";

function makeBoundaryDeclaration(): CodeShapeDeclaration {
  return {
    kind: "boundary",
    id: "no_external_imports",
    filePath: "contract/main.stele",
    lang: "python",
    target: "src/**/*.py",
    denyImports: ["os"],
    denyCalls: [],
    allowTargets: ["app"],
    node: { kind: "list", head: "boundary", items: [], span: { file: "", line: 1, column: 1 } },
    span: { file: "", line: 1, column: 1 },
  };
}

describe("generatePytestCodeShapeSource", () => {
  it("generates valid pytest code shape source", () => {
    const source = generatePytestCodeShapeSource({
      codeShapes: [makeBoundaryDeclaration()],
    });
    expect(source).toContain("def test_boundary_no_external_imports");
    expect(source).toContain("import inspect");
    expect(source).toContain("from ._stele_runtime import");
  });

  it("generates empty body for no declarations", () => {
    const source = generatePytestCodeShapeSource({ codeShapes: [] });
    expect(source).toContain("import inspect");
    expect(source).not.toContain("def test_");
  });

  it("includes all re-exported functions", () => {
    expect(typeof parseCodeShapeTarget).toBe("function");
    expect(typeof fileToModulePath).toBe("function");
    expect(typeof codeShapeTestPrefix).toBe("function");
    expect(typeof renderCodeShapeTest).toBe("function");
  });
});
