import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import type { CoreNodeDeclaration, CoreNodeMetricBoundary, CoreNodeMetricName } from "@stele/core";
import { getMetricStatus, parseCoreNodeTarget, type CoreNodeEvaluationResult, type CoreNodeMeasurement, type CoreNodeViolation, type CoreNodeNotice } from "./types.js";
import {
  countSLOC,
  countPublicMethods,
  computeMaxCyclomaticComplexity,
  findClassByName,
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
 */
async function collectMetrics(
  filePath: string,
  className: string,
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
    );

    const classNode = findClassByName(sourceFile, className);

    if (classNode === undefined) {
      return { sloc: 0, publicMethodCount: 0, maxCyclomatic: 0 };
    }

    const sloc = countSLOC(text, classNode);
    const publicMethodCount = countPublicMethods(classNode);
    const maxCyclomatic = computeMaxCyclomaticComplexity(classNode);

    return { sloc, publicMethodCount, maxCyclomatic };
  } catch {
    return { sloc: 0, publicMethodCount: 0, maxCyclomatic: 0 };
  }
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
