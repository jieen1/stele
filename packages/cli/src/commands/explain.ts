import { readFile } from "node:fs/promises";
import { posix, resolve } from "node:path";
import {
  buildInvariantTrace,
  formatExplainTrace,
  invariantExplanation,
  loadContract,
  type InvariantDeclaration,
  type SourceSpan,
} from "@stele/core";
import { sanitizePythonIdentifier } from "@stele/backend-python";
import { loadConfig } from "../config/loadConfig.js";
import { buildRuleIndex, findIndexedRule } from "./rules.js";
import { formatAstNode, toProjectRelativePath } from "../utils/shared-utils.js";

export type ExplainOptions = {
  json?: boolean;
};

export async function runExplain(projectDir: string, invariantId: string, options: ExplainOptions = {}): Promise<void> {
  const config = await loadConfig(projectDir);
  const contract = await loadContract(resolve(projectDir, config.entry));
  const invariant = contract.invariants.find((candidate) => candidate.id === invariantId);

  if (invariant === undefined) {
    throw new Error(`Invariant "${invariantId}" was not found in the loaded contract.`);
  }

  const source = await getInvariantSource(invariant);
  const explanation = invariantExplanation(invariant);

  if (options.json) {
    const index = await buildRuleIndex(projectDir);
    const rule = findIndexedRule(index, invariant.id);

    process.stdout.write(`${JSON.stringify({ rule, source, explanation }, null, 2)}\n`);
    return;
  }

  const generatedTestPath =
    invariant.groupId === undefined
      ? posix.join(config.generatedDir, "test_contract.py")
      : posix.join(config.generatedDir, `test_${sanitizePythonIdentifier(invariant.groupId, "group")}.py`);

  const lines = [
    `ID: ${invariant.id}`,
    `File Path: ${toProjectRelativePath(projectDir, invariant.filePath)}`,
    `Generated Test Path: ${generatedTestPath}`,
    `Dependencies: ${invariant.dependsOn.length === 0 ? "<none>" : invariant.dependsOn.map((dependency) => dependency.id).join(", ")}`,
    `Rationale: ${invariant.rationale === undefined ? "<none>" : formatAstNode(invariant.rationale.valueNode)}`,
    `Checker ID: ${invariant.usesChecker?.checkerId ?? "<none>"}`,
    `Explanation: ${explanation ?? "<none>"}`,
    "",
    "## Expression Trace",
  ];

  // Build and format the expression trace
  const trace = buildInvariantTrace(invariant, null);
  const traceLines = formatExplainTrace(trace);
  lines.push(...traceLines);

  lines.push("");
  lines.push("## Source");
  lines.push(source);

  process.stdout.write(`${lines.join("\n")}\n`);
}

async function getInvariantSource(invariant: InvariantDeclaration): Promise<string> {
  const fileContents = await readFile(invariant.filePath, "utf8");
  return extractSourceFromSpan(fileContents, invariant.span) ?? formatAstNode(invariant.node);
}

function extractSourceFromSpan(source: string, span: SourceSpan): string | undefined {
  const start = offsetForSpan(source, span);
  let cursor = start;

  while (cursor < source.length && /\s/.test(source[cursor]!)) {
    cursor += 1;
  }

  if (source[cursor] !== "(") {
    return undefined;
  }

  let depth = 0;
  let inString = false;
  let inComment = false;
  let escaping = false;

  for (let index = cursor; index < source.length; index += 1) {
    const character = source[index]!;

    if (inComment) {
      if (character === "\n") {
        inComment = false;
      }
      continue;
    }

    if (inString) {
      if (escaping) {
        escaping = false;
        continue;
      }
      if (character === "\\") {
        escaping = true;
        continue;
      }
      if (character === '"') {
        inString = false;
      }
      continue;
    }

    if (character === '"') {
      inString = true;
      continue;
    }

    if (character === ";") {
      inComment = true;
      continue;
    }

    if (character === "(") {
      depth += 1;
      continue;
    }

    if (character === ")") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(cursor, index + 1);
      }
    }
  }

  return undefined;
}

function offsetForSpan(source: string, span: SourceSpan): number {
  const lineOffsets = [0];

  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === "\n") {
      lineOffsets.push(index + 1);
    }
  }

  const lineOffset = lineOffsets[span.line - 1];

  if (lineOffset === undefined) {
    throw new Error(`Could not resolve source span line ${span.line} in ${span.file}.`);
  }

  return lineOffset + Math.max(span.column - 1, 0);
}
