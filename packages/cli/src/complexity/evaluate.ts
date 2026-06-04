import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import type { CoreNodeDeclaration, CoreNodeMetricBoundary, CoreNodeMetricName } from "@stele/core";
import { getMetricStatus, parseCoreNodeTarget, type CoreNodeEvaluationResult, type CoreNodeMeasurement, type CoreNodeViolation, type CoreNodeNotice } from "./types.js";
import {
  countSLOC,
  countPublicMethods,
  computeMaxCyclomaticComplexity,
  findClassByName,
  findFunctionByName,
  findInterfaceByName,
} from "./typescript-metrics.js";
import * as ts from "typescript";

// ----------------------------------------------------------------
// Evaluate core-node declaration against its declared boundaries.
// ----------------------------------------------------------------

/**
 * Evaluate a single core-node declaration against its declared boundaries.
 */
export async function evaluateCoreNode(
  projectDir: string,
  declaration: CoreNodeDeclaration,
): Promise<CoreNodeEvaluationResult> {
  const parsed = parseCoreNodeTarget(declaration.target);

  if (parsed === undefined) {
    return {
      measurement: createStubMeasurement(declaration),
      violations: [],
      notices: [],
    };
  }

  const filePath = resolve(projectDir, parsed.filePath);

  if (!existsSync(filePath)) {
    // Missing target file — configuration violation, not success
    return {
      measurement: createStubMeasurement(declaration),
      violations: [{
        nodeId: declaration.id,
        target: declaration.target,
        metric: "missing-target" as CoreNodeMetricName,
        value: 0,
        ideal: 0,
        max: 0,
        isConfigurationViolation: true,
      }],
      notices: [],
    };
  }

  const metrics = await collectMetrics(filePath, parsed.className);

  if (metrics.sloc === -1) {
    return {
      measurement: createStubMeasurement(declaration),
      violations: [{
        nodeId: declaration.id,
        target: declaration.target,
        metric: "missing-target" as CoreNodeMetricName,
        value: 0,
        ideal: 0,
        max: 0,
        isConfigurationViolation: true,
      }],
      notices: [],
    };
  }

  const measurement = buildMeasurement(declaration, metrics, filePath, parsed.className);
  const { violations, notices } = classifyMetrics(measurement);

  return { measurement, violations, notices };
}

/**
 * Evaluate all core-node declarations in the contract.
 */
export async function evaluateCoreNodes(
  projectDir: string,
  declarations: CoreNodeDeclaration[],
): Promise<CoreNodeEvaluationResult[]> {
  const results: CoreNodeEvaluationResult[] = [];
  for (const declaration of declarations) {
    results.push(await evaluateCoreNode(projectDir, declaration));
  }
  return results;
}

// ----------------------------------------------------------------
// Metric collection (AST-based)
// ----------------------------------------------------------------

type RawMetricValues = {
  sloc: number;
  publicMethodCount: number;
  maxCyclomatic: number;
};

/**
 * Collect raw metric values from a TypeScript source file using the compiler API.
 * Supports class, function, and interface targets.
 */
async function collectMetrics(
  filePath: string,
  symbolName: string,
): Promise<RawMetricValues> {
  try {
    const text = readFileSync(filePath, "utf8");

    const compilerOptions: ts.CompilerOptions = {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
    };

    const sourceFile = ts.createSourceFile(
      filePath,
      text,
      compilerOptions.target ?? ts.ScriptTarget.Latest,
      // setParentNodes MUST be true: countSLOCForFunction/Interface call
      // node.getStart(), which walks parent pointers to the SourceFile. Without
      // it getStart() throws, the catch below swallows it, and every metric
      // silently reads 0 — making core-node constraints vacuous.
      /* setParentNodes */ true,
    );

    // Try class first (has SLOC/public-method/cyclomatic metrics)
    const classNode = findClassByName(sourceFile, symbolName);
    if (classNode !== undefined) {
      const sloc = countSLOC(text, classNode);
      const publicMethodCount = countPublicMethods(classNode);
      const maxCyclomatic = computeMaxCyclomaticComplexity(classNode);
      return { sloc, publicMethodCount, maxCyclomatic };
    }

    // Try function declaration or variable (countSLOC for functions uses the whole function body)
    const funcNode = findFunctionByName(sourceFile, symbolName);
    if (funcNode !== undefined) {
      const sloc = countSLOCForFunction(text, funcNode);
      const maxCyclomatic = computeMaxCyclomaticForFunction(funcNode);
      return { sloc, publicMethodCount: 0, maxCyclomatic };
    }

    // Try interface (only SLOC is meaningful for interfaces)
    const ifaceNode = findInterfaceByName(sourceFile, symbolName);
    if (ifaceNode !== undefined) {
      const sloc = countSLOCForInterface(text, ifaceNode);
      return { sloc, publicMethodCount: 0, maxCyclomatic: 0 };
    }

    return { sloc: -1, publicMethodCount: -1, maxCyclomatic: -1 };
  } catch {
    return { sloc: 0, publicMethodCount: 0, maxCyclomatic: 0 };
  }
}

/**
 * Count SLOC for a function declaration or variable.
 */
function countSLOCForFunction(source: string, node: ts.Node): number {
  // node.getStart() needs parent pointers (setParentNodes:true at the
  // SourceFile). `getStartPosition` is not a ts.Node API and was always
  // undefined — the real start comes from getStart().
  const start = node.getStart();
  const end = node.getEnd();
  const fnText = source.slice(start, end);
  const lines = fnText.split("\n");
  let count = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) continue;
    count++;
  }
  return count;
}

/**
 * Compute cyclomatic complexity for a function.
 */
function computeMaxCyclomaticForFunction(node: ts.Node): number {
  if (ts.isFunctionDeclaration(node) && node.body) {
    return computeFunctionCyclomatic(node.body);
  }
  if (ts.isVariableDeclaration(node) && node.initializer) {
    const init: ts.Node = node.initializer;
    if (ts.isArrowFunction(init)) {
      if (ts.isBlock(init.body)) {
        return computeFunctionCyclomatic(init.body);
      }
      return 2;
    }
    if (ts.isFunctionExpression(init)) {
      if (ts.isBlock(init.body)) {
        return computeFunctionCyclomatic(init.body);
      }
      return 1;
    }
  }
  return 1;
}

function computeFunctionCyclomatic(node: ts.Node): number {
  let complexity = 1;

  const visit = (n: ts.Node): void => {
    if (ts.isIfStatement(n) || ts.isForStatement(n) || ts.isForOfStatement(n) ||
        ts.isWhileStatement(n) || ts.isCatchClause(n) || ts.isConditionalExpression(n) ||
        ts.isCaseClause(n)) {
      complexity++;
    }
    if (ts.isBinaryExpression(n)) {
      const op = n.operatorToken;
      if (op.kind === ts.SyntaxKind.AmpersandAmpersandToken || op.kind === ts.SyntaxKind.BarBarToken) {
        complexity++;
      }
    }
    ts.forEachChild(n, visit);
  };

  ts.forEachChild(node, visit);
  return complexity;
}

/**
 * Count SLOC for an interface declaration.
 */
function countSLOCForInterface(source: string, node: ts.Node): number {
  const start = node.getStart();
  const end = node.getEnd();
  const ifaceText = source.slice(start, end);
  const lines = ifaceText.split("\n");
  let count = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) continue;
    count++;
  }
  return count;
}

// ----------------------------------------------------------------
// Measurement building
// ----------------------------------------------------------------

function buildMeasurement(
  declaration: CoreNodeDeclaration,
  rawValues: RawMetricValues,
  filePath: string,
  className: string,
): CoreNodeMeasurement {
  const metrics = declaration.metrics.map((boundary: CoreNodeMetricBoundary) => {
    const value = getRawValue(rawValues, boundary.name);
    return {
      name: boundary.name,
      value,
      ideal: boundary.ideal,
      max: boundary.max,
      status: getMetricStatus(value, boundary.ideal, boundary.max),
    };
  });

  return {
    id: declaration.id,
    role: declaration.role,
    target: declaration.target,
    filePath,
    className,
    metrics,
  };
}

function getRawValue(
  raw: RawMetricValues,
  name: CoreNodeMetricName,
): number {
  switch (name) {
    case "sloc":
      return raw.sloc;
    case "public-method-count":
      return raw.publicMethodCount;
    case "max-cyclomatic":
      return raw.maxCyclomatic;
  }
  return 0;
}

function createStubMeasurement(
  declaration: CoreNodeDeclaration,
): CoreNodeMeasurement {
  const parsed = parseCoreNodeTarget(declaration.target);
  return {
    id: declaration.id,
    role: declaration.role,
    target: declaration.target,
    filePath: parsed?.filePath ?? declaration.target,
    className: parsed?.className ?? "",
    metrics: declaration.metrics.map((boundary: CoreNodeMetricBoundary) => ({
      name: boundary.name,
      value: 0,
      ideal: boundary.ideal,
      max: boundary.max,
      status: "ok" as const,
    })),
  };
}

// ----------------------------------------------------------------
// Classification
// ----------------------------------------------------------------

function classifyMetrics(measurement: CoreNodeMeasurement): {
  violations: CoreNodeViolation[];
  notices: CoreNodeNotice[];
} {
  const violations: CoreNodeViolation[] = [];
  const notices: CoreNodeNotice[] = [];

  for (const metric of measurement.metrics) {
    if (metric.status === "over-max") {
      violations.push({
        nodeId: measurement.id,
        target: measurement.target,
        metric: metric.name,
        value: metric.value,
        ideal: metric.ideal,
        max: metric.max,
      });
    } else if (metric.status === "above-ideal") {
      notices.push({
        nodeId: measurement.id,
        target: measurement.target,
        metric: metric.name,
        value: metric.value,
        ideal: metric.ideal,
        max: metric.max,
      });
    }
  }

  return { violations, notices };
}
