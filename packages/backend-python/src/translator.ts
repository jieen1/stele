import { getPythonRuntimeSource, PYTEST_RUNTIME_PATH } from "./runtime.js";

// Re-exported from extracted modules
export {
  PYTEST_PACKAGE_INIT_PATH,
  PYTEST_TEST_PATH,
  PYTEST_CODE_SHAPE_PATH,
  type GeneratedPytestFile,
  type PythonExpressionTranslator,
  type PythonOperatorHandler,
  type TranslationContext,
} from "./types.js";
export {
  sanitizePythonIdentifier,
  allocateUniquePythonName,
  createTranslationContext,
  toPythonString,
  encodeCheckerArgs,
} from "./translation-utils.js";
export { wrapExpression } from "./expression.js";
export {
  serializeScenario,
  serializeScenarioValue,
  renderPythonValue,
} from "./scenario-serialization.js";
export {
  parseCodeShapeTarget,
  fileToModulePath,
  codeShapeTestPrefix,
  renderCodeShapeTest,
  generatePytestCodeShapeSource,
} from "./code-shape-renderer.js";
export {
  translateExpression,
} from "./expression.js";
export {
  generatePytestSource,
  renderInvariantTest,
  compareInvariants,
  buildPytestImportLine,
} from "./invariant-renderer.js";

import type { Contract } from "@stele/core";
import { type GeneratedPytestFile } from "./types.js";
import { PYTEST_PACKAGE_INIT_PATH, PYTEST_TEST_PATH, PYTEST_CODE_SHAPE_PATH } from "./types.js";
import { generatePytestSource } from "./invariant-renderer.js";
import { generatePytestCodeShapeSource } from "./code-shape-renderer.js";

// ---------------------------------------------------------------------------
// Entry point: file generation
// ---------------------------------------------------------------------------

export function generatePytestFiles(contract: Contract): GeneratedPytestFile[] {
  const files: GeneratedPytestFile[] = [
    {
      path: PYTEST_PACKAGE_INIT_PATH,
      content: "",
    },
    {
      path: PYTEST_RUNTIME_PATH,
      content: getPythonRuntimeSource(),
    },
    {
      path: PYTEST_TEST_PATH,
      content: generatePytestSource(contract),
    },
  ];

  if (contract.codeShapes.length > 0) {
    files.push({
      path: PYTEST_CODE_SHAPE_PATH,
      content: generatePytestCodeShapeSource(contract),
    });
  }

  return files;
}
