// Round 14 P0: Python EffectAnnotationExtractor.
//
// The Python CallGraph extractor (`python_call_graph_extractor.py`)
// already attaches the `effects` field to each node when it sees one
// of these annotation forms:
//
//   @stele.effects(["payment.charge", "db.read"])
//   def charge(): ...
//
//   def charge():
//       """Charge a payment.
//
//       @stele:effects payment.charge db.read
//       """
//       ...
//
// This extractor simply pulls those pre-attached `effects` out of the
// graph nodes — no separate Python invocation needed. Keeps Stele's
// "one source of truth per backend" principle.

import type {
  EffectAnnotationExtractor,
  ExtractEffectAnnotationsOptions,
  ExtractEffectAnnotationsResult,
} from "@stele/effect-evaluator";

export const pyEffectAnnotationExtractor: EffectAnnotationExtractor = {
  language: "python",

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
