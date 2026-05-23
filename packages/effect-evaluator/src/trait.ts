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
   * by source-code annotations. The evaluator validates against declared
   * effects; unknown names are surfaced as notices.
   */
  readonly annotationsByNode: ReadonlyMap<string, readonly string[]>;
}

export interface EffectAnnotationExtractor {
  readonly language: SupportedLanguage;
  extractAnnotations(
    options: ExtractEffectAnnotationsOptions,
  ): Promise<ExtractEffectAnnotationsResult>;
}
