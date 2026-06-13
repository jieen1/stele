// Go EffectAnnotationExtractor.
//
// The Go CallGraph extractor (`go_call_graph_extractor.go`) already attaches the
// `effects` field to each node when it sees a `// stele:effects a.b c.d`
// doc-comment on a func/method. This extractor pulls those pre-attached effects
// out of the graph — no separate Go invocation needed (mirrors backend-python).

import type {
  EffectAnnotationExtractor,
  ExtractEffectAnnotationsOptions,
  ExtractEffectAnnotationsResult,
} from "@stele/effect-evaluator";

export const goEffectAnnotationExtractor: EffectAnnotationExtractor = {
  language: "go",

  async extractAnnotations(
    options: ExtractEffectAnnotationsOptions,
  ): Promise<ExtractEffectAnnotationsResult> {
    const annotationsByNode = new Map<string, readonly string[]>();
    for (const node of options.callGraph.nodes) {
      if (node.effects && node.effects.length > 0) {
        annotationsByNode.set(node.id, node.effects);
      }
    }
    return { annotationsByNode };
  },
};
