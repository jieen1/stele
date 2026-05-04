import { dirname, resolve } from "node:path";
import type { AstNode, ListNode, SourceSpan } from "../ast/types.js";
import { SteleError } from "../errors/SteleError.js";
import type { ParsedFile } from "../parser/parser.js";

const TOP_LEVEL_DECLARATIONS = new Set(["metadata", "import", "operator", "checker", "group", "invariant"]);
const ALLOWED_INVARIANT_FIELDS = new Set([
  "severity",
  "description",
  "assert",
  "uses-checker",
  "category",
  "tags",
  "when",
  "tolerance",
  "depends-on",
  "rationale",
  "since",
  "applies-to",
]);

export type LoadedContractFile = {
  path: string;
  parsed: ParsedFile;
};

export type MetadataDeclaration = {
  kind: "metadata";
  filePath: string;
  node: ListNode;
  span: SourceSpan;
  fields: AstNode[];
};

export type ImportDeclaration = {
  kind: "import";
  filePath: string;
  node: ListNode;
  span: SourceSpan;
  value: string;
  resolvedPath: string;
};

export type OperatorDeclaration = {
  kind: "operator";
  filePath: string;
  node: ListNode;
  span: SourceSpan;
  id: string;
};

export type CheckerDeclaration = {
  kind: "checker";
  filePath: string;
  node: ListNode;
  span: SourceSpan;
  id: string;
};

export type CheckerUse = {
  checkerId: string;
  span: SourceSpan;
  args: AstNode[];
  node: ListNode;
};

export type InvariantDependency = {
  id: string;
  span: SourceSpan;
};

export type InvariantSingleValueFieldName = "category" | "tolerance" | "rationale" | "since" | "applies-to";

export type InvariantSingleValueField = {
  kind: "field";
  name: InvariantSingleValueFieldName;
  node: ListNode;
  span: SourceSpan;
  valueNode: AstNode;
};

export type InvariantMultiValueField = {
  kind: "field";
  name: "tags";
  node: ListNode;
  span: SourceSpan;
  valueNodes: AstNode[];
};

export type InvariantDeclaration = {
  kind: "invariant";
  filePath: string;
  node: ListNode;
  span: SourceSpan;
  id: string;
  groupId?: string;
  severity: string;
  description: string;
  assertExpression?: AstNode;
  usesChecker?: CheckerUse;
  whenExpression?: AstNode;
  dependsOn: InvariantDependency[];
  category?: InvariantSingleValueField;
  tags?: InvariantMultiValueField;
  tolerance?: InvariantSingleValueField;
  rationale?: InvariantSingleValueField;
  since?: InvariantSingleValueField;
  appliesTo?: InvariantSingleValueField;
};

export type GroupDeclaration = {
  kind: "group";
  filePath: string;
  node: ListNode;
  span: SourceSpan;
  id: string;
  description?: string;
  invariants: InvariantDeclaration[];
};

export type ContractFile = {
  path: string;
  parsed: ParsedFile;
  metadata?: MetadataDeclaration;
  imports: ImportDeclaration[];
  operators: OperatorDeclaration[];
  checkers: CheckerDeclaration[];
  groups: GroupDeclaration[];
  invariants: InvariantDeclaration[];
};

export type Contract = {
  rootPath: string;
  files: ContractFile[];
  metadata: MetadataDeclaration[];
  imports: ImportDeclaration[];
  operators: OperatorDeclaration[];
  checkers: CheckerDeclaration[];
  groups: GroupDeclaration[];
  invariants: InvariantDeclaration[];
};

export function buildContract(rootPath: string, files: LoadedContractFile[]): Contract {
  const contractFiles = files.map((file) => parseContractFile(file));

  return {
    rootPath,
    files: contractFiles,
    metadata: contractFiles.flatMap((file) => (file.metadata === undefined ? [] : [file.metadata])),
    imports: contractFiles.flatMap((file) => file.imports),
    operators: contractFiles.flatMap((file) => file.operators),
    checkers: contractFiles.flatMap((file) => file.checkers),
    groups: contractFiles.flatMap((file) => file.groups),
    invariants: contractFiles.flatMap((file) => file.invariants),
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
  const groups: GroupDeclaration[] = [];
  const invariants: InvariantDeclaration[] = [];

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
      case "group": {
        const group = parseGroupDeclaration(file.path, node);
        groups.push(group);
        invariants.push(...group.invariants);
        break;
      }
      case "invariant":
        invariants.push(parseInvariantDeclaration(file.path, node));
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
    groups,
    invariants,
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

  return {
    kind: "import",
    filePath,
    node,
    span: node.span,
    value,
    resolvedPath: resolve(dirname(filePath), value),
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
  const invariants: InvariantDeclaration[] = [];

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

function parseInvariantDeclaration(filePath: string, node: ListNode, groupId?: string): InvariantDeclaration {
  const idNode = node.items[0];

  if (idNode?.kind !== "identifier") {
    throw validationError(
      "E0305",
      "Invariant declarations must start with an identifier.",
      node.span,
      "The first invariant item should be the invariant id.",
      'Use a form like (invariant ACCT_001 ...).',
    );
  }

  let severity: string | undefined;
  let description: string | undefined;
  let assertExpression: AstNode | undefined;
  let usesChecker: CheckerUse | undefined;
  let whenExpression: AstNode | undefined;
  let dependsOn: InvariantDependency[] = [];
  let category: InvariantSingleValueField | undefined;
  let tags: InvariantMultiValueField | undefined;
  let tolerance: InvariantSingleValueField | undefined;
  let rationale: InvariantSingleValueField | undefined;
  let since: InvariantSingleValueField | undefined;
  let appliesTo: InvariantSingleValueField | undefined;

  for (const field of node.items.slice(1)) {
    if (field.kind !== "list") {
      throw validationError(
        "E0305",
        `Invariant "${idNode.value}" contains an unsupported field entry.`,
        field.span,
        "Invariant fields must be nested list forms such as (severity high) or (assert ...).",
        "Wrap this field in a supported list declaration.",
      );
    }

    if (!ALLOWED_INVARIANT_FIELDS.has(field.head)) {
      throw validationError(
        "E0305",
        `Invariant "${idNode.value}" has an unknown field "${field.head}".`,
        field.span,
        `Supported invariant fields are: ${Array.from(ALLOWED_INVARIANT_FIELDS).join(", ")}.`,
        "Rename or remove this field.",
      );
    }

    switch (field.head) {
      case "severity":
        ensureFieldUnset(severity, field, `Invariant "${idNode.value}" severity`);
        severity = readSingleText(field, `Invariant "${idNode.value}" severity`);
        break;
      case "description":
        ensureFieldUnset(description, field, `Invariant "${idNode.value}" description`);
        description = readSingleString(field, `Invariant "${idNode.value}" description`);
        break;
      case "assert":
        ensureFieldUnset(assertExpression, field, `Invariant "${idNode.value}" assert`);
        assertExpression = readSingleExpression(field, `Invariant "${idNode.value}" assert`);
        break;
      case "uses-checker": {
        ensureFieldUnset(usesChecker, field, `Invariant "${idNode.value}" uses-checker`);
        const checkerIdNode = field.items[0];

        if (checkerIdNode?.kind !== "identifier") {
          throw validationError(
            "E0305",
            `Invariant "${idNode.value}" must reference a checker id.`,
            field.span,
            "uses-checker expects an identifier as its first argument.",
            'Use a form like (uses-checker checker_id).',
          );
        }

        usesChecker = {
          checkerId: checkerIdNode.value,
          span: checkerIdNode.span,
          args: field.items.slice(1),
          node: field,
        };
        break;
      }
      case "when":
        ensureFieldUnset(whenExpression, field, `Invariant "${idNode.value}" when`);
        whenExpression = readSingleExpression(field, `Invariant "${idNode.value}" when`);
        break;
      case "depends-on":
        ensureFieldUnset(dependsOn.length === 0 ? undefined : dependsOn, field, `Invariant "${idNode.value}" depends-on`);
        dependsOn = field.items.map((item) => {
          if (item.kind !== "identifier") {
            throw validationError(
              "E0305",
              `Invariant "${idNode.value}" has an invalid dependency entry.`,
              item.span,
              "depends-on expects invariant ids as identifiers.",
              'Use a form like (depends-on ACCT_001 ACCT_002).',
            );
          }

          return { id: item.value, span: item.span };
        });
        break;
      case "category":
        ensureFieldUnset(category, field, `Invariant "${idNode.value}" category`);
        category = readSingleValueField(field, "category");
        break;
      case "tags":
        ensureFieldUnset(tags, field, `Invariant "${idNode.value}" tags`);
        tags = readMultiValueField(field, "tags");
        break;
      case "tolerance":
        ensureFieldUnset(tolerance, field, `Invariant "${idNode.value}" tolerance`);
        tolerance = readSingleValueField(field, "tolerance");
        break;
      case "rationale":
        ensureFieldUnset(rationale, field, `Invariant "${idNode.value}" rationale`);
        rationale = readSingleValueField(field, "rationale");
        break;
      case "since":
        ensureFieldUnset(since, field, `Invariant "${idNode.value}" since`);
        since = readSingleValueField(field, "since");
        break;
      case "applies-to":
        ensureFieldUnset(appliesTo, field, `Invariant "${idNode.value}" applies-to`);
        appliesTo = readSingleValueField(field, "applies-to");
        break;
    }
  }

  if (severity === undefined) {
    throw validationError(
      "E0305",
      `Invariant "${idNode.value}" is missing a severity field.`,
      node.span,
      "Every invariant must declare a severity.",
      "Add a field such as (severity high).",
    );
  }

  if (description === undefined) {
    throw validationError(
      "E0305",
      `Invariant "${idNode.value}" is missing a description field.`,
      node.span,
      "Every invariant must describe what it protects.",
      'Add a field such as (description "Explain the rule").',
    );
  }

  if ((assertExpression === undefined) === (usesChecker === undefined)) {
    throw validationError(
      "E0305",
      `Invariant "${idNode.value}" must declare exactly one of assert or uses-checker.`,
      node.span,
      "Invariant bodies need one executable rule source.",
      "Keep either (assert ...) or (uses-checker ...), but not both.",
    );
  }

  return {
    kind: "invariant",
    filePath,
    node,
    span: node.span,
    id: idNode.value,
    groupId,
    severity,
    description,
    assertExpression,
    usesChecker,
    whenExpression,
    dependsOn,
    category,
    tags,
    tolerance,
    rationale,
    since,
    appliesTo,
  };
}

function readSingleString(node: ListNode, label: string): string {
  const item = readSingleExpression(node, label);

  if (item.kind !== "string") {
    throw validationError(
      "E0305",
      `${label} must be a string literal.`,
      item.span,
      `Found ${describeNode(item)} instead of a string literal.`,
      "Wrap the value in double quotes.",
    );
  }

  return item.value;
}

function readSingleText(node: ListNode, label: string): string {
  const item = readSingleExpression(node, label);

  if (item.kind !== "identifier" && item.kind !== "string") {
    throw validationError(
      "E0305",
      `${label} must be an identifier or string literal.`,
      item.span,
      `Found ${describeNode(item)} instead.`,
      "Use a plain identifier like high or a quoted string if needed.",
    );
  }

  return item.value;
}

function readSingleExpression(node: ListNode, label: string): AstNode {
  if (node.items.length !== 1) {
    throw validationError(
      "E0305",
      `${label} expects exactly one value.`,
      node.span,
      `Found ${node.items.length} value(s).`,
      "Keep a single value inside this field.",
    );
  }

  return node.items[0]!;
}

function readSingleValueField(node: ListNode, name: InvariantSingleValueFieldName): InvariantSingleValueField {
  return {
    kind: "field",
    name,
    node,
    span: node.span,
    valueNode: readSingleExpression(node, `Invariant field "${name}"`),
  };
}

function readMultiValueField(node: ListNode, name: "tags"): InvariantMultiValueField {
  if (node.items.length === 0) {
    throw validationError(
      "E0305",
      `Invariant field "${name}" expects at least one value.`,
      node.span,
      "This field was declared without any values.",
      "Provide one or more values for this field.",
    );
  }

  return {
    kind: "field",
    name,
    node,
    span: node.span,
    valueNodes: [...node.items],
  };
}

function ensureFieldUnset(value: unknown, field: ListNode, label: string): void {
  if (value !== undefined) {
    throw validationError(
      "E0305",
      `${label} may only be declared once.`,
      field.span,
      "This field already appeared earlier in the same invariant or group.",
      "Merge the values into one field.",
    );
  }
}

function describeNode(node: AstNode): string {
  if (node.kind === "list") {
    return `list "${node.head}"`;
  }

  return `${node.kind} "${node.value}"`;
}

function validationError(code: string, message: string, span: SourceSpan, detail: string, hint: string): SteleError {
  return new SteleError(code, "Validation Error", message, span, detail, hint);
}
