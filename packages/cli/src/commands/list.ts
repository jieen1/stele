import { relative, resolve } from "node:path";
import { loadContract, type AstNode, type InvariantDeclaration } from "@stele/core";
import { loadConfig } from "../config/loadConfig.js";

export type ListOptions = {
  severity?: string;
  category?: string;
  tag?: string;
};

const LIST_HEADER = "ID\tSeverity\tCategory\tDescription\tFile Path";

export async function runList(projectDir: string, options: ListOptions): Promise<void> {
  const config = await loadConfig(projectDir);
  const contract = await loadContract(resolve(projectDir, config.entry));
  const invariants = contract.invariants.slice().sort(compareInvariants).filter((invariant) => matchesFilters(invariant, options));
  const lines = [
    LIST_HEADER,
    ...invariants.map((invariant) =>
      [
        invariant.id,
        invariant.severity,
        invariant.category === undefined ? "<none>" : formatAstNode(invariant.category.valueNode),
        invariant.description,
        toProjectRelativePath(projectDir, invariant.filePath),
      ].join("\t"),
    ),
  ];

  process.stdout.write(`${lines.join("\n")}\n`);
}

function matchesFilters(invariant: InvariantDeclaration, options: ListOptions): boolean {
  if (options.severity !== undefined && invariant.severity !== options.severity) {
    return false;
  }

  if (options.category !== undefined) {
    const categoryNode = invariant.category?.valueNode;

    if (categoryNode === undefined || !nodeMatchesFilter(categoryNode, options.category)) {
      return false;
    }
  }

  if (options.tag !== undefined) {
    const tags = invariant.tags?.valueNodes ?? [];

    if (!tags.some((tag) => nodeMatchesFilter(tag, options.tag!))) {
      return false;
    }
  }

  return true;
}

function nodeMatchesFilter(node: AstNode, filter: string): boolean {
  return filterVariants(node).has(filter);
}

function filterVariants(node: AstNode): Set<string> {
  const variants = new Set([formatAstNode(node)]);

  if (node.kind === "identifier") {
    variants.add(node.value);
  } else if (node.kind === "keyword") {
    variants.add(node.value);
    variants.add(`:${node.value}`);
  } else if (node.kind === "string") {
    variants.add(node.value);
  } else if (node.kind === "number") {
    variants.add(node.raw);
    variants.add(String(node.value));
  }

  return variants;
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

function compareInvariants(left: InvariantDeclaration, right: InvariantDeclaration): number {
  return (
    left.filePath.localeCompare(right.filePath) ||
    left.span.line - right.span.line ||
    left.span.column - right.span.column ||
    left.id.localeCompare(right.id)
  );
}

function toProjectRelativePath(projectDir: string, filePath: string): string {
  return relative(projectDir, filePath).replaceAll("\\", "/");
}
