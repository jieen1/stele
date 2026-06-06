/**
 * Cross-language call-graph data structures consumed by Stele's
 * Phase B evaluators (trace, type-state, effect).
 *
 * All shapes here are language-agnostic. Per-language backend
 * extractors (TypeScript, Python, Go, Java, Rust) produce a
 * `CallGraph` whose contents follow these contracts.
 */

export type SupportedLanguage =
  | "typescript"
  | "python"
  | "go"
  | "java"
  | "rust";

/** Frozen tuple of all supported language identifiers. */
export const ALL_LANGUAGES: readonly SupportedLanguage[] = Object.freeze([
  "typescript",
  "python",
  "go",
  "java",
  "rust",
] as const);

export interface SourceSpan {
  /** 1-based line number. */
  readonly line: number;
  /** 1-based column number. */
  readonly column: number;
  readonly endLine?: number;
  readonly endColumn?: number;
}

export interface TypeStateAnnotation {
  readonly parameterIndex: number;
  readonly state: string;
}

export interface CallGraphNode {
  /** Stable NodeId per spec; see docs/design/phase-b/01-call-graph-extractor.md §3. */
  readonly id: string;
  readonly kind: "function" | "method" | "constructor" | "lambda" | "module-init";
  /** Relative to projectRoot, POSIX. */
  readonly filePath: string;
  /** Definition location. */
  readonly span: SourceSpan;
  /** Textual signature (best effort). */
  readonly signature: string;
  readonly isExported: boolean;
  readonly isAsync: boolean;
  /**
   * Explicitly declared effect tags (from JSDoc `@stele:effects`,
   * decorator, or annotation). Used by Phase B effect system.
   */
  readonly effects?: readonly string[];
  /**
   * Type-state annotations on parameters; used by Phase B type-state
   * system.
   */
  readonly typeStateAnnotations?: readonly TypeStateAnnotation[];
}

export interface CallGraphEdge {
  readonly fromId: string;
  readonly toId: string;
  /** Where the call appears. */
  readonly callSite: SourceSpan;
  readonly isConditional: boolean;
  readonly isLoop: boolean;
  readonly isAsync: boolean;
}

export interface UnresolvedCall {
  readonly fromId: string;
  readonly callSite: SourceSpan;
  readonly rawText: string;
  readonly reason: "dynamic" | "reflection" | "module-not-resolved" | "external-lib";
  /**
   * Whether the called NAME is hidden from static analysis. A trace-policy
   * forbids/requires reaching a SPECIFIC NAMED target (e.g. `writeFileSync`).
   * An unresolved call can only be a bypass of that policy if the called name
   * is HIDDEN — so it COULD be the target:
   *
   *   - computed-member dispatch `obj[expr]()` (name is an arbitrary runtime
   *     value),
   *   - reflection (`Reflect.apply`/`Reflect.construct`, `.call`/`.apply`/
   *     `.bind` indirection where the function is not statically named),
   *   - dynamic `import(...)` whose namespace member is then invoked.
   *
   * When the callee name is statically VISIBLE (calling a named identifier /
   * param / local / property / interface-method whose identifier is
   * recoverable, e.g. `predicate()`, `output.stdout()`) the call cannot BE the
   * target unless its visible name matches the target pattern — in which case
   * it would have resolved to an edge. Such name-visible indirect calls are
   * recorded as unresolved (the symbol/module didn't resolve) but with
   * `nameHidden: false`, and the trace fail-closed gate does NOT fire on them.
   */
  readonly nameHidden: boolean;
}

export interface AmbiguousCall {
  readonly fromId: string;
  readonly callSite: SourceSpan;
  readonly candidates: readonly string[];
}

export interface CallGraph {
  readonly schemaVersion: "1";
  readonly language: SupportedLanguage;
  /** ISO timestamp. */
  readonly generatedAt: string;
  /** Absolute path, validated on deserialize. */
  readonly projectRoot: string;
  readonly nodes: readonly CallGraphNode[];
  readonly edges: readonly CallGraphEdge[];
  readonly unresolvedCalls: readonly UnresolvedCall[];
  readonly ambiguousCalls: readonly AmbiguousCall[];
  /** SHA-256 of all interface→impl resolutions used during extraction. */
  readonly methodResolutionHash: string;
  /** Per-file SHA-256 used for incremental cache invalidation. */
  readonly fileHashes: Readonly<Record<string, string>>;
}

export interface ExtractOptions {
  readonly projectRoot: string;
  /** If undefined, extract whole project. */
  readonly sourceFiles?: readonly string[];
  readonly tsconfigPath?: string;
  readonly cacheDir?: string;
}

/** Trait implemented by each per-language backend extractor. */
export interface CallGraphExtractor {
  readonly language: SupportedLanguage;
  extract(options: ExtractOptions): Promise<CallGraph>;
  extractIncremental(
    options: ExtractOptions & {
      readonly changedFiles: readonly string[];
      readonly previous: CallGraph;
    },
  ): Promise<CallGraph>;
}
