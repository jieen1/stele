import { relative, resolve } from "node:path";
import {
  createViolation,
  ruleId,
  type CodeShapeDeclaration,
  type Violation,
} from "@stele/core";
import { uniqueSortedStrings } from "@stele/core";

export type PythonImport = {
  candidates: string[];
  line: number;
  column: number;
};

export type PythonCall = {
  name: string;
  line: number;
  column: number;
};

export type PythonAnnotation = {
  text: string;
  names: string[];
  line: number;
  column: number;
};

export type PythonField = {
  name: string;
  annotation?: string;
  line: number;
  column: number;
};

export type PythonMethod = {
  name: string;
  line: number;
  column: number;
  decorators: string[];
  parameters: string[];
  calls: PythonCall[];
  annotations: PythonAnnotation[];
  fastapiRoute: boolean;
};

export type PythonClass = {
  name: string;
  line: number;
  column: number;
  bases: string[];
  fields: PythonField[];
  methods: PythonMethod[];
  annotations: PythonAnnotation[];
};

export type PythonFunction = {
  name: string;
  qualname: string;
  line: number;
  column: number;
  decorators: string[];
  parameters: string[];
  calls: PythonCall[];
  annotations: PythonAnnotation[];
  fastapiRoute: boolean;
  // Closeout 3a (2026-05-25): populated by the TS analyzer only when the
  // function's declared return type is a literal object type. Always
  // undefined for Python-analyzed files; the class-shape evaluator's
  // factory-mode dispatch is TS-only.
  returnTypeMembers?: string[];
};

export type TypeFieldAnalysis = {
  name: string;
  annotation?: string;
  annotationNames: string[];
  optional: boolean;
  line: number;
  column: number;
};

export type TypeDeclarationAnalysis = {
  name: string;
  kind: "interface" | "type";
  line: number;
  column: number;
  fields: TypeFieldAnalysis[];
};

export type PythonFileAnalysis = {
  path: string;
  imports: PythonImport[];
  calls: PythonCall[];
  annotations: PythonAnnotation[];
  classes: PythonClass[];
  functions: PythonFunction[];
  // Closeout 3a (2026-05-25): populated by the TS analyzer; empty for
  // Python-analyzed files. The class-shape evaluator's module-function
  // mode uses this to enumerate sibling exports referenced by
  // `aggregate-members`.
  moduleVariables?: string[];
  // Populated by the TS analyzer. Used by type-policy declarations that
  // constrain fields on interface/type-alias declarations.
  typeDeclarations?: TypeDeclarationAnalysis[];
};

export type ParsedTarget = {
  pathPattern: string;
  selectorName?: string;
  selectorFilter?: string;
};

export type SelectorValidation = {
  error?: string;
};

export function createRuleViolation(options: {
  declaration: CodeShapeDeclaration;
  command: string;
  contractPath: string;
  filePath: string;
  summary: string;
  detail: string;
  fixSummary: string;
  line?: number;
  column?: number;
  scopePaths?: string[];
}): Violation {
  return createViolation({
    rule_id: ruleId(options.declaration.id),
    rule_kind: "rule_violation",
    severity: "error",
    source: {
      tool: "stele",
      command: options.command,
      kind: "rule",
    },
    location: {
      path: options.filePath,
      line: options.line,
      column: options.column,
    },
    cause: {
      summary: options.summary,
      detail: options.detail,
    },
    scope_paths: options.scopePaths ?? uniqueSortedStrings([options.filePath, options.contractPath]),
    fix: {
      summary: options.fixSummary,
    },
  });
}

export function createConfigurationViolation(contractPath: string, declarationId: string, summary: string, command: string): Violation {
  return createViolation({
    rule_id: ruleId("stele.check.execution_error"),
    rule_kind: "execution_error",
    severity: "error",
    source: {
      tool: "stele",
      command,
      kind: "execution",
    },
    location: {
      path: contractPath,
    },
    cause: {
      summary,
    },
    scope_paths: [contractPath],
    fix: {
      summary: `Update code-shape "${declarationId}" so its target selector is valid.`,
    },
  });
}

export function parseTarget(target: string): ParsedTarget {
  const separatorIndex = target.indexOf("::");

  if (separatorIndex === -1) {
    return {
      pathPattern: normalizeRelativePath(target),
    };
  }

  const pathPattern = normalizeRelativePath(target.slice(0, separatorIndex));
  const selector = target.slice(separatorIndex + 2).trim();

  if (selector.startsWith("[") && selector.endsWith("]")) {
    return {
      pathPattern,
      selectorFilter: selector.slice(1, -1),
    };
  }

  const filterIndex = selector.indexOf("[");

  if (filterIndex !== -1 && selector.endsWith("]")) {
    return {
      pathPattern,
      selectorName: selector.slice(0, filterIndex),
      selectorFilter: selector.slice(filterIndex + 1, -1),
    };
  }

  return {
    pathPattern,
    selectorName: selector,
  };
}

export function matchesNamedReference(actual: string, expected: string): boolean {
  return actual === expected || actual.endsWith(`.${expected}`);
}

export function collectClassMatches(
  target: ParsedTarget,
  matchedFiles: string[],
  fileAnalyses: Map<string, PythonFileAnalysis>,
): Array<{ filePath: string; classInfo: PythonClass }> {
  const matches: Array<{ filePath: string; classInfo: PythonClass }> = [];

  for (const filePath of matchedFiles) {
    const analysis = fileAnalyses.get(filePath);

    if (analysis === undefined) {
      continue;
    }

    for (const classInfo of analysis.classes) {
      if (classInfo.name === target.selectorName) {
        matches.push({ filePath, classInfo });
      }
    }
  }

  return matches;
}

export function collectFunctionMatches(
  target: ParsedTarget,
  matchedFiles: string[],
  fileAnalyses: Map<string, PythonFileAnalysis>,
): Array<{ filePath: string; functionInfo: PythonFunction }> {
  const matches: Array<{ filePath: string; functionInfo: PythonFunction }> = [];

  for (const filePath of matchedFiles) {
    const analysis = fileAnalyses.get(filePath);

    if (analysis === undefined) {
      continue;
    }

    for (const functionInfo of analysis.functions) {
      if (target.selectorName !== undefined && functionInfo.name !== target.selectorName && functionInfo.qualname !== target.selectorName) {
        continue;
      }

      if (target.selectorFilter === "fastapi-route" && !functionInfo.fastapiRoute) {
        continue;
      }

      matches.push({ filePath, functionInfo });
    }
  }

  return matches;
}

export function createScopePaths(contractPath: string, matchedFiles: string[], fallbackPath: string): string[] {
  return uniqueSortedStrings([contractPath, ...(matchedFiles.length === 0 ? [fallbackPath] : matchedFiles)]);
}

export function normalizeRelativePath(path: string): string {
  return path.replaceAll("\\", "/");
}

export function toProjectRelativePath(projectDir: string, path: string): string {
  const relativePath = normalizeRelativePath(relative(resolve(projectDir), resolve(path)));
  return relativePath.length === 0 ? "." : relativePath;
}
