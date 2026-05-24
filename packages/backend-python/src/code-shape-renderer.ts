import { stableStringCompare, type CodeShapeDeclaration } from "@stele/core";
import { CODE_SHAPE_RUNTIME_HELPERS } from "./types.js";
import { codeShapeTestPrefix } from "./code-shape-target.js";
import { renderCodeShapeTest } from "./code-shape-renderers.js";
import { allocateUniquePythonName, sanitizePythonIdentifier } from "./translation-utils.js";

// Re-exported from extracted modules
export { codeShapeTestPrefix, parseCodeShapeTarget, fileToModulePath } from "./code-shape-target.js";
export { renderCodeShapeTest } from "./code-shape-renderers.js";

// ---------------------------------------------------------------------------
// Source generation
// ---------------------------------------------------------------------------

export function generatePytestCodeShapeSource(contract: {
  codeShapes: CodeShapeDeclaration[];
}): string {
  // The pytest renderer only emits tests for `(lang python)` declarations.
  // `(lang typescript)` declarations are evaluated by the CLI's in-process
  // TypeScript analyzer in `@stele/cli` (Round 14 P1); rendering them as
  // pytest tests would try to parse TS source via Python's `ast` module
  // and fail with a SyntaxError.
  const declarations = contract.codeShapes
    .filter((d) => d.lang === "python")
    .slice()
    .sort(compareCodeShapes);
  const usedTestNames = new Set<string>();
  const bodyLines: string[] = [];

  declarations.forEach((declaration, index) => {
    const testName = allocateUniquePythonName(
      `test_${codeShapeTestPrefix(declaration.kind)}_${sanitizePythonIdentifier(declaration.id, "code_shape")}`,
      usedTestNames,
    );
    usedTestNames.add(testName);
    bodyLines.push(...renderCodeShapeTest(declaration, testName));
    if (index !== declarations.length - 1) {
      bodyLines.push("");
      bodyLines.push("");
    }
  });

  const lines = [buildCodeShapeImportLine(), "", "", ...bodyLines, ""];
  return lines.join("\n");
}

function compareCodeShapes(left: CodeShapeDeclaration, right: CodeShapeDeclaration): number {
  return (
    stableStringCompare(left.filePath, right.filePath) ||
    left.span.line - right.span.line ||
    left.span.column - right.span.column ||
    stableStringCompare(left.id, right.id)
  );
}

function buildCodeShapeImportLine(): string {
  const helpers = ["pytest"].join(", ");
  const runtimeHelpers = CODE_SHAPE_RUNTIME_HELPERS.join(", ");
  return [
    `import inspect`,
    `import ${helpers}`,
    `from ._stele_runtime import ${runtimeHelpers}`,
  ].join("\n");
}
