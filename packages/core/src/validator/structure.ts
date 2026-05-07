import { dirname, resolve } from "node:path";
import type { AstNode, ListNode, SourceSpan } from "../ast/types.js";
import { SteleError } from "../errors/SteleError.js";
import type { ParsedFile } from "../parser/parser.js";

const TOP_LEVEL_DECLARATIONS = new Set([
  "metadata",
  "import",
  "operator",
  "checker",
  "group",
  "invariant",
  "scenario",
  "boundary",
  "class-shape",
  "function-shape",
  "type-policy",
  "file-policy",
]);
const ALLOWED_INVARIANT_FIELDS = new Set([
  "severity",
  "description",
  "assert",
  "uses-checker",
  "uses-scenario",
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

export type ScenarioUse = {
  scenarioId: string;
  span: SourceSpan;
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
  usesScenario?: ScenarioUse;
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

export type ScenarioSandbox = "transactional";

export type ScenarioExecutor = "python-import";

export type ScenarioCall = {
  node: ListNode;
  span: SourceSpan;
  target: string;
  body?: AstNode;
};

export type ScenarioStepDeclaration = {
  kind: "step";
  filePath: string;
  node: ListNode;
  span: SourceSpan;
  id: string;
  call: ScenarioCall;
  capture?: string;
};

export type ScenarioCaptureStateDeclaration = {
  kind: "capture-state";
  filePath: string;
  node: ListNode;
  span: SourceSpan;
  capture: string;
  call: ScenarioCall;
};

export type ScenarioOperation = ScenarioStepDeclaration | ScenarioCaptureStateDeclaration;

export type ScenarioDeclaration = {
  kind: "scenario";
  filePath: string;
  node: ListNode;
  span: SourceSpan;
  id: string;
  sandbox: ScenarioSandbox;
  executor: ScenarioExecutor;
  steps: ScenarioOperation[];
};

export type CodeShapeLang = "python";

export type BoundaryDeclaration = {
  kind: "boundary";
  filePath: string;
  node: ListNode;
  span: SourceSpan;
  id: string;
  lang: CodeShapeLang;
  target: string;
  denyImports: string[];
  denyCalls: string[];
  allowTargets: string[];
};

export type ClassShapeFieldRequirement = {
  name: string;
  type?: string;
  span: SourceSpan;
};

export type ClassShapeDeclaration = {
  kind: "class-shape";
  filePath: string;
  node: ListNode;
  span: SourceSpan;
  id: string;
  lang: CodeShapeLang;
  target: string;
  mustHaveFields: ClassShapeFieldRequirement[];
  mustHaveMethods: string[];
  mustExtend: string[];
};

export type FunctionShapeDeclaration = {
  kind: "function-shape";
  filePath: string;
  node: ListNode;
  span: SourceSpan;
  id: string;
  lang: CodeShapeLang;
  target: string;
  mustHaveCalls: string[];
  mustHaveDecorators: string[];
  mustHaveParameters: string[];
};

export type TypePolicyDeclaration = {
  kind: "type-policy";
  filePath: string;
  node: ListNode;
  span: SourceSpan;
  id: string;
  lang: CodeShapeLang;
  target: string;
  denyTypes: string[];
  requireTypes: string[];
};

export type FilePolicyDeclaration = {
  kind: "file-policy";
  filePath: string;
  node: ListNode;
  span: SourceSpan;
  id: string;
  lang: CodeShapeLang;
  target: string;
  mustContain: string[];
  mustEndWith: string[];
};

export type CodeShapeDeclaration =
  | BoundaryDeclaration
  | ClassShapeDeclaration
  | FunctionShapeDeclaration
  | TypePolicyDeclaration
  | FilePolicyDeclaration;

export type ContractFile = {
  path: string;
  parsed: ParsedFile;
  metadata?: MetadataDeclaration;
  imports: ImportDeclaration[];
  operators: OperatorDeclaration[];
  checkers: CheckerDeclaration[];
  scenarios: ScenarioDeclaration[];
  groups: GroupDeclaration[];
  invariants: InvariantDeclaration[];
  codeShapes: CodeShapeDeclaration[];
};

export type Contract = {
  rootPath: string;
  files: ContractFile[];
  metadata: MetadataDeclaration[];
  imports: ImportDeclaration[];
  operators: OperatorDeclaration[];
  checkers: CheckerDeclaration[];
  scenarios: ScenarioDeclaration[];
  groups: GroupDeclaration[];
  invariants: InvariantDeclaration[];
  codeShapes: CodeShapeDeclaration[];
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
    scenarios: contractFiles.flatMap((file) => file.scenarios),
    groups: contractFiles.flatMap((file) => file.groups),
    invariants: contractFiles.flatMap((file) => file.invariants),
    codeShapes: contractFiles.flatMap((file) => file.codeShapes),
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
  const scenarios: ScenarioDeclaration[] = [];
  const groups: GroupDeclaration[] = [];
  const invariants: InvariantDeclaration[] = [];
  const codeShapes: CodeShapeDeclaration[] = [];

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
  const resolvedPath = resolve(dirname(filePath), value);

  const contractDir = dirname(filePath);
  const projectRoot = resolve(contractDir, "..");

  if (!resolvedPath.startsWith(contractDir) && !resolvedPath.startsWith(projectRoot)) {
    throw new SteleError(
      "E0202",
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

function parseCodeShapeDeclaration(filePath: string, node: ListNode): CodeShapeDeclaration {
  switch (node.head) {
    case "boundary":
      return parseBoundaryDeclaration(filePath, node);
    case "class-shape":
      return parseClassShapeDeclaration(filePath, node);
    case "function-shape":
      return parseFunctionShapeDeclaration(filePath, node);
    case "type-policy":
      return parseTypePolicyDeclaration(filePath, node);
    case "file-policy":
      return parseFilePolicyDeclaration(filePath, node);
  }

  throw validationError(
    "E0318",
    `Unknown code-shape declaration "${node.head}".`,
    node.span,
    "Supported code-shape declarations are boundary, class-shape, function-shape, type-policy, and file-policy.",
    "Rename or remove this declaration.",
  );
}

function parseBoundaryDeclaration(filePath: string, node: ListNode): BoundaryDeclaration {
  const { id, lang, target, fields } = parseCodeShapeHeader(node, "boundary");

  const denyImports: string[] = [];
  const denyCalls: string[] = [];
  const allowTargets: string[] = [];

  for (const field of fields) {
    switch (field.head) {
      case "deny-import":
        denyImports.push(...readCodeShapeStringList(field, `Boundary "${id}" deny-import`));
        break;
      case "deny-call":
        denyCalls.push(...readCodeShapeStringList(field, `Boundary "${id}" deny-call`));
        break;
      case "allow-target":
        allowTargets.push(...readCodeShapeStringList(field, `Boundary "${id}" allow-target`));
        break;
      default:
        throw unknownCodeShapeFieldError(
          "Boundary",
          id,
          field,
          "lang, target, deny-import, deny-call, allow-target",
        );
    }
  }

  return {
    kind: "boundary",
    filePath,
    node,
    span: node.span,
    id,
    lang,
    target,
    denyImports,
    denyCalls,
    allowTargets,
  };
}

function parseClassShapeDeclaration(filePath: string, node: ListNode): ClassShapeDeclaration {
  const { id, lang, target, fields } = parseCodeShapeHeader(node, "class-shape");

  const mustHaveFields: ClassShapeFieldRequirement[] = [];
  const mustHaveMethods: string[] = [];
  const mustExtend: string[] = [];

  for (const field of fields) {
    switch (field.head) {
      case "must-have-field":
        mustHaveFields.push(parseClassShapeFieldRequirement(field, id));
        break;
      case "must-have-method":
        mustHaveMethods.push(...readCodeShapeNameList(field, `Class shape "${id}" must-have-method`));
        break;
      case "must-extend":
        mustExtend.push(...readCodeShapeNameList(field, `Class shape "${id}" must-extend`));
        break;
      default:
        throw unknownCodeShapeFieldError(
          "Class shape",
          id,
          field,
          "lang, target, must-have-field, must-have-method, must-extend",
        );
    }
  }

  return {
    kind: "class-shape",
    filePath,
    node,
    span: node.span,
    id,
    lang,
    target,
    mustHaveFields,
    mustHaveMethods,
    mustExtend,
  };
}

function parseFunctionShapeDeclaration(filePath: string, node: ListNode): FunctionShapeDeclaration {
  const { id, lang, target, fields } = parseCodeShapeHeader(node, "function-shape");

  const mustHaveCalls: string[] = [];
  const mustHaveDecorators: string[] = [];
  const mustHaveParameters: string[] = [];

  for (const field of fields) {
    switch (field.head) {
      case "must-have-call":
        mustHaveCalls.push(...readCodeShapeNameList(field, `Function shape "${id}" must-have-call`));
        break;
      case "must-have-decorator":
        mustHaveDecorators.push(...readCodeShapeNameList(field, `Function shape "${id}" must-have-decorator`));
        break;
      case "must-have-parameter":
        mustHaveParameters.push(...readCodeShapeNameList(field, `Function shape "${id}" must-have-parameter`));
        break;
      default:
        throw unknownCodeShapeFieldError(
          "Function shape",
          id,
          field,
          "lang, target, must-have-call, must-have-decorator, must-have-parameter",
        );
    }
  }

  return {
    kind: "function-shape",
    filePath,
    node,
    span: node.span,
    id,
    lang,
    target,
    mustHaveCalls,
    mustHaveDecorators,
    mustHaveParameters,
  };
}

function parseTypePolicyDeclaration(filePath: string, node: ListNode): TypePolicyDeclaration {
  const { id, lang, target, fields } = parseCodeShapeHeader(node, "type-policy");

  const denyTypes: string[] = [];
  const requireTypes: string[] = [];

  for (const field of fields) {
    switch (field.head) {
      case "deny-type":
        denyTypes.push(...readCodeShapeStringList(field, `Type policy "${id}" deny-type`));
        break;
      case "require-type":
        requireTypes.push(...readCodeShapeStringList(field, `Type policy "${id}" require-type`));
        break;
      default:
        throw unknownCodeShapeFieldError("Type policy", id, field, "lang, target, deny-type, require-type");
    }
  }

  return {
    kind: "type-policy",
    filePath,
    node,
    span: node.span,
    id,
    lang,
    target,
    denyTypes,
    requireTypes,
  };
}

function parseFilePolicyDeclaration(filePath: string, node: ListNode): FilePolicyDeclaration {
  const { id, lang, target, fields } = parseCodeShapeHeader(node, "file-policy");

  const mustContain: string[] = [];
  const mustEndWith: string[] = [];

  for (const field of fields) {
    switch (field.head) {
      case "must-contain":
        mustContain.push(...readCodeShapeStringList(field, `File policy "${id}" must-contain`));
        break;
      case "must-end-with":
        mustEndWith.push(...readCodeShapeStringList(field, `File policy "${id}" must-end-with`));
        break;
      default:
        throw unknownCodeShapeFieldError("File policy", id, field, "lang, target, must-contain, must-end-with");
    }
  }

  return {
    kind: "file-policy",
    filePath,
    node,
    span: node.span,
    id,
    lang,
    target,
    mustContain,
    mustEndWith,
  };
}

function parseCodeShapeHeader(
  node: ListNode,
  kind: CodeShapeDeclaration["kind"],
): { id: string; lang: CodeShapeLang; target: string; fields: ListNode[] } {
  const idNode = node.items[0];
  const label = codeShapeLabel(kind);

  if (idNode?.kind !== "identifier") {
    throw validationError(
      "E0318",
      `${label} declarations must start with an identifier.`,
      node.span,
      `The first ${label.toLowerCase()} item should be the declaration id.`,
      `Use a form like (${kind} ${exampleCodeShapeId(kind)} ...).`,
    );
  }

  let lang: CodeShapeLang | undefined;
  let target: string | undefined;
  const fields: ListNode[] = [];

  for (const field of node.items.slice(1)) {
    if (field.kind !== "list") {
      throw validationError(
        "E0318",
        `${label} "${idNode.value}" contains an unsupported field entry.`,
        field.span,
        `${label} fields must be nested list forms such as (lang python) or (target "src/**/*.py").`,
        "Wrap this field in a supported list declaration.",
      );
    }

    switch (field.head) {
      case "lang":
        ensureCodeShapeFieldUnset(lang, field, `${label} "${idNode.value}" lang`);
        lang = parseCodeShapeLang(field, label, idNode.value);
        break;
      case "target":
        ensureCodeShapeFieldUnset(target, field, `${label} "${idNode.value}" target`);
        target = parseCodeShapeTarget(field, label, idNode.value);
        break;
      default:
        fields.push(field);
        break;
    }
  }

  if (lang === undefined) {
    throw validationError(
      "E0318",
      `${label} "${idNode.value}" is missing a lang field.`,
      node.span,
      "Every code-shape declaration must declare exactly one language.",
      "Add (lang python). Python is the only supported language right now.",
    );
  }

  if (target === undefined) {
    throw validationError(
      "E0318",
      `${label} "${idNode.value}" is missing a target field.`,
      node.span,
      "Every code-shape declaration must declare exactly one target selector.",
      'Add a field such as (target "src/**/*.py") or another Python selector string.',
    );
  }

  return {
    id: idNode.value,
    lang,
    target,
    fields,
  };
}

function parseCodeShapeLang(node: ListNode, label: string, id: string): CodeShapeLang {
  const langNode = readSingleExpression(node, `${label} "${id}" lang`);

  if (langNode.kind !== "identifier") {
    throw validationError(
      "E0318",
      `${label} "${id}" lang must be an identifier.`,
      langNode.span,
      `Found ${describeNode(langNode)} instead.`,
      "Use (lang python).",
    );
  }

  if (langNode.value !== "python") {
    throw validationError(
      "E0318",
      `${label} "${id}" lang "${langNode.value}" is not supported.`,
      langNode.span,
      "Code-shape declarations are Python-only in this version.",
      "Change the declaration to (lang python).",
    );
  }

  return "python";
}

function parseCodeShapeTarget(node: ListNode, label: string, id: string): string {
  const targetNode = readSingleExpression(node, `${label} "${id}" target`);

  if (targetNode.kind !== "string") {
    throw validationError(
      "E0318",
      `${label} "${id}" target must be a string literal.`,
      targetNode.span,
      `Found ${describeNode(targetNode)} instead of a string literal target.`,
      'Use a form like (target "src/**/*.py").',
    );
  }

  return targetNode.value;
}

function parseClassShapeFieldRequirement(node: ListNode, id: string): ClassShapeFieldRequirement {
  if (node.items.length === 0) {
    throw validationError(
      "E0318",
      `Class shape "${id}" must-have-field expects a field name.`,
      node.span,
      "A must-have-field entry needs a field name and may optionally include a quoted type.",
      'Use (must-have-field field_name) or (must-have-field field_name "Type").',
    );
  }

  if (node.items.length > 2) {
    throw validationError(
      "E0318",
      `Class shape "${id}" must-have-field accepts only a name and an optional type.`,
      node.span,
      `Found ${node.items.length} value(s).`,
      'Keep the form to (must-have-field field_name) or (must-have-field field_name "Type").',
    );
  }

  const nameNode = node.items[0]!;

  if (nameNode.kind !== "identifier" && nameNode.kind !== "string") {
    throw validationError(
      "E0318",
      `Class shape "${id}" must-have-field name must be an identifier or string literal.`,
      nameNode.span,
      `Found ${describeNode(nameNode)} instead.`,
      'Use (must-have-field field_name) or (must-have-field "field_name").',
    );
  }

  const typeNode = node.items[1];

  if (typeNode !== undefined && typeNode.kind !== "string") {
    throw validationError(
      "E0318",
      `Class shape "${id}" must-have-field type must be a string literal.`,
      typeNode.span,
      `Found ${describeNode(typeNode)} instead.`,
      'Use a quoted type such as (must-have-field field_name "UUID").',
    );
  }

  return {
    name: nameNode.value,
    type: typeNode?.value,
    span: node.span,
  };
}

function readCodeShapeStringList(node: ListNode, label: string): string[] {
  if (node.items.length === 0) {
    throw validationError(
      "E0318",
      `${label} expects at least one string literal.`,
      node.span,
      "This field was declared without any values.",
      "Provide one or more quoted string values inside this field.",
    );
  }

  return node.items.map((item) => {
    if (item.kind !== "string") {
      throw validationError(
        "E0318",
        `${label} values must be string literals.`,
        item.span,
        `Found ${describeNode(item)} instead.`,
        "Wrap each value in double quotes.",
      );
    }

    return item.value;
  });
}

function readCodeShapeNameList(node: ListNode, label: string): string[] {
  if (node.items.length === 0) {
    throw validationError(
      "E0318",
      `${label} expects at least one name.`,
      node.span,
      "This field was declared without any values.",
      "Provide one or more identifiers or quoted names inside this field.",
    );
  }

  return node.items.map((item) => {
    if (item.kind !== "identifier" && item.kind !== "string") {
      throw validationError(
        "E0318",
        `${label} values must be identifiers or string literals.`,
        item.span,
        `Found ${describeNode(item)} instead.`,
        "Use a plain identifier or wrap the name in double quotes.",
      );
    }

    return item.value;
  });
}

function ensureCodeShapeFieldUnset(value: unknown, field: ListNode, label: string): void {
  if (value !== undefined) {
    throw validationError(
      "E0318",
      `${label} may only be declared once.`,
      field.span,
      "This field already appeared earlier in the same code-shape declaration.",
      "Keep a single copy of this field.",
    );
  }
}

function unknownCodeShapeFieldError(label: string, id: string, field: ListNode, supportedFields: string): SteleError {
  return validationError(
    "E0318",
    `${label} "${id}" has an unknown field "${field.head}".`,
    field.span,
    `Supported ${label.toLowerCase()} fields are: ${supportedFields}.`,
    "Rename or remove this field.",
  );
}

function codeShapeLabel(kind: CodeShapeDeclaration["kind"]): string {
  switch (kind) {
    case "boundary":
      return "Boundary";
    case "class-shape":
      return "Class shape";
    case "function-shape":
      return "Function shape";
    case "type-policy":
      return "Type policy";
    case "file-policy":
      return "File policy";
  }
}

function exampleCodeShapeId(kind: CodeShapeDeclaration["kind"]): string {
  switch (kind) {
    case "boundary":
      return "python_boundary";
    case "class-shape":
      return "python_class_shape";
    case "function-shape":
      return "python_function_shape";
    case "type-policy":
      return "python_type_policy";
    case "file-policy":
      return "python_file_policy";
  }
}

function parseScenarioDeclaration(filePath: string, node: ListNode): ScenarioDeclaration {
  const idNode = node.items[0];

  if (idNode?.kind !== "identifier") {
    throw validationError(
      "E0317",
      "Scenario declarations must start with an identifier.",
      node.span,
      "The first scenario item should be the scenario id.",
      'Use a form like (scenario fund-pnl-flow ...).',
    );
  }

  let sandbox: ScenarioSandbox | undefined;
  let executor: ScenarioExecutor | undefined;
  const steps: ScenarioOperation[] = [];

  for (const field of node.items.slice(1)) {
    if (field.kind !== "list") {
      throw validationError(
        "E0317",
        `Scenario "${idNode.value}" contains an unsupported field entry.`,
        field.span,
        "Scenario fields must be nested list forms such as (sandbox transactional) or (step ...).",
        "Wrap this field in a supported list declaration.",
      );
    }

    switch (field.head) {
      case "sandbox":
        ensureFieldUnset(sandbox, field, `Scenario "${idNode.value}" sandbox`);
        sandbox = parseScenarioSandbox(field, idNode.value);
        break;
      case "executor":
        ensureFieldUnset(executor, field, `Scenario "${idNode.value}" executor`);
        executor = parseScenarioExecutor(field, idNode.value);
        break;
      case "step":
        steps.push(parseScenarioStep(filePath, field, idNode.value));
        break;
      case "capture-state":
        steps.push(parseScenarioCaptureState(filePath, field, idNode.value));
        break;
      default:
        throw validationError(
          "E0317",
          `Scenario "${idNode.value}" has an unknown field "${field.head}".`,
          field.span,
          'Supported scenario fields are: sandbox, executor, step, capture-state.',
          "Rename or remove this field.",
        );
    }
  }

  if (sandbox === undefined) {
    throw validationError(
      "E0317",
      `Scenario "${idNode.value}" is missing a sandbox field.`,
      node.span,
      "Scenarios must declare which sandbox mode they require.",
      "Add a field such as (sandbox transactional).",
    );
  }

  if (executor === undefined) {
    throw validationError(
      "E0317",
      `Scenario "${idNode.value}" is missing an executor field.`,
      node.span,
      "Scenarios must declare which executor will run their calls.",
      "Add a field such as (executor python-import).",
    );
  }

  if (steps.length === 0) {
    throw validationError(
      "E0317",
      `Scenario "${idNode.value}" must declare at least one step.`,
      node.span,
      "A scenario without steps cannot produce captured state for invariants.",
      "Add one or more (step ...) or (capture-state ...) forms.",
    );
  }

  return {
    kind: "scenario",
    filePath,
    node,
    span: node.span,
    id: idNode.value,
    sandbox,
    executor,
    steps,
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
  let usesScenario: ScenarioUse | undefined;
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
      case "uses-scenario": {
        ensureFieldUnset(usesScenario, field, `Invariant "${idNode.value}" uses-scenario`);
        const scenarioIdNode = field.items[0];

        if (scenarioIdNode?.kind !== "identifier") {
          throw validationError(
            "E0305",
            `Invariant "${idNode.value}" must reference a scenario id.`,
            field.span,
            "uses-scenario expects an identifier as its first argument.",
            'Use a form like (uses-scenario fund-pnl-flow).',
          );
        }

        if (field.items.length !== 1) {
          throw validationError(
            "E0305",
            `Invariant "${idNode.value}" uses-scenario expects exactly one scenario id.`,
            field.span,
            `Found ${field.items.length} value(s).`,
            "Keep a single scenario id inside uses-scenario.",
          );
        }

        usesScenario = {
          scenarioId: scenarioIdNode.value,
          span: scenarioIdNode.span,
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
    usesScenario,
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

function parseScenarioSandbox(node: ListNode, scenarioId: string): ScenarioSandbox {
  const sandboxNode = readSingleExpression(node, `Scenario "${scenarioId}" sandbox`);

  if (sandboxNode.kind !== "identifier") {
    throw validationError(
      "E0317",
      `Scenario "${scenarioId}" sandbox must be an identifier.`,
      sandboxNode.span,
      `Found ${describeNode(sandboxNode)} instead.`,
      "Use transactional for the v0.1 sandbox mode.",
    );
  }

  if (sandboxNode.value !== "transactional") {
    throw validationError(
      "E0317",
      `Scenario "${scenarioId}" sandbox "${sandboxNode.value}" is not supported.`,
      sandboxNode.span,
      'The Python vertical slice currently supports only (sandbox transactional).',
      "Change the sandbox to transactional for this version.",
    );
  }

  return sandboxNode.value;
}

function parseScenarioExecutor(node: ListNode, scenarioId: string): ScenarioExecutor {
  const executorNode = readSingleExpression(node, `Scenario "${scenarioId}" executor`);

  if (executorNode.kind !== "identifier") {
    throw validationError(
      "E0317",
      `Scenario "${scenarioId}" executor must be an identifier.`,
      executorNode.span,
      `Found ${describeNode(executorNode)} instead.`,
      "Use python-import for the v0.1 executor.",
    );
  }

  if (executorNode.value !== "python-import") {
    throw validationError(
      "E0317",
      `Scenario "${scenarioId}" executor "${executorNode.value}" is not supported.`,
      executorNode.span,
      "The Python vertical slice currently supports only the python-import executor.",
      "Change the executor to python-import for this version.",
    );
  }

  return executorNode.value;
}

function parseScenarioStep(filePath: string, node: ListNode, scenarioId: string): ScenarioStepDeclaration {
  const idNode = node.items[0];

  if (idNode?.kind !== "identifier") {
    throw validationError(
      "E0317",
      `Scenario "${scenarioId}" step declarations must start with an identifier.`,
      node.span,
      "The first step item should be the step id.",
      'Use a form like (step setup-fund ...).',
    );
  }

  let call: ScenarioCall | undefined;
  let capture: string | undefined;

  for (const field of node.items.slice(1)) {
    if (field.kind !== "list") {
      throw validationError(
        "E0317",
        `Scenario step "${idNode.value}" contains an unsupported field entry.`,
        field.span,
        "Scenario steps may contain call and capture forms.",
        "Replace this item with (call ...) or (capture ...).",
      );
    }

    if (field.head === "call") {
      ensureFieldUnset(call, field, `Scenario step "${idNode.value}" call`);
      call = parseScenarioCall(field, `Scenario step "${idNode.value}"`);
      continue;
    }

    if (field.head === "capture") {
      if (capture !== undefined) {
        ensureFieldUnset(capture, field, `Scenario step "${idNode.value}" capture`);
      }
      capture = parseScenarioCaptureName(field, `Scenario step "${idNode.value}" capture`);
      continue;
    }

    throw validationError(
      "E0317",
      `Scenario step "${idNode.value}" has an unknown field "${field.head}".`,
      field.span,
      "Scenario steps may contain call and capture forms in v0.1.",
      "Rename or remove this field.",
    );
  }

  if (call === undefined) {
    throw validationError(
      "E0317",
      `Scenario step "${idNode.value}" is missing a call field.`,
      node.span,
      "Each scenario step must describe which function to execute.",
      "Add a field such as (call \"tests.contract_scenarios:create_fund\").",
    );
  }

  return {
    kind: "step",
    filePath,
    node,
    span: node.span,
    id: idNode.value,
    call,
    capture,
  };
}

function parseScenarioCaptureState(filePath: string, node: ListNode, scenarioId: string): ScenarioCaptureStateDeclaration {
  const captureNode = node.items[0];

  if (captureNode?.kind !== "identifier") {
    throw validationError(
      "E0317",
      `Scenario "${scenarioId}" capture-state declarations must start with an identifier.`,
      node.span,
      "The first capture-state item should be the capture id.",
      'Use a form like (capture-state pnl ...).',
    );
  }

  let call: ScenarioCall | undefined;

  for (const field of node.items.slice(1)) {
    if (field.kind !== "list") {
      throw validationError(
        "E0317",
        `Scenario capture-state "${captureNode.value}" contains an unsupported field entry.`,
        field.span,
        "capture-state may only contain a call form in v0.1.",
        "Replace this item with (call ...).",
      );
    }

    if (field.head !== "call") {
      throw validationError(
        "E0317",
        `Scenario capture-state "${captureNode.value}" has an unknown field "${field.head}".`,
        field.span,
        "capture-state may only contain a call form in v0.1.",
        "Rename or remove this field.",
      );
    }

    ensureFieldUnset(call, field, `Scenario capture-state "${captureNode.value}" call`);
    call = parseScenarioCall(field, `Scenario capture-state "${captureNode.value}"`);
  }

  if (call === undefined) {
    throw validationError(
      "E0317",
      `Scenario capture-state "${captureNode.value}" is missing a call field.`,
      node.span,
      "capture-state must invoke a Python function that returns the captured state.",
      "Add a field such as (call \"tests.contract_scenarios:get_pnl\" ...).",
    );
  }

  return {
    kind: "capture-state",
    filePath,
    node,
    span: node.span,
    capture: captureNode.value,
    call,
  };
}

function parseScenarioCall(node: ListNode, label: string): ScenarioCall {
  const targetNode = node.items[0];

  if (targetNode?.kind !== "string") {
    throw validationError(
      "E0317",
      `${label} call target must be a string literal.`,
      targetNode?.span ?? node.span,
      `Found ${targetNode === undefined ? "nothing" : describeNode(targetNode)} instead of a string literal target.`,
      'Use a form like (call "tests.contract_scenarios:create_fund" ...).',
    );
  }

  let body: AstNode | undefined;

  if (!isValidPythonImportTarget(targetNode.value)) {
    throw validationError(
      "E0317",
      `${label} call target must use "module:function" with non-empty parts.`,
      targetNode.span,
      `Found "${targetNode.value}", which cannot be imported by the python-import executor.`,
      'Use a string like "tests.contract_scenarios:create_fund".',
    );
  }

  for (const field of node.items.slice(1)) {
    if (field.kind !== "list" || field.head !== "body") {
      throw validationError(
        "E0317",
        `${label} call has an unsupported field.`,
        field.span,
        "Scenario calls may contain an optional body form after the target string.",
        "Replace this item with (body ...), or remove it.",
      );
    }

    ensureFieldUnset(body, field, `${label} call body`);
    body = readSingleExpression(field, `${label} call body`);
  }

  return {
    node,
    span: node.span,
    target: targetNode.value,
    body,
  };
}

function isValidPythonImportTarget(target: string): boolean {
  const separatorIndex = target.indexOf(":");

  if (separatorIndex <= 0 || separatorIndex !== target.lastIndexOf(":")) {
    return false;
  }

  return separatorIndex < target.length - 1;
}

function parseScenarioCaptureName(node: ListNode, label: string): string {
  const captureNode = readSingleExpression(node, label);

  if (captureNode.kind !== "identifier") {
    throw validationError(
      "E0317",
      `${label} must be an identifier.`,
      captureNode.span,
      `Found ${describeNode(captureNode)} instead.`,
      "Use a simple identifier such as fund or pnl.",
    );
  }

  return captureNode.value;
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
