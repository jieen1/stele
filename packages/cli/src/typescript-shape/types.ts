export interface ShapeViolation {
  ruleId: string;
  ruleKind: "typescript-shape";
  file: string;
  line?: number;
  column?: number;
  message: string;
  severity: "error" | "warning";
  fix: string;
}

export interface SmartConstructorTarget {
  id: string;
  classTarget: string;
  factoryMethods: string[];
}

export interface SmartConstructorCheckOptions {
  tsconfigPath: string;
  targets: SmartConstructorTarget[];
}

export interface SmartConstructorResult {
  target: SmartConstructorTarget;
  violations: ShapeViolation[];
}

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
