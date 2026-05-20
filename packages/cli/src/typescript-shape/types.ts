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
