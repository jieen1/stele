import { readFile } from "node:fs/promises";
import { posix, relative, resolve } from "node:path";
import { sanitizePythonIdentifier } from "@stele/backend-python";
import { loadContract, type AstNode, type InvariantDeclaration, type SourceSpan } from "@stele/core";
import { loadConfig } from "../config/loadConfig.js";
import { buildRuleIndex, findIndexedRule } from "./rules.js";

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

  if (options.json) {
    const index = await buildRuleIndex(projectDir);
    const rule = findIndexedRule(index, invariant.id);

    process.stdout.write(`${JSON.stringify({ rule, source }, null, 2)}\n`);
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
    "Source:",
    source,
  ];

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

function formatAstNode(node: AstNode): string {
  switch (node.kind) {
    case "identifier":
      return node.value;
    case "keyword":
      return `:${node.value}`;
    case "string":
      return JSON.stringify(node.value);
    case "number":
      return node.raw;
    case "list":
      return `(${node.head}${node.items.length === 0 ? "" : ` ${node.items.map(formatAstNode).join(" ")}`})`;
  }
}

function toProjectRelativePath(projectDir: string, filePath: string): string {
  return relative(projectDir, filePath).replaceAll("\\", "/");
}
