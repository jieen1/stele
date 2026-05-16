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

// -- Entry point --

export function parseCodeShapeDeclaration(filePath: string, node: ListNode): CodeShapeDeclaration {
  const config = CODE_SHAPE_REGISTRY[node.head as CodeShapeDeclaration["kind"]];

  if (config === undefined) {
    throw validationError(
      "E0318",
      `Unknown code-shape declaration "${node.head}".`,
      node.span,
      "Supported code-shape declarations are boundary, class-shape, function-shape, type-policy, and file-policy.",
      "Rename or remove this declaration.",
    );
  }

  const { id, lang, target } = parseHeader(node, config);
  const collected = collectFields(config, id, node.items.slice(1), filePath);
  const base = { filePath, node, span: node.span, id, lang, target };

  switch (config.kind) {
    case "boundary":
      return {
        ...base,
        kind: "boundary",
        denyImports: (collected.get("deny-import") as string[]) ?? [],
        denyCalls: (collected.get("deny-call") as string[]) ?? [],
        allowTargets: (collected.get("allow-target") as string[]) ?? [],
      };

    case "class-shape":
      return {
        ...base,
        kind: "class-shape",
        mustHaveFields: (collected.get("must-have-field") as ClassShapeFieldRequirement[]) ?? [],
        mustHaveMethods: (collected.get("must-have-method") as string[]) ?? [],
        mustExtend: (collected.get("must-extend") as string[]) ?? [],
      };

    case "function-shape":
      return {
        ...base,
        kind: "function-shape",
        mustHaveCalls: (collected.get("must-have-call") as string[]) ?? [],
        mustHaveDecorators: (collected.get("must-have-decorator") as string[]) ?? [],
        mustHaveParameters: (collected.get("must-have-parameter") as string[]) ?? [],
      };

    case "type-policy":
      return {
        ...base,
        kind: "type-policy",
        denyTypes: (collected.get("deny-type") as string[]) ?? [],
        requireTypes: (collected.get("require-type") as string[]) ?? [],
      };

    case "file-policy":
      return {
        ...base,
        kind: "file-policy",
        mustContain: (collected.get("must-contain") as string[]) ?? [],
        mustEndWith: (collected.get("must-end-with") as string[]) ?? [],
      };
  }
}

// -- Registry --

type FieldReader = (node: ListNode, label: string) => unknown;

interface FieldSpec {
  key: string;
  reader: FieldReader;
}

interface DeclarationConfig {
  kind: CodeShapeDeclaration["kind"];
  label: string;
  exampleId: string;
  fields: FieldSpec[];
}

function readStrings(node: ListNode, label: string): string[] {
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

function readNames(node: ListNode, label: string): string[] {
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

function readFieldRequirements(node: ListNode, label: string): ClassShapeFieldRequirement[] {
  // Extract the declaration id from the full label "Class shape "service_class" must-have-field"
  // Format: "Label "id" field" → extract just "id"
  const match = label.match(/"([^"]+)"/);
  const id = match ? match[1] : label;
  return [parseClassShapeFieldRequirement(node, id)];
}

const CODE_SHAPE_REGISTRY: Record<CodeShapeDeclaration["kind"], DeclarationConfig> = {
  boundary: {
    kind: "boundary",
    label: "Boundary",
    exampleId: "python_boundary",
    fields: [
      { key: "deny-import", reader: readStrings },
      { key: "deny-call", reader: readStrings },
      { key: "allow-target", reader: readStrings },
    ],
  },
  "class-shape": {
    kind: "class-shape",
    label: "Class shape",
    exampleId: "python_class_shape",
    fields: [
      { key: "must-have-field", reader: readFieldRequirements },
      { key: "must-have-method", reader: readNames },
      { key: "must-extend", reader: readNames },
    ],
  },
  "function-shape": {
    kind: "function-shape",
    label: "Function shape",
    exampleId: "python_function_shape",
    fields: [
      { key: "must-have-call", reader: readNames },
      { key: "must-have-decorator", reader: readNames },
      { key: "must-have-parameter", reader: readNames },
    ],
  },
  "type-policy": {
    kind: "type-policy",
    label: "Type policy",
    exampleId: "python_type_policy",
    fields: [
      { key: "deny-type", reader: readStrings },
      { key: "require-type", reader: readStrings },
    ],
  },
  "file-policy": {
    kind: "file-policy",
    label: "File policy",
    exampleId: "python_file_policy",
    fields: [
      { key: "must-contain", reader: readStrings },
      { key: "must-end-with", reader: readStrings },
    ],
  },
};

function supportedFieldsText(config: DeclarationConfig): string {
  const headerFields = ["lang", "target"];
  const fieldKeys = config.fields.map((f) => f.key);
  return [...headerFields, ...fieldKeys].join(", ");
}

// -- Header parsing --

type HeaderResult = { id: string; lang: CodeShapeLang; target: string };

function parseHeader(node: ListNode, config: DeclarationConfig): HeaderResult {
  const idNode = node.items[0];
  const label = config.label;

  if (idNode?.kind !== "identifier") {
    throw validationError(
      "E0318",
      `${label} declarations must start with an identifier.`,
      node.span,
      `The first ${label.toLowerCase()} item should be the declaration id.`,
      `Use a form like (${config.kind} ${config.exampleId} ...).`,
    );
  }

  let lang: CodeShapeLang | undefined;
  let target: string | undefined;

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
        ensureUnset(lang, field, `${label} "${idNode.value}" lang`);
        lang = parseLang(field, label, idNode.value);
        break;
      case "target":
        ensureUnset(target, field, `${label} "${idNode.value}" target`);
        target = parseTarget(field, label, idNode.value);
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

  return { id: idNode.value, lang, target };
}

function parseLang(node: ListNode, label: string, id: string): CodeShapeLang {
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

function parseTarget(node: ListNode, label: string, id: string): string {
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

// -- Field collection --

function collectFields(
  config: DeclarationConfig,
  id: string,
  fields: AstNode[],
  _filePath: string,
): Map<string, unknown> {
  const collected = new Map<string, unknown>();
  const label = `${config.label} "${id}"`;
  const fieldMap = new Map(config.fields.map((f) => [f.key, f]));

  for (const field of fields) {
    if (field.kind !== "list") {
      throw validationError(
        "E0318",
        `${config.label} "${id}" contains an unsupported field entry.`,
        field.span,
        `${config.label} fields must be nested list forms.`,
        "Wrap this field in a supported list declaration.",
      );
    }

    const fieldKey = field.head;

    // Skip lang and target (already consumed in header)
    if (fieldKey === "lang" || fieldKey === "target") {
      continue;
    }

    const spec = fieldMap.get(fieldKey);
    if (spec === undefined) {
      throw validationError(
        "E0318",
        `${config.label} "${id}" has an unknown field "${fieldKey}".`,
        field.span,
        `Supported ${config.label.toLowerCase()} fields are: ${supportedFieldsText(config)}.`,
        "Rename or remove this field.",
      );
    }

    const values = spec.reader(field, `${label} ${fieldKey}`);
    if (!collected.has(fieldKey)) {
      collected.set(fieldKey, values);
    } else {
      const existing = collected.get(fieldKey);
      if (Array.isArray(existing) && Array.isArray(values)) {
        collected.set(fieldKey, [...existing, ...values]);
      }
    }
  }

  return collected;
}

// -- Helpers --

function ensureUnset(value: unknown, field: ListNode, label: string): void {
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

// -- Backward compatibility: re-export individual parsers --

export function parseBoundaryDeclaration(filePath: string, node: ListNode): BoundaryDeclaration {
  return parseCodeShapeDeclaration(filePath, node) as BoundaryDeclaration;
}

export function parseClassShapeDeclaration(filePath: string, node: ListNode): ClassShapeDeclaration {
  return parseCodeShapeDeclaration(filePath, node) as ClassShapeDeclaration;
}

export function parseFunctionShapeDeclaration(filePath: string, node: ListNode): FunctionShapeDeclaration {
  return parseCodeShapeDeclaration(filePath, node) as FunctionShapeDeclaration;
}

export function parseTypePolicyDeclaration(filePath: string, node: ListNode): TypePolicyDeclaration {
  return parseCodeShapeDeclaration(filePath, node) as TypePolicyDeclaration;
}

export function parseFilePolicyDeclaration(filePath: string, node: ListNode): FilePolicyDeclaration {
  return parseCodeShapeDeclaration(filePath, node) as FilePolicyDeclaration;
}

export { readStrings as readCodeShapeStringList, readNames as readCodeShapeNameList };
