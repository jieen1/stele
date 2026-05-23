import type { ListNode } from "../ast/types.js";
import type {
  BrandedIdDeclaration,
  SmartCtorDeclaration,
} from "./structure-types.js";
import { validationError } from "./structure-error.js";
import { ensureFieldUnset, readSingleString } from "./structure-shared.js";

const CODE_BRANDED = "E0327";
const CODE_SMART = "E0328";

export function parseBrandedIdDeclaration(filePath: string, node: ListNode): BrandedIdDeclaration {
  const idNode = node.items[0];

  if (idNode?.kind !== "identifier" && idNode?.kind !== "string") {
    throw validationError(
      CODE_BRANDED,
      "Branded-id declarations must start with an identifier or string id.",
      node.span,
      "The first item should be the branded type id.",
      'Use a form like (branded-id RuleId ...).',
    );
  }

  const id = idNode.value;
  let target: string | undefined;
  let baseType: string | undefined;
  let pattern: string | undefined;
  let entityScope: string | undefined;

  for (const item of node.items.slice(1)) {
    if (item.kind !== "list") {
      throw validationError(
        CODE_BRANDED,
        `Branded-id "${id}" contains an unsupported field entry.`,
        item.span,
        "Branded-id fields must be nested list forms such as (target ...), (base-type ...), or (pattern ...).",
        "Wrap this field in a supported list declaration.",
      );
    }

    switch (item.head) {
      case "target": {
        ensureFieldUnset(target, "target", `Branded-id "${id}" target`, CODE_BRANDED, item.span);
        target = readSingleString(item, `Branded-id "${id}" target`, CODE_BRANDED);
        break;
      }
      case "base-type": {
        ensureFieldUnset(baseType, "base-type", `Branded-id "${id}" base-type`, CODE_BRANDED, item.span);
        baseType = readSingleString(item, `Branded-id "${id}" base-type`, CODE_BRANDED);
        break;
      }
      case "pattern": {
        ensureFieldUnset(pattern, "pattern", `Branded-id "${id}" pattern`, CODE_BRANDED, item.span);
        pattern = readSingleString(item, `Branded-id "${id}" pattern`, CODE_BRANDED);
        break;
      }
      case "entity-scope": {
        ensureFieldUnset(entityScope, "entity-scope", `Branded-id "${id}" entity-scope`, CODE_BRANDED, item.span);
        entityScope = readSingleString(item, `Branded-id "${id}" entity-scope`, CODE_BRANDED);
        break;
      }
      default:
        throw validationError(
          CODE_BRANDED,
          `Branded-id "${id}" has an unknown field "${item.head}".`,
          item.span,
          "Supported branded-id fields are: target, base-type, pattern, entity-scope.",
          "Rename or remove this field.",
        );
    }
  }

  if (target === undefined) {
    throw validationError(
      CODE_BRANDED,
      `Branded-id "${id}" must declare a (target ...) field.`,
      node.span,
      "The target field is required.",
      'Add (target "path/to/file.ts::TypeName").',
    );
  }

  if (baseType === undefined) {
    throw validationError(
      CODE_BRANDED,
      `Branded-id "${id}" must declare a (base-type ...) field.`,
      node.span,
      "The base-type field is required.",
      'Add (base-type string).',
    );
  }

  return {
    kind: "branded-id",
    filePath,
    node,
    span: node.span,
    id,
    target,
    baseType,
    pattern,
    entityScope,
  };
}

export function parseSmartCtorDeclaration(filePath: string, node: ListNode): SmartCtorDeclaration {
  const idNode = node.items[0];

  if (idNode?.kind !== "identifier" && idNode?.kind !== "string") {
    throw validationError(
      CODE_SMART,
      "Smart-ctor declarations must start with an identifier or string id.",
      node.span,
      "The first item should be the value-object type id.",
      'Use a form like (smart-ctor RuleId ...).',
    );
  }

  const id = idNode.value;
  let constructorName: string | undefined;
  let denyRaw: boolean | undefined;
  let target: string | undefined;

  for (const item of node.items.slice(1)) {
    if (item.kind !== "list") {
      throw validationError(
        CODE_SMART,
        `Smart-ctor "${id}" contains an unsupported field entry.`,
        item.span,
        "Smart-ctor fields must be nested list forms such as (constructor ...), (deny-raw ...), or (target ...).",
        "Wrap this field in a supported list declaration.",
      );
    }

    switch (item.head) {
      case "constructor": {
        ensureFieldUnset(constructorName, "constructor", `Smart-ctor "${id}" constructor`, CODE_SMART, item.span);
        constructorName = readSingleString(item, `Smart-ctor "${id}" constructor`, CODE_SMART);
        break;
      }
      case "deny-raw": {
        ensureFieldUnset(denyRaw, "deny-raw", `Smart-ctor "${id}" deny-raw`, CODE_SMART, item.span);
        const value = readSingleString(item, `Smart-ctor "${id}" deny-raw`, CODE_SMART);
        if (value !== "true" && value !== "false") {
          throw validationError(
            CODE_SMART,
            `Smart-ctor "${id}" deny-raw must be true or false.`,
            item.span,
            `Found value "${value}".`,
            "Use (deny-raw true) or (deny-raw false).",
          );
        }
        denyRaw = value === "true";
        break;
      }
      case "target": {
        ensureFieldUnset(target, "target", `Smart-ctor "${id}" target`, CODE_SMART, item.span);
        target = readSingleString(item, `Smart-ctor "${id}" target`, CODE_SMART);
        break;
      }
      default:
        throw validationError(
          CODE_SMART,
          `Smart-ctor "${id}" has an unknown field "${item.head}".`,
          item.span,
          "Supported smart-ctor fields are: constructor, deny-raw, target.",
          "Rename or remove this field.",
        );
    }
  }

  if (constructorName === undefined) {
    throw validationError(
      CODE_SMART,
      `Smart-ctor "${id}" must declare a (constructor ...) field.`,
      node.span,
      "The constructor field is required.",
      'Add (constructor "parseRuleId").',
    );
  }

  return {
    kind: "smart-ctor",
    filePath,
    node,
    span: node.span,
    id,
    constructorName,
    denyRaw: denyRaw ?? false,
    target,
  };
}
