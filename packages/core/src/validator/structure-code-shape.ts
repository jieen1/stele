import type { AstNode, ListNode } from "../ast/types.js";
import { describeNode, validationError } from "./structure-error.js";
import { readSingleExpression } from "./structure-shared.js";
import type {
  BoundaryDeclaration,
  ClassShapeDeclaration,
  ClassShapeFieldRequirement,
  CodeShapeDeclaration,
  CodeShapeLang,
  FilePolicyDeclaration,
  FunctionShapeDeclaration,
  TypePolicyDeclaration,
} from "./structure-types.js";

export function parseCodeShapeDeclaration(filePath: string, node: ListNode): CodeShapeDeclaration {
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

// -- boundary --

export function parseBoundaryDeclaration(filePath: string, node: ListNode): BoundaryDeclaration {
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

// -- class-shape --

export function parseClassShapeDeclaration(filePath: string, node: ListNode): ClassShapeDeclaration {
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

// -- function-shape --

export function parseFunctionShapeDeclaration(filePath: string, node: ListNode): FunctionShapeDeclaration {
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

// -- type-policy --

export function parseTypePolicyDeclaration(filePath: string, node: ListNode): TypePolicyDeclaration {
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

// -- file-policy --

export function parseFilePolicyDeclaration(filePath: string, node: ListNode): FilePolicyDeclaration {
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

// -- shared code-shape helpers --

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
  const langNode = readSingleExpression(node, `${label} "${id}" lang`, "E0318");

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
  const targetNode = readSingleExpression(node, `${label} "${id}" target`, "E0318");

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

export function parseClassShapeFieldRequirement(node: ListNode, id: string): ClassShapeFieldRequirement {
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

export function readCodeShapeStringList(node: ListNode, label: string): string[] {
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

export function readCodeShapeNameList(node: ListNode, label: string): string[] {
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

function unknownCodeShapeFieldError(label: string, id: string, field: ListNode, supportedFields: string): never {
  throw validationError(
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

