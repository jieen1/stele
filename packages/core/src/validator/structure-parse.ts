import path from "node:path";
import type { AstNode, ListNode, SourceSpan } from "../ast/types.js";
import { SteleError } from "../errors/SteleError.js";
import type { ParsedFile } from "../parser/parser.js";
import { describeNode, validationError } from "./structure-error.js";
import { parseInvariantDeclaration } from "./structure-invariant.js";
import { parseScenarioDeclaration } from "./structure-scenario.js";
import { parseCodeShapeDeclaration } from "./structure-code-shape.js";
import {
  parseAgentDeclaration,
  parseScopeDeclaration,
  parseInterAgentContractDeclaration,
  parseConflictDeclaration,
} from "./structure-agent.js";
import { TOP_LEVEL_DECLARATIONS } from "./structure-types.js";
import { readSingleExpression } from "./structure-shared.js";
import type {
  AgentDeclaration,
  ConflictDeclaration,
  Contract,
  ContractFile,
  GroupDeclaration,
  ImportDeclaration,
  InterAgentContractDeclaration,
  LoadedContractFile,
  MetadataDeclaration,
  OperatorDeclaration,
  ScopeDeclaration,
  CheckerDeclaration,
} from "./structure-types.js";

export function buildContract(rootPath: string, files: LoadedContractFile[]): Contract {
  const contractFiles = files.map((file) => parseContractFile(file));

  return {
    rootPath,
    files: contractFiles,
    metadata: contractFiles.flatMap((file) => (file.metadata === undefined ? [] : [file.metadata])),
    imports: contractFiles.flatMap((file) => file.imports),
    operators: contractFiles.flatMap((file) => file.operators),
    checkers: contractFiles.flatMap((file) => file.checkers),
    scenarios: contractFiles.flatMap((file) => file.scenarios),
    groups: contractFiles.flatMap((file) => file.groups),
    invariants: contractFiles.flatMap((file) => file.invariants),
    codeShapes: contractFiles.flatMap((file) => file.codeShapes),
    agents: contractFiles.flatMap((file) => file.agents),
    scopes: contractFiles.flatMap((file) => file.scopes),
    interAgentContracts: contractFiles.flatMap((file) => file.interAgentContracts),
    conflicts: contractFiles.flatMap((file) => file.conflicts),
    warnings: [],
  };
}

export function collectImportDeclarations(filePath: string, parsed: ParsedFile): ImportDeclaration[] {
  return parsed.body.flatMap((node) => {
    if (node.kind !== "list" || node.head !== "import") {
      return [];
    }

    return [parseImportDeclaration(filePath, node)];
  });
}

function parseContractFile(file: LoadedContractFile): ContractFile {
  let metadata: MetadataDeclaration | undefined;
  const imports: ImportDeclaration[] = [];
  const operators: OperatorDeclaration[] = [];
  const checkers: CheckerDeclaration[] = [];
  const scenarios: Array<ReturnType<typeof parseScenarioDeclaration>> = [];
  const groups: GroupDeclaration[] = [];
  const invariants: Array<ReturnType<typeof parseInvariantDeclaration>> = [];
  const codeShapes: Array<ReturnType<typeof parseCodeShapeDeclaration>> = [];
  const agents: AgentDeclaration[] = [];
  const scopes: ScopeDeclaration[] = [];
  const interAgentContracts: InterAgentContractDeclaration[] = [];
  const conflicts: ConflictDeclaration[] = [];

  for (const node of file.parsed.body) {
    if (node.kind !== "list") {
      throw validationError(
        "E0301",
        "Unknown top-level declaration.",
        node.span,
        "Top-level CDL forms must be list declarations such as (metadata ...), (import ...), or (invariant ...).",
        "Replace this atom with a supported top-level declaration.",
      );
    }

    if (!TOP_LEVEL_DECLARATIONS.has(node.head)) {
      throw validationError(
        "E0301",
        `Unknown top-level declaration "${node.head}".`,
        node.span,
        `Supported top-level declarations are: ${Array.from(TOP_LEVEL_DECLARATIONS).join(", ")}.`,
        "Rename or remove this declaration.",
      );
    }

    switch (node.head) {
      case "metadata": {
        if (metadata !== undefined) {
          throw validationError(
            "E0302",
            "metadata may appear at most once per file.",
            node.span,
            `A metadata block was already declared earlier in ${file.path}.`,
            "Keep a single metadata block and merge fields into it.",
          );
        }

        metadata = {
          kind: "metadata",
          filePath: file.path,
          node,
          span: node.span,
          fields: [...node.items],
        };
        break;
      }
      case "import":
        imports.push(parseImportDeclaration(file.path, node));
        break;
      case "operator":
        operators.push(parseOperatorDeclaration(file.path, node));
        break;
      case "checker":
        checkers.push(parseCheckerDeclaration(file.path, node));
        break;
      case "scenario":
        scenarios.push(parseScenarioDeclaration(file.path, node));
        break;
      case "group": {
        const group = parseGroupDeclaration(file.path, node);
        groups.push(group);
        invariants.push(...group.invariants);
        break;
      }
      case "invariant":
        invariants.push(parseInvariantDeclaration(file.path, node));
        break;
      case "boundary":
      case "class-shape":
      case "function-shape":
      case "type-policy":
      case "file-policy":
        codeShapes.push(parseCodeShapeDeclaration(file.path, node));
        break;
      case "agent":
        agents.push(parseAgentDeclaration(file.path, node));
        break;
      case "scope":
        scopes.push(parseScopeDeclaration(file.path, node));
        break;
      case "inter-agent-contract":
        interAgentContracts.push(parseInterAgentContractDeclaration(file.path, node));
        break;
      case "conflict":
        conflicts.push(parseConflictDeclaration(file.path, node));
        break;
    }
  }

  return {
    path: file.path,
    parsed: file.parsed,
    metadata,
    imports,
    operators,
    checkers,
    scenarios,
    groups,
    invariants,
    codeShapes,
    agents,
    scopes,
    interAgentContracts,
    conflicts,
  };
}

function isPathWithin(candidate: string, directory: string): boolean {
  if (candidate === directory) {
    return true;
  }
  return candidate.startsWith(directory + path.sep);
}

function parseImportDeclaration(filePath: string, node: ListNode): ImportDeclaration {
  if (node.items.length !== 1 || node.items[0]?.kind !== "string") {
    throw new SteleError(
      "E0202",
      "Loader Error",
      'Import declarations must be of the form (import "relative/path.stele").',
      node.span,
      `Found ${node.items.length} import argument(s) in ${filePath}.`,
      "Use a single string literal path relative to the importing file.",
    );
  }

  const value = node.items[0].value;
  const resolvedPath = path.resolve(path.dirname(filePath), value);

  const contractDir = path.dirname(filePath);
  const projectRoot = path.resolve(contractDir, "..");

  if (!isPathWithin(resolvedPath, contractDir) && !isPathWithin(resolvedPath, projectRoot)) {
    throw new SteleError(
      "E0204",
      "Loader Error",
      'Import path escapes the contract directory and project root.',
      node.span,
      `Import "${value}" resolves to "${resolvedPath}", which is outside of "${contractDir}".`,
      "Only import files within the same contract directory or project root.",
    );
  }

  return {
    kind: "import",
    filePath,
    node,
    span: node.span,
    value,
    resolvedPath,
  };
}

function parseOperatorDeclaration(filePath: string, node: ListNode): OperatorDeclaration {
  const idNode = node.items[0];

  if (idNode?.kind !== "identifier") {
    throw validationError(
      "E0303",
      "Operator declarations must start with an identifier.",
      node.span,
      "The first operator item should be the operator name.",
      'Use a form like (operator project-op ...).',
    );
  }

  return {
    kind: "operator",
    filePath,
    node,
    span: node.span,
    id: idNode.value,
  };
}

function parseCheckerDeclaration(filePath: string, node: ListNode): CheckerDeclaration {
  const idNode = node.items[0];

  if (idNode?.kind !== "identifier") {
    throw validationError(
      "E0303",
      "Checker declarations must start with an identifier.",
      node.span,
      "The first checker item should be the checker id.",
      'Use a form like (checker balance_checker ...).',
    );
  }

  return {
    kind: "checker",
    filePath,
    node,
    span: node.span,
    id: idNode.value,
  };
}

function parseGroupDeclaration(filePath: string, node: ListNode): GroupDeclaration {
  const idNode = node.items[0];

  if (idNode?.kind !== "identifier") {
    throw validationError(
      "E0304",
      "Group declarations must start with an identifier.",
      node.span,
      "The first group item should be the group id.",
      'Use a form like (group account-rules ...).',
    );
  }

  let description: string | undefined;
  const invariants: Array<ReturnType<typeof parseInvariantDeclaration>> = [];

  for (const child of node.items.slice(1)) {
    if (child.kind !== "list") {
      throw validationError(
        "E0304",
        `Unsupported group item inside "${idNode.value}".`,
        child.span,
        "Groups can contain an optional description and nested invariant declarations.",
        "Replace this item with (description ...) or (invariant ...).",
      );
    }

    if (child.head === "description") {
      if (description !== undefined) {
        throw validationError(
          "E0304",
          `Group "${idNode.value}" may declare description only once.`,
          child.span,
          "This group already has a description field.",
          "Keep a single description field inside the group.",
        );
      }

      description = readSingleString(child, `Group "${idNode.value}" description`);
      continue;
    }

    if (child.head !== "invariant") {
      throw validationError(
        "E0304",
        `Unsupported group item "${child.head}" inside "${idNode.value}".`,
        child.span,
        "Groups may only contain description and invariant forms in v0.1.",
        "Move this declaration to the file top level or remove it from the group.",
      );
    }

    invariants.push(parseInvariantDeclaration(filePath, child, idNode.value));
  }

  return {
    kind: "group",
    filePath,
    node,
    span: node.span,
    id: idNode.value,
    description,
    invariants,
  };
}

function readSingleString(node: ListNode, label: string): string {
  const item = readSingleExpression(node, label, "E0304");

  if (item.kind !== "string") {
    throw validationError(
      "E0304",
      `${label} must be a string literal.`,
      item.span,
      `Found ${describeNode(item)} instead of a string literal.`,
      "Wrap the value in double quotes.",
    );
  }

  return item.value;
}

