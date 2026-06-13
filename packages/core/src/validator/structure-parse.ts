import type { ListNode, ParsedFile } from "../ast/types.js";
import { SteleError } from "../errors/SteleError.js";
import { isPathWithin, pathDirname, pathResolve } from "../util/path-utils.js";
import { describeNode, validationError } from "./structure-error.js";
import { parseInvariantDeclaration } from "./structure-invariant.js";
import { parseScenarioDeclaration } from "./structure-scenario.js";
import { parseCodeShapeDeclaration } from "./structure-code-shape.js";
import { parseArchitectureDeclaration } from "./structure-architecture.js";
import { parseCoreNodeDeclaration } from "./structure-core-node.js";
import { parseBrandedIdDeclaration } from "./structure-type-driven.js";
import { parseTracePolicyDeclaration } from "./structure-trace-policy.js";
import {
  parseTypeStateBindingDeclaration,
  parseTypeStateDeclaration,
} from "./structure-type-state.js";
import {
  parseEffectAnnotationDeclaration,
  parseEffectDeclarationsDeclaration,
  parseEffectPolicyDeclaration,
  parseEffectSuppressionDeclaration,
} from "./structure-effect.js";
import { parseExternAliasDeclaration } from "./structure-extern-alias.js";
import { TOP_LEVEL_DECLARATIONS } from "./structure-types.js";
import { readSingleExpression } from "./structure-shared.js";
import type {
  ArchitectureDeclaration,
  BrandedIdDeclaration,
  Contract,
  ContractFile,
  CoreNodeDeclaration,
  EffectAnnotationDeclaration,
  EffectDeclarationsDeclaration,
  EffectPolicyDeclaration,
  EffectSuppressionDeclaration,
  ExternAliasDeclaration,
  GroupDeclaration,
  ImportDeclaration,
  LoadedContractFile,
  MetadataDeclaration,
  OperatorDeclaration,
  CheckerDeclaration,
  TracePolicyDeclaration,
  TypeStateBindingDeclaration,
  TypeStateDeclaration,
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
    architectures: contractFiles.flatMap((file) => file.architectures),
    coreNodes: contractFiles.flatMap((file) => file.coreNodes),
    brandedIds: contractFiles.flatMap((file) => file.brandedIds),
    tracePolicies: contractFiles.flatMap((file) => [...file.tracePolicies]),
    typeStates: contractFiles.flatMap((file) => [...file.typeStates]),
    typeStateBindings: contractFiles.flatMap((file) => [...file.typeStateBindings]),
    effectDeclarations: contractFiles.flatMap((file) => [...file.effectDeclarations]),
    effectAnnotations: contractFiles.flatMap((file) => [...file.effectAnnotations]),
    effectPolicies: contractFiles.flatMap((file) => [...file.effectPolicies]),
    effectSuppressions: contractFiles.flatMap((file) => [...file.effectSuppressions]),
    externAliases: contractFiles.flatMap((file) => [...file.externAliases]),
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
  const architectures: ArchitectureDeclaration[] = [];
  const coreNodes: CoreNodeDeclaration[] = [];
  const brandedIds: BrandedIdDeclaration[] = [];
  const tracePolicies: TracePolicyDeclaration[] = [];
  const typeStates: TypeStateDeclaration[] = [];
  const typeStateBindings: TypeStateBindingDeclaration[] = [];
  const effectDeclarations: EffectDeclarationsDeclaration[] = [];
  const effectAnnotations: EffectAnnotationDeclaration[] = [];
  const effectPolicies: EffectPolicyDeclaration[] = [];
  const effectSuppressions: EffectSuppressionDeclaration[] = [];
  const externAliases: ExternAliasDeclaration[] = [];

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
      case "architecture":
        architectures.push(parseArchitectureDeclaration(file.path, node));
        break;
      case "core-node":
        coreNodes.push(parseCoreNodeDeclaration(file.path, node));
        break;
      case "branded-id":
        brandedIds.push(parseBrandedIdDeclaration(file.path, node));
        break;
      case "trace-policy":
        tracePolicies.push(parseTracePolicyDeclaration(file.path, node));
        break;
      case "type-state":
        typeStates.push(parseTypeStateDeclaration(file.path, node));
        break;
      case "type-state-binding":
        typeStateBindings.push(parseTypeStateBindingDeclaration(file.path, node));
        break;
      case "effect-declarations":
        effectDeclarations.push(parseEffectDeclarationsDeclaration(file.path, node));
        break;
      case "effect-annotation":
        effectAnnotations.push(parseEffectAnnotationDeclaration(file.path, node));
        break;
      case "effect-policy":
        effectPolicies.push(parseEffectPolicyDeclaration(file.path, node));
        break;
      case "effect-suppression":
        effectSuppressions.push(parseEffectSuppressionDeclaration(file.path, node));
        break;
      case "extern-alias":
        externAliases.push(parseExternAliasDeclaration(file.path, node));
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
    architectures,
    coreNodes,
    brandedIds,
    tracePolicies,
    typeStates,
    typeStateBindings,
    effectDeclarations,
    effectAnnotations,
    effectPolicies,
    effectSuppressions,
    externAliases,
  };
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
  const resolvedPath = pathResolve(pathDirname(filePath), value);

  const contractDir = pathDirname(filePath);
  const projectRoot = pathResolve(contractDir, "..");

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

