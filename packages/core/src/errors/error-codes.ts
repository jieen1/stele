/**
 * Central registry of all Stele error codes.
 *
 * Error code ranges by family:
 *   E0001-E0003  — Lexical errors (lexer)
 *   E0101-E0103  — Parser errors (parser)
 *   E0201-E0204  — Loader errors (loadContract)
 *   E0301-E0364  — Validation errors (validator; E0320-E0322 removed with multi-agent forms; E0330-E0339 trace-policy; E0340-E0349 type-state; E0350-E0359 effect system; E0360-E0364 extern-alias)
 *   E0401-E0405  — Manifest errors (manifest)
 *   E0501-E0505  — Generator errors (coordinator)
 *   E0601-E0606  — Python backend errors (translator)
 *
 * New error codes must be added here AND in docs/spec/cdl.md.
 * Do not reuse codes or skip numbers within a family.
 */

export type ErrorCode = {
  /** Short descriptive name for this error. */
  name: string;
  /** Human-readable summary. */
  message: string;
  /** Numeric category id (0=lexical, 1=parser, 2=loader, 3=validation, 4=manifest, 5=generator, 6=backend). */
  category: number;
  /** Source file where this code is used. */
  source: string;
};

export const ErrorCodes: Record<string, ErrorCode> = {
  // --- Lexical errors (E0001-E0003) ---

  E0001: {
    name: "Lexical Error",
    message: "Lexical tokenization error",
    category: 0,
    source: "lexer/lexer.ts",
  },
  E0002: {
    name: "Lexer Error",
    message: "Malformed string or comment",
    category: 0,
    source: "lexer/lexer.ts",
  },
  E0003: {
    name: "Lexer Error",
    message: "Unexpected end of input",
    category: 0,
    source: "lexer/lexer.ts",
  },

  // --- Parser errors (E0101-E0102) ---

  E0101: {
    name: "Parser Error",
    message: "Parse error",
    category: 1,
    source: "parser/parser.ts",
  },
  E0102: {
    name: "Parser Error",
    message: "Unexpected token",
    category: 1,
    source: "parser/parser.ts",
  },
  E0103: {
    name: "Parser Error",
    message: "Unbalanced parentheses or unterminated list",
    category: 1,
    source: "parser/parser.ts",
  },

  // --- Loader errors (E0201-E0204) ---

  E0201: {
    name: "Loader Error",
    message: "Unable to read contract file",
    category: 2,
    source: "loader/load-contract.ts",
  },
  E0202: {
    name: "Loader Error",
    message: "Invalid import declaration syntax",
    category: 2,
    source: "validator/structure-parse.ts",
  },
  E0203: {
    name: "Loader Error",
    message: "Circular import detected",
    category: 2,
    source: "loader/load-contract.ts",
  },
  E0204: {
    name: "Loader Error",
    message: "Import path containment violation",
    category: 2,
    source: "validator/structure-parse.ts",
  },

  // --- Validation errors (E0301-E0319) ---

  E0301: {
    name: "Validation Error",
    message: "Unknown top-level declaration",
    category: 3,
    source: "validator/structure-parse.ts",
  },
  E0302: {
    name: "Validation Error",
    message: "metadata may appear at most once per file",
    category: 3,
    source: "validator/structure-parse.ts",
  },
  E0303: {
    name: "Validation Error",
    message: "Operator/Checker/Group declaration must start with an identifier",
    category: 3,
    source: "validator/structure-parse.ts",
  },
  E0304: {
    name: "Validation Error",
    message: "Unsupported group item or field format error",
    category: 3,
    source: "validator/structure-parse.ts",
  },
  E0305: {
    name: "Validation Error",
    message: "Invariant validation error (unknown/repeated fields, format)",
    category: 3,
    source: "validator/structure-invariant.ts",
  },
  E0306: {
    name: "Validation Error",
    message: "Duplicate invariant id",
    category: 3,
    source: "validator/uniqueness.ts",
  },
  E0307: {
    name: "Validation Error",
    message: "Unknown checker reference (uses-checker)",
    category: 3,
    source: "validator/references.ts",
  },
  E0308: {
    name: "Validation Error",
    message: "Unknown invariant dependency (depends-on)",
    category: 3,
    source: "validator/references.ts",
  },
  E0309: {
    name: "Validation Error",
    message: "Type compatibility / inference error",
    category: 3,
    source: "validator/types.ts",
  },
  E0310: {
    name: "Validation Error",
    message: "Type mismatch / equality operand incompatibility",
    category: 3,
    source: "validator/types.ts",
  },
  E0311: {
    name: "Validation Error",
    message: "Unknown operator",
    category: 3,
    source: "validator/types.ts",
  },
  E0312: {
    name: "Validation Error",
    message: "Duplicate checker id",
    category: 3,
    source: "validator/uniqueness.ts",
  },
  E0313: {
    name: "Validation Error",
    message: "Duplicate operator id",
    category: 3,
    source: "validator/uniqueness.ts",
  },
  E0314: {
    name: "Validation Error",
    message: "Duplicate scenario id",
    category: 3,
    source: "validator/uniqueness.ts",
  },
  E0315: {
    name: "Validation Error",
    message: "Duplicate group id",
    category: 3,
    source: "validator/uniqueness.ts",
  },
  E0316: {
    name: "Validation Error",
    message: "Unknown scenario reference (uses-scenario)",
    category: 3,
    source: "validator/references.ts",
  },
  E0317: {
    name: "Validation Error",
    message: "Scenario declaration error (unknown/repeated fields, format, missing required clauses)",
    category: 3,
    source: "validator/structure-scenario.ts",
  },
  E0318: {
    name: "Validation Error",
    message: "Code shape declaration error (boundary, class-shape, function-shape, type-policy, file-policy)",
    category: 3,
    source: "validator/structure-code-shape.ts",
  },
  E0319: {
    name: "Validation Error",
    message: "Structural invariant violation",
    category: 3,
    source: "validator/structure-invariant.ts",
  },
  E0323: {
    name: "Validation Error",
    message: "Architecture declaration error (modules, layers, allow-dependency, deny-cycles)",
    category: 3,
    source: "validator/structure-architecture.ts",
  },
  E0324: {
    name: "Validation Error",
    message: "Core-node declaration error (target, role, metrics)",
    category: 3,
    source: "validator/structure-core-node.ts",
  },
  E0325: {
    name: "Validation Error",
    message: "Duplicate architecture id",
    category: 3,
    source: "validator/uniqueness.ts",
  },
  E0326: {
    name: "Validation Error",
    message: "Duplicate core-node id",
    category: 3,
    source: "validator/uniqueness.ts",
  },
  E0327: {
    name: "Validation Error",
    message: "Branded-id declaration error (id, target, base-type, pattern, entity-scope)",
    category: 3,
    source: "validator/structure-type-driven.ts",
  },

  // --- Trace-policy validation errors (E0330-E0339) ---

  E0330: {
    name: "Validation Error",
    message: "Trace-policy declaration is missing its id",
    category: 3,
    source: "validator/structure-trace-policy.ts",
  },
  E0331: {
    name: "Validation Error",
    message: "Duplicate trace-policy id",
    category: 3,
    source: "validator/uniqueness.ts",
  },
  E0332: {
    name: "Validation Error",
    message: "Trace-policy is missing the required (target ...) field",
    category: 3,
    source: "validator/structure-trace-policy.ts",
  },
  E0333: {
    name: "Validation Error",
    message: "Trace-policy must declare at least one must-*/deny-* constraint",
    category: 3,
    source: "validator/structure-trace-policy.ts",
  },
  E0334: {
    name: "Validation Error",
    message: "Trace-policy exempt entry is missing (reason \"...\")",
    category: 3,
    source: "validator/structure-trace-policy.ts",
  },
  E0335: {
    name: "Validation Error",
    message: "Trace-policy pattern has invalid syntax",
    category: 3,
    source: "validator/structure-trace-policy.ts",
  },
  E0336: {
    name: "Validation Error",
    message: "Trace-policy severity must be \"error\" or \"warning\"",
    category: 3,
    source: "validator/structure-trace-policy.ts",
  },
  E0337: {
    name: "Validation Error",
    message: "Trace-policy declares the same field twice",
    category: 3,
    source: "validator/structure-trace-policy.ts",
  },
  E0338: {
    name: "Validation Error",
    message: "Trace-policy contains an unknown field",
    category: 3,
    source: "validator/structure-trace-policy.ts",
  },
  E0339: {
    name: "Validation Error",
    message: "Trace-policy fix-hint must reference code (`...`) or a file:line location",
    category: 3,
    source: "validator/structure-trace-policy.ts",
  },

  // --- Type-state validation errors (E0340-E0349) ---

  E0340: {
    name: "Validation Error",
    message: "Type-state declaration is missing its id",
    category: 3,
    source: "validator/structure-type-state.ts",
  },
  E0341: {
    name: "Validation Error",
    message: "Duplicate type-state id or target (one type can only have one state machine)",
    category: 3,
    source: "validator/uniqueness.ts",
  },
  E0342: {
    name: "Validation Error",
    message: "Type-state missing or malformed target (expected path::TypeName or NodeId glob)",
    category: 3,
    source: "validator/structure-type-state.ts",
  },
  E0343: {
    name: "Validation Error",
    message: "Type-state declares an empty (states ...) field",
    category: 3,
    source: "validator/structure-type-state.ts",
  },
  E0344: {
    name: "Validation Error",
    message: "Type-state initial state is not in (states ...)",
    category: 3,
    source: "validator/structure-type-state.ts",
  },
  E0345: {
    name: "Validation Error",
    message: "Type-state terminal contains a non-state",
    category: 3,
    source: "validator/structure-type-state.ts",
  },
  E0346: {
    name: "Validation Error",
    message: "Type-state transition.from or transition.to references a non-state",
    category: 3,
    source: "validator/structure-type-state.ts",
  },
  E0347: {
    name: "Validation Error",
    message: "Type-state (allowed-ops <state> ...) references a non-state",
    category: 3,
    source: "validator/structure-type-state.ts",
  },
  E0348: {
    name: "Validation Error",
    message: "Type-state terminal state appears in (transition (from ...) ...)",
    category: 3,
    source: "validator/structure-type-state.ts",
  },
  E0349: {
    name: "Validation Error",
    message: "Type-state or type-state-binding has an unknown/malformed field",
    category: 3,
    source: "validator/structure-type-state.ts",
  },

  // --- Effect system validation errors (E0350-E0359) ---

  E0350: {
    name: "Validation Error",
    message: "Effect name violates lowercase dot-notation pattern",
    category: 3,
    source: "validator/structure-effect.ts",
  },
  E0351: {
    name: "Validation Error",
    message: "Multiple (effect-declarations ...) blocks in the same file",
    category: 3,
    source: "validator/uniqueness.ts",
  },
  E0352: {
    name: "Validation Error",
    message: "Effect name declared in multiple effect-declarations blocks",
    category: 3,
    source: "validator/structure-effect.ts",
  },
  E0353: {
    name: "Validation Error",
    message: "Effect-declarations entry is missing the effect name",
    category: 3,
    source: "validator/structure-effect.ts",
  },
  E0354: {
    name: "Validation Error",
    message: "Effect-declarations contains an unknown field",
    category: 3,
    source: "validator/structure-effect.ts",
  },
  E0355: {
    name: "Validation Error",
    message: "Effect-annotation is missing the required (target ...) field",
    category: 3,
    source: "validator/structure-effect.ts",
  },
  E0356: {
    name: "Validation Error",
    message: "Effect-annotation is missing the required (annotates ...) field",
    category: 3,
    source: "validator/structure-effect.ts",
  },
  E0357: {
    name: "Validation Error",
    message: "Effect-suppression is missing or has an empty (reason \"...\") field",
    category: 3,
    source: "validator/structure-effect.ts",
  },
  E0358: {
    name: "Validation Error",
    message: "Effect-policy declares both (forbid ...) and (allow-only ...)",
    category: 3,
    source: "validator/structure-effect.ts",
  },
  E0359: {
    name: "Validation Error",
    message: "Effect-policy/annotation/suppression has an unknown field or missing both forbid/allow-only",
    category: 3,
    source: "validator/structure-effect.ts",
  },

  // --- Extern-alias validation errors (E0360-E0364) ---

  E0360: {
    name: "Validation Error",
    message: "Extern-alias form is malformed (missing logical name or invalid field shape)",
    category: 3,
    source: "validator/structure-extern-alias.ts",
  },
  E0361: {
    name: "Validation Error",
    message: "Extern-alias has an unknown field",
    category: 3,
    source: "validator/structure-extern-alias.ts",
  },
  E0362: {
    name: "Validation Error",
    message: "Duplicate extern-alias logical name across the contract",
    category: 3,
    source: "validator/uniqueness.ts",
  },
  E0363: {
    name: "Validation Error",
    message: "Extern-alias declares no language bindings (at least one of typescript/python/go/java/rust is required)",
    category: 3,
    source: "validator/structure-extern-alias.ts",
  },
  E0364: {
    name: "Validation Error",
    message: "Extern-alias language field has an invalid value",
    category: 3,
    source: "validator/structure-extern-alias.ts",
  },

  // --- Manifest errors (E0401-E0405) ---

  E0401: {
    name: "Manifest Error",
    message: "Unable to read manifest file",
    category: 4,
    source: "manifest/manifest.ts",
  },
  E0402: {
    name: "Manifest Error",
    message: "Manifest has invalid JSON or shape",
    category: 4,
    source: "manifest/manifest.ts",
  },
  E0403: {
    name: "Manifest Error",
    message: "Unable to verify protected file",
    category: 4,
    source: "manifest/manifest.ts",
  },
  E0404: {
    name: "Manifest Error",
    message: "Invalid protected path in manifest",
    category: 4,
    source: "manifest/manifest.ts",
  },
  E0405: {
    name: "Manifest Error",
    message: "Manifest path contains dot/dot-dot segments",
    category: 4,
    source: "manifest/manifest.ts",
  },

  // --- Generator errors (E0501-E0505) ---

  E0501: {
    name: "Generator Error",
    message: "Generator coordination error",
    category: 5,
    source: "generator/coordinator.ts",
  },
  E0502: {
    name: "Generator Error",
    message: "Generation output mismatch",
    category: 5,
    source: "generator/coordinator.ts",
  },
  E0503: {
    name: "Generator Error",
    message: "Generation write error",
    category: 5,
    source: "generator/coordinator.ts",
  },
  E0504: {
    name: "Generator Error",
    message: "Generated file verification failure",
    category: 5,
    source: "generator/coordinator.ts",
  },
  E0505: {
    name: "Generator Error",
    message: "Template rendering error",
    category: 5,
    source: "generator/coordinator.ts",
  },

  // --- Python backend errors (E0601-E0606) ---

  E0601: {
    name: "Backend Error",
    message: "Python translation error",
    category: 6,
    source: "backend-python/translator.ts",
  },
  E0602: {
    name: "Backend Error",
    message: "Python template error",
    category: 6,
    source: "backend-python/translator.ts",
  },
  E0603: {
    name: "Backend Error",
    message: "Python runtime error",
    category: 6,
    source: "backend-python/translator.ts",
  },
  E0604: {
    name: "Backend Error",
    message: "Python import error",
    category: 6,
    source: "backend-python/translator.ts",
  },
  E0605: {
    name: "Backend Error",
    message: "Python operator error",
    category: 6,
    source: "backend-python/translator.ts",
  },
  E0606: {
    name: "Backend Error",
    message: "Python path error",
    category: 6,
    source: "backend-python/translator.ts",
  },
};

/**
 * Get the human-readable name for an error code.
 * Returns the code itself if not found in the registry.
 */
export function errorCodeName(code: string): string {
  return ErrorCodes[code]?.name ?? code;
}

/**
 * Get the category number for an error code.
 * Returns -1 if not found.
 */
export function errorCodeCategory(code: string): number {
  return ErrorCodes[code]?.category ?? -1;
}

/**
 * List all registered error codes.
 */
export function listErrorCodes(): string[] {
  return Object.keys(ErrorCodes).sort();
}
