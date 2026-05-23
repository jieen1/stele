import type { ListNode } from "../ast/types.js";
import { validationError } from "./structure-error.js";
import { ensureFieldUnset, readSingleString } from "./structure-shared.js";
import type { ExternAliasDeclaration } from "./structure-types.js";

const CODE_STRUCTURE = "E0360";
const CODE_UNKNOWN_FIELD = "E0361";
const CODE_NO_LANGUAGE = "E0363";

const LANGUAGE_FIELDS = new Set<"typescript" | "python" | "go" | "java" | "rust">([
  "typescript",
  "python",
  "go",
  "java",
  "rust",
]);

type LanguageField = "typescript" | "python" | "go" | "java" | "rust";

/**
 * Parse a `(extern-alias <logical-name> (typescript "<pkg>") (python "<pkg>") ...)`
 * top-level form. The logical name is the cross-language symbol the trace /
 * effect / type-state evaluators reference via `extern:<logical-name>::...`
 * patterns. Each per-language entry binds the logical name to the
 * actually-installed package identifier (npm, pip, go module, maven
 * artefact, crate name).
 *
 * Errors: E0360 (form shape), E0361 (unknown field), E0363 (no language).
 * Duplicate logical-name across files is reported as E0362 by the
 * uniqueness validator.
 */
export function parseExternAliasDeclaration(
  filePath: string,
  node: ListNode,
): ExternAliasDeclaration {
  const idNode = node.items[0];

  if (idNode === undefined || (idNode.kind !== "identifier" && idNode.kind !== "string")) {
    throw validationError(
      CODE_STRUCTURE,
      "Extern-alias declarations must start with a logical-name identifier or string.",
      node.span,
      "The first item of an (extern-alias ...) form is the logical name used in `extern:<name>::...` patterns.",
      'Use a form like (extern-alias stripe (typescript "stripe") (python "stripe")).',
    );
  }

  const logicalName = idNode.value;
  const languages: Partial<Record<LanguageField, string>> = {};
  let description: string | undefined;

  for (const item of node.items.slice(1)) {
    if (item.kind !== "list") {
      throw validationError(
        CODE_STRUCTURE,
        `Extern-alias "${logicalName}" contains an unsupported entry.`,
        item.span,
        "Extern-alias fields must be nested list forms such as (typescript \"<pkg>\") or (description \"...\").",
        "Wrap this entry in a supported list declaration.",
      );
    }

    if (item.head === "description") {
      ensureFieldUnset(
        description,
        "description",
        `Extern-alias "${logicalName}" description`,
        CODE_STRUCTURE,
        item.span,
      );
      description = readSingleString(
        item,
        `Extern-alias "${logicalName}" description`,
        CODE_STRUCTURE,
      );
      continue;
    }

    if (LANGUAGE_FIELDS.has(item.head as LanguageField)) {
      const lang = item.head as LanguageField;
      ensureFieldUnset(
        languages[lang],
        item.head,
        `Extern-alias "${logicalName}" ${item.head}`,
        CODE_STRUCTURE,
        item.span,
      );
      languages[lang] = readSingleString(
        item,
        `Extern-alias "${logicalName}" ${item.head} package`,
        CODE_STRUCTURE,
      );
      continue;
    }

    throw validationError(
      CODE_UNKNOWN_FIELD,
      `Extern-alias "${logicalName}" has an unknown field "${item.head}".`,
      item.span,
      "Supported fields are: description, typescript, python, go, java, rust.",
      "Rename or remove this field.",
    );
  }

  const declaredLanguages = Object.values(languages).filter(
    (v): v is string => typeof v === "string",
  );
  if (declaredLanguages.length === 0) {
    throw validationError(
      CODE_NO_LANGUAGE,
      `Extern-alias "${logicalName}" declares no language bindings.`,
      node.span,
      "At least one of (typescript ...), (python ...), (go ...), (java ...), (rust ...) is required.",
      'Add a binding, e.g. (typescript "stripe").',
    );
  }

  return {
    kind: "extern-alias",
    filePath,
    node,
    span: node.span,
    id: logicalName,
    description,
    typescript: languages.typescript,
    python: languages.python,
    go: languages.go,
    java: languages.java,
    rust: languages.rust,
  };
}
