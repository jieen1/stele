/**
 * Per-language source-code annotation extractor. The TypeScript implementation
 * (T5.3) reads JSDoc `@stele:effects` tags. Python (B.2) reads `@stele.effects(...)`
 * decorators. Go/Java/Rust follow in B.3.
 *
 * The trait intentionally returns a flat `NodeId -> effect[]` map so the
 * evaluator does not need to know HOW the backend obtained the annotation
 * (JSDoc tag, decorator, phantom-type alias, attribute macro, ...). The
 * evaluator merges this map with CDL `effectAnnotations` to form the initial
 * effect set for every node, then propagates via the call graph.
 */

import type {
  CallGraph,
  SupportedLanguage,
} from "@stele/call-graph-core";

export interface ExtractEffectAnnotationsOptions {
  readonly callGraph: CallGraph;
  readonly projectRoot: string;
  readonly tsconfigPath?: string;
}

export interface ExtractEffectAnnotationsResult {
  /**
   * Map keyed by NodeId. Values are the effect names attached to that node
   * by source-code annotations. The evaluator validates each name against
   * the contract's declared effect set; a name that resolves to no declared
   * effect is surfaced as an `effect.undeclared_effect_name` violation
   * (error severity) — see `buildUndeclaredEffectNameViolation`.
   */
  readonly annotationsByNode: ReadonlyMap<string, readonly string[]>;

  /**
   * Optional: locations where the extractor found a `@stele:effects`
   * annotation written in a form the language-native channel does NOT honour
   * (e.g. a `//`-style line comment in TypeScript, where only block JSDoc is
   * recognised). These do not contribute effects — but silently ignoring
   * them is a footgun (the author thinks they declared an effect). The
   * evaluator surfaces each as an `effect.line_comment_annotation_ignored`
   * notice so the author learns the annotation had no effect. Backends that
   * cannot detect malformed annotations omit this field.
   */
  readonly ignoredAnnotations?: readonly IgnoredAnnotation[];
}

/**
 * A `@stele:effects` annotation the extractor recognised textually but could
 * not honour through the language's annotation channel (wrong comment form).
 */
export interface IgnoredAnnotation {
  /** Absolute source file path. */
  readonly filePath: string;
  /** 1-based line of the ignored annotation. */
  readonly line: number;
  /** The raw annotation text (e.g. `// @stele:effects network`). */
  readonly raw: string;
  /**
   * Why it was ignored, for the notice message (e.g.
   * "line-comment form; only block JSDoc `/** @stele:effects ... *​/` is honoured").
   */
  readonly reason: string;
}

export interface EffectAnnotationExtractor {
  readonly language: SupportedLanguage;
  extractAnnotations(
    options: ExtractEffectAnnotationsOptions,
  ): Promise<ExtractEffectAnnotationsResult>;
}
