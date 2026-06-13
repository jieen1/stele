/**
 * P0-5: Type-driven domain primitives with smart constructors.
 *
 * Branded (nominal) types that prevent plain `string` values from being
 * used where a domain-specific identifier is expected. The TypeScript
 * compiler rejects direct assignment; only the exported smart constructors
 * can produce valid instances.
 *
 * Each type carries a unique symbol brand so that `RuleId` and `Sha256`
 * are structurally different at compile time despite sharing a `string`
 * representation at runtime.
 */

// ---------------------------------------------------------------------------
// Unique symbol brands -- never leak out of this module
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const RULE_ID_BRAND = uniqueSymbol("stele.RuleId");
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const CONTRACT_PATH_BRAND = uniqueSymbol("stele.ContractPath");
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const SHA256_BRAND = uniqueSymbol("stele.Sha256");
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const COMMAND_NAME_BRAND = uniqueSymbol("stele.CommandName");
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const PACKAGE_NAME_BRAND = uniqueSymbol("stele.PackageName");

function uniqueSymbol(description: string): symbol {
  return Symbol(description);
}

// ---------------------------------------------------------------------------
// Branded type definitions
// ---------------------------------------------------------------------------

/**
 * RuleId — identifies a Stele rule or checker.
 *
 * Format: `stele:*` (built-in) or `custom:*` (user-defined).
 * Examples: `"stele:ddd-core"`, `"custom:balance-check"`.
 */
export type RuleId = string & { readonly __brand: typeof RULE_ID_BRAND };

/**
 * ContractPath — path to a Stele contract file.
 *
 * Must end with `.stele` extension.
 * Examples: `"contract/main.stele"`, `"contract/rules/auth.stele"`.
 */
export type ContractPath = string & { readonly __brand: typeof CONTRACT_PATH_BRAND };

/**
 * Sha256 — SHA-256 hash as a 64-character lowercase hex string.
 *
 * Examples: `"a591a6d40bf420404a011733cfb7b19b9c8ddcb6..."`.
 */
export type Sha256 = string & { readonly __brand: typeof SHA256_BRAND };

/**
 * CommandName — CLI command name in lowercase-with-dashes format.
 *
 * Examples: `"check-design"`, `"add-checker"`, `"generate-tests"`.
 */
export type CommandName = string & { readonly __brand: typeof COMMAND_NAME_BRAND };

/**
 * PackageName — npm package name in lowercase-with-dashes format.
 *
 * Examples: `"core"`, `"backend-python"`, `"claude-code-plugin"`.
 */
export type PackageName = string & { readonly __brand: typeof PACKAGE_NAME_BRAND };

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

/**
 * Validate a RuleId string format.
 *
 * Phase 1 self-dogfooding (V-07 widening): accept BOTH historical and
 * stage-emitted forms so a single smart-constructor covers every
 * `rule_id: ...` site in the CLI. The widened pattern admits:
 *
 *   - `stele:<token>` / `custom:<token>` (legacy prefix:body form)
 *   - `architecture.<arch>.<rest>` (cli/src/architecture/stage.ts)
 *   - `complexity.<id>.<metric>`, `design_integrity.violation`
 *   - `effect.<rest>`, `trace.<rest>`, `typestate.<rest>`
 *   - `typedriven.<rest>` (branded-id / eslint / tsc)
 *   - `stele.<rest>` (e.g. `stele.check.execution_error`,
 *     `stele.baseline.human_file_drift`, `stele.self.no_baseline`)
 *
 * Constraint: starts with a lowercase letter, body is alphanumeric +
 * `_.:-` (template-literal interpolation results may include upper-case
 * identifiers from interpolated values, e.g. method names; those are
 * allowed too).
 */
function isValidRuleId(value: string): boolean {
  return /^[a-z][A-Za-z0-9._:-]*$/.test(value);
}

/** Validate a ContractPath string format. */
function isValidContractPath(value: string): boolean {
  return /\.stele$/.test(value) && value.length > 7 && !value.includes("..");
}

/** Validate a Sha256 string format. */
function isValidSha256(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}

/** Validate a CommandName string format. */
function isValidCommandName(value: string): boolean {
  return /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(value);
}

/**
 * Validate a PackageName string format.
 *
 * Phase 1 self-dogfooding (Step 1.6 widening): accept BOTH unscoped
 * npm names (`backend-python`) and scoped names (`@stele/backend-python`).
 * Original regex rejected `@`/`/`, which made it impossible to wrap
 * the 5 entries in `packages/cli/src/backend-registry.ts` without a
 * compile-time failure. The widened pattern admits npm's published
 * naming rules: a single lowercase scope (`@scope/`), each segment
 * starting with a lowercase letter, dashes inside segments allowed.
 */
function isValidPackageName(value: string): boolean {
  return /^(@[a-z][a-z0-9-]*\/)?[a-z][a-z0-9-]*(-[a-z0-9]+)*$/.test(value);
}

// ---------------------------------------------------------------------------
// Smart constructors — the ONLY way to create branded types
// ---------------------------------------------------------------------------

/**
 * Create a RuleId. Throws on invalid format.
 *
 * @example
 *   const id = ruleId("stele:ddd-core");        // ok
 *   const a  = ruleId("architecture.ddd.foo");  // ok (Phase 1 V-07 widening)
 *   const bad = ruleId("");                     // throws TypeError
 *   const bad = ruleId("Has Space");            // throws TypeError
 */
export function ruleId(value: string): RuleId {
  if (!isValidRuleId(value)) {
    throw new TypeError(
      `Invalid RuleId: "${value}". Must start with a lowercase letter and contain only [A-Za-z0-9._:-] (e.g. "stele:ddd-core", "architecture.ddd-core.foo.bar").`,
    );
  }
  return value as RuleId;
}

/**
 * Create a ContractPath. Throws on invalid format.
 *
 * @example
 *   const path = contractPath("contract/main.stele");  // ok
 *   const bad = contractPath("src/index.ts");           // throws TypeError
 */
export function contractPath(value: string): ContractPath {
  if (!isValidContractPath(value)) {
    throw new TypeError(
      `Invalid ContractPath: "${value}". Must end with '.stele' and not contain '..' (e.g. "contract/main.stele").`,
    );
  }
  return value as ContractPath;
}

/**
 * Create a Sha256. Throws on invalid format.
 *
 * @example
 *   const hash = sha256("a591a6d40bf420404a011733cfb7b19b9c8ddcb6abcdef0123456789abcdef01"); // ok
 *   const bad = sha256("not-a-hash");                                                         // throws TypeError
 */
export function sha256(value: string): Sha256 {
  if (!isValidSha256(value)) {
    throw new TypeError(
      `Invalid Sha256: "${value}". Must be a 64-character lowercase hex string.`,
    );
  }
  return value as Sha256;
}

/**
 * Create a CommandName. Throws on invalid format.
 *
 * @example
 *   const cmd = commandName("check-design");    // ok
 *   const bad = commandName("Check_Design");    // throws TypeError
 */
export function commandName(value: string): CommandName {
  if (!isValidCommandName(value)) {
    throw new TypeError(
      `Invalid CommandName: "${value}". Must be lowercase-with-dashes (e.g. "check-design").`,
    );
  }
  return value as CommandName;
}

/**
 * Create a PackageName. Throws on invalid format.
 *
 * Accepts unscoped (`backend-python`) and scoped (`@stele/backend-python`)
 * npm package names. See `isValidPackageName` for the exact pattern.
 *
 * @example
 *   const pkg = packageName("backend-python");           // ok
 *   const scoped = packageName("@stele/backend-python"); // ok
 *   const bad = packageName("Backend_Python");           // throws TypeError
 */
export function packageName(value: string): PackageName {
  if (!isValidPackageName(value)) {
    throw new TypeError(
      `Invalid PackageName: "${value}". Must be lowercase-with-dashes, optionally with a single npm scope (e.g. "backend-python", "@stele/backend-python").`,
    );
  }
  return value as PackageName;
}

// ---------------------------------------------------------------------------
// Predicates (for runtime guards / narrowing)
// ---------------------------------------------------------------------------

/**
 * Check if a value would pass RuleId validation.
 * Returns false for non-strings. Does NOT check the brand, only the shape.
 */
export function isRuleId(value: unknown): boolean {
  return typeof value === "string" && isValidRuleId(value);
}

/**
 * Check if a value would pass ContractPath validation.
 */
export function isContractPath(value: unknown): boolean {
  return typeof value === "string" && isValidContractPath(value);
}

/**
 * Check if a value would pass Sha256 validation.
 */
export function isSha256(value: unknown): boolean {
  return typeof value === "string" && isValidSha256(value);
}

/**
 * Check if a value would pass CommandName validation.
 */
export function isCommandName(value: unknown): boolean {
  return typeof value === "string" && isValidCommandName(value);
}

/**
 * Check if a value would pass PackageName validation.
 */
export function isPackageName(value: unknown): boolean {
  return typeof value === "string" && isValidPackageName(value);
}
