import { readFile } from "node:fs/promises";
import { posix, resolve } from "node:path";
import {
  buildInvariantTrace,
  formatExplainTrace,
  invariantExplanation,
  loadContract,
  sanitizeIdentifier,
  type ArchitectureDeclaration,
  type InvariantDeclaration,
  type SourceSpan,
} from "@stele/core";
import { loadConfig } from "../config/loadConfig.js";
import { buildRuleIndex, findIndexedRule } from "./rules.js";
import { formatAstNode, toProjectRelativePath } from "../utils/shared-utils.js";

export type ExplainOptions = {
  json?: boolean;
};

export async function runExplain(projectDir: string, invariantId: string, options: ExplainOptions = {}): Promise<void> {
  const config = await loadConfig(projectDir);
  const contract = await loadContract(resolve(projectDir, config.entry));

  // Check for architecture:<arch-id> syntax
  if (invariantId.startsWith("architecture:")) {
    const archId = invariantId.slice("architecture:".length);
    const architecture = contract.architectures.find((candidate) => candidate.id === archId);

    if (architecture === undefined) {
      throw new Error(`Architecture "${archId}" was not found in the loaded contract.`);
    }

    if (options.json) {
      process.stdout.write(`${JSON.stringify(buildArchitectureExplainJson(architecture, projectDir), null, 2)}\n`);
      return;
    }

    process.stdout.write(formatArchitectureExplain(architecture, projectDir));
    return;
  }

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
      : posix.join(config.generatedDir, `test_${sanitizeIdentifier(invariant.groupId, "group")}.py`);

  const trace = buildInvariantTrace(invariant, null);

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
    ...formatExplainTrace(trace),
    "",
    "## Source",
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

// ----------------------------------------------------------------
// Architecture explain
// ----------------------------------------------------------------

function formatArchitectureExplain(arch: ArchitectureDeclaration, projectDir: string): string {
  const lines = [
    `Architecture: ${arch.id}`,
    `Language: ${arch.lang}`,
    `Description: ${arch.description ?? "<none>"}`,
    `Deny cycles: ${arch.denyCycles}`,
    `Fix: ${arch.fix ?? "<none>"}`,
    "",
    "## Modules",
    ...arch.modules.map((mod) => `- ${mod.id}: ${mod.paths.join(", ")}`),
    "",
    "## Allowed dependencies",
  ];

  if (arch.allowDependencies.length === 0) {
    lines.push("- <none>");
  } else {
    for (const dep of arch.allowDependencies) {
      lines.push(`- ${dep.from} -> ${dep.to.join(", ")}`);
    }
  }

  if (arch.layers.length > 0) {
    lines.push("", "## Layers", ...arch.layers.map((layer) => `- ${layer.id}: ${layer.modules.join(", ")}`));
  }

  return `${lines.join("\n")}\n`;
}

function buildArchitectureExplainJson(arch: ArchitectureDeclaration, projectDir: string): Record<string, unknown> {
  return {
    schema_version: "1",
    tool: "@stele/cli",
    command: "explain",
    type: "architecture",
    architecture_id: arch.id,
    language: arch.lang,
    description: arch.description ?? null,
    deny_cycles: arch.denyCycles,
    fix: arch.fix ?? null,
    tsconfig: arch.tsconfig ?? null,
    file_path: toProjectRelativePath(projectDir, arch.filePath),
    line: arch.span.line,
    modules: arch.modules.map((mod) => ({ id: mod.id, paths: mod.paths, public_entries: mod.publicEntries })),
    layers: arch.layers.map((layer) => ({ id: layer.id, modules: layer.modules })),
    allow_dependencies: arch.allowDependencies.map((dep) => ({ from: dep.from, to: dep.to })),
  };
}
