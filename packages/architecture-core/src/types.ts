import type { SourceSpan } from "@stele/core";

export type ArchitectureLang = "typescript";

export type ArchitectureModuleDeclaration = {
  id: string;
  paths: string[];
  publicEntries: string[];
  span: SourceSpan;
};

export type ArchitectureLayerDeclaration = {
  id: string;
  modules: string[];
  span: SourceSpan;
};

export type ArchitectureAllowDependencyDeclaration = {
  from: string;
  to: string[];
  span: SourceSpan;
};

export type ArchitectureDeclaration = {
  kind: "architecture";
  id: string;
  lang: ArchitectureLang;
  tsconfig?: string;
  description?: string;
  modules: ArchitectureModuleDeclaration[];
  layers: ArchitectureLayerDeclaration[];
  allowDependencies: ArchitectureAllowDependencyDeclaration[];
  denyCycles: boolean;
  fix?: string;
};

export type DependencyImportKind =
  | "static-import"
  | "dynamic-import"
  | "export-from"
  | "require-call";

export type DependencyEdge = {
  fromModule: string;
  toModule: string;
  fromFile: string;
  toFile?: string;
  specifier: string;
  importKind: DependencyImportKind;
  line: number;
  column: number;
};

export type ArchitectureGraph = {
  architectureId: string;
  modules: Record<string, string[]>;
  edges: DependencyEdge[];
  unownedFiles: string[];
  ambiguousFiles: Array<{ file: string; modules: string[] }>;
  unresolvedSpecifiers: Array<{
    fromFile: string;
    specifier: string;
    line: number;
    column: number;
  }>;
};

export type DependencyViolation = {
  fromModule: string;
  toModule: string;
  fromFile: string;
  specifier: string;
  line: number;
  column: number;
  allowedTargets: string[];
};

export type CycleViolation = {
  modules: string[];
  edgeFiles: string[];
};

export type LayerDirectionViolation = {
  fromModule: string;
  toModule: string;
  fromLayer: string;
  toLayer: string;
  fromFile: string;
  specifier: string;
  line: number;
  column: number;
};

export type PublicEntryViolation = {
  fromModule: string;
  toModule: string;
  fromFile: string;
  toFile: string;
  specifier: string;
  publicEntries: string[];
  line: number;
  column: number;
};

export type EvaluationResult = {
  violations: DependencyViolation[];
  cycleViolations: CycleViolation[];
  layerDirectionViolations: LayerDirectionViolation[];
  publicEntryViolations: PublicEntryViolation[];
  ambiguousFiles: Array<{ file: string; modules: string[] }>;
  unresolvedSpecifiers: ArchitectureGraph["unresolvedSpecifiers"];
};
