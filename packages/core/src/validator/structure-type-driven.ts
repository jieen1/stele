import type { ListNode } from "../ast/types.js";
import type { BrandedIdDeclaration } from "./structure-types.js";
import { validationError } from "./structure-error.js";
import { ensureFieldUnset, readSingleString } from "./structure-shared.js";

const CODE_BRANDED = "E0327";

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
        // Reject an empty/whitespace-only scope: it would otherwise be falsy and
        // silently downgrade the branded-id to advisory (enforced:false), masking
        // a misconfiguration with a green check. Absence is advisory; an explicit
        // empty string is an error.
        if (entityScope.trim().length === 0) {
          throw validationError(
            CODE_BRANDED,
            `Branded-id "${id}" entity-scope must be a non-empty glob.`,
            item.span,
            "An empty entity-scope enforces nothing yet is not advisory.",
            'Provide a real glob (e.g. (entity-scope "src/**/*.ts")) or omit the field to make the branded-id advisory.',
          );
        }
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
