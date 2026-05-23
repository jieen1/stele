import { sanitizeIdentifier, type AstNode, type ListNode } from "@stele/core";
import { SteleError } from "@stele/core";
import {
  type TranslationContext,
  PYTHON_RESERVED_WORDS,
} from "./types.js";

// Alias for backward compatibility. Delegates to @stele/core sanitizeIdentifier.
export const sanitizePythonIdentifier = sanitizeIdentifier;

// ---------------------------------------------------------------------------
// Translation context
// ---------------------------------------------------------------------------

export function createTranslationContext(
  bindings = new Map<string, string>(),
  usedNames = new Set<string>(),
  rootContextName = "stele_context",
): TranslationContext {
  return {
    bindings,
    rootContextName,
    usedNames,
    bind(identifier: string) {
      const name = allocateUniquePythonName(sanitizePythonIdentifier(identifier, "item"), usedNames);
      const nextBindings = new Map(bindings);
      const nextUsedNames = new Set(usedNames);
      nextBindings.set(identifier, name);
      nextUsedNames.add(name);
      return {
        name,
        context: createTranslationContext(nextBindings, nextUsedNames, rootContextName),
      };
    },
    resolve(identifier: string) {
      return bindings.get(identifier);
    },
  };
}

export function allocateUniquePythonName(baseName: string, usedNames: ReadonlySet<string>): string {
  let candidate = baseName;
  let suffix = 2;

  while (usedNames.has(candidate) || PYTHON_RESERVED_WORDS.has(candidate)) {
    candidate = `${baseName}_${suffix}`;
    suffix += 1;
  }

  return candidate;
}

export function toPythonString(value: string): string {
  return JSON.stringify(value);
}

export function isListNode(node: AstNode): node is ListNode {
  return node.kind === "list";
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

export function readPathPart(node: AstNode): string {
  if (node.kind === "identifier") {
    return node.value;
  }

  if (node.kind === "keyword") {
    return `:${node.value}`;
  }

  throw new SteleError(
    "E0603",
    "Backend Error",
    'Path segments must be identifiers or keywords in the Python backend.',
    node.span,
    `Found ${node.kind} in a translated path expression.`,
    "Replace the segment with a symbol-like path part.",
  );
}

// ---------------------------------------------------------------------------
// Checker args encoding
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function encodeCheckerArgs(args: AstNode[], _context: TranslationContext): string {
  if (args.length === 0) {
    return "{}";
  }

  const pairs: string[] = [];

  for (const arg of args) {
    if (arg.kind !== "list" || arg.items.length !== 2 || arg.items[0]?.kind !== "identifier") {
      continue;
    }

    const key = arg.items[0].value;
    const valueNode = arg.items[1];

    if (valueNode?.kind === "number") {
      pairs.push(`${toPythonString(key)}: ${valueNode.raw}`);
    } else if (valueNode?.kind === "string") {
      pairs.push(`${toPythonString(key)}: ${toPythonString(valueNode.value)}`);
    } else if (valueNode?.kind === "identifier") {
      if (valueNode.value === "true") {
        pairs.push(`${toPythonString(key)}: True`);
      } else if (valueNode.value === "false") {
        pairs.push(`${toPythonString(key)}: False`);
      } else if (valueNode.value === "null" || valueNode.value === "none") {
        pairs.push(`${toPythonString(key)}: None`);
      }
    }
  }

  return `{${pairs.join(", ")}}`;
}
