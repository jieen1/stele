// Branded ID types

export interface BrandedIdDeclaration {
  typeName: string;        // e.g. "InvoiceId"
  typeTarget: string;      // e.g. "src/billing/domain/invoice/ids.ts::InvoiceId"
  entityScope?: string;    // glob pattern for files that should use this ID type
}

export interface BrandedIdViolation {
  file: string;
  line: number;
  column: number;
  message: string;
  fix: string;
}

export interface BrandedIdCheckOptions {
  projectDir: string;
  tsconfigPath?: string;
  declarations: BrandedIdDeclaration[];
}

/**
 * Per-declaration binding coverage, so the check stage can detect a vacuously
 * green branded-id — one whose `entity-scope` is declared but resolves to no
 * analyzable file (a renamed/typo'd scope that enforces nothing at runtime).
 */
export interface BrandedIdCoverage {
  typeName: string;
  /** True when the declaration carries an `entity-scope` (enforcement attempted). */
  enforced: boolean;
  /** Scope files actually analyzed for raw-string usage (excludes the type-def file). */
  scopeFilesAnalyzed: number;
}

export interface BrandedIdCheckResult {
  violations: BrandedIdViolation[];
  coverage: BrandedIdCoverage[];
}
