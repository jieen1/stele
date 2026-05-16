/**
 * Central registry of all Stele error codes.
 *
 * Error code ranges by family:
 *   E0001-E0003  — Lexical errors (lexer)
 *   E0101-E0102  — Parser errors (parser)
 *   E0201-E0203  — Loader errors (loadContract)
 *   E0301-E0322  — Validation errors (validator)
 *   E0401-E0404  — Manifest errors (manifest)
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

  // --- Loader errors (E0201-E0204) ---

  E0201: {
    name: "Loader Error",
    message: "Unable to read contract file",
    category: 2,
    source: "loader/loadContract.ts",
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
    source: "loader/loadContract.ts",
  },
  E0204: {
    name: "Loader Error",
    message: "Import path containment violation",
    category: 2,
    source: "validator/structure-parse.ts",
  },

  // --- Validation errors (E0301-E0322) ---

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
    message: "Agent / Scope / Inter-Agent Contract / Conflict declaration error",
    category: 3,
    source: "validator/structure-agent.ts",
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
  E0320: {
    name: "Validation Error",
    message: "Unknown agent cross-reference or self-approval",
    category: 3,
    source: "validator/references.ts",
  },
  E0321: {
    name: "Validation Error",
    message: "Duplicate agent id",
    category: 3,
    source: "validator/uniqueness.ts",
  },
  E0322: {
    name: "Validation Error",
    message: "Agent path injection (absolute path, traversal, empty path)",
    category: 3,
    source: "validator/references.ts",
  },

  // --- Manifest errors (E0401-E0404) ---

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
