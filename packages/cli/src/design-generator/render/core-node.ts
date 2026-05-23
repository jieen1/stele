// Core-node declarations rendered from DDD aggregate roots.

import type { AggregateRoot } from "../../design-profile/types.js";
import { escapeString } from "./shared.js";

/**
  * Render a core-node declaration for an aggregate root.
  * Output includes lang, role, target, description, rationale, and metric fields.
  */
export function renderAggregateCoreNode(contextId: string, agg: AggregateRoot): string {
  const cnId = `${contextId}-${agg.id}-aggregate`;
  const lines: string[] = [];

  lines.push(`(core-node "${cnId}"`);
  lines.push(`  (lang typescript)`);
  lines.push(`  (role business-core-service)`);
  lines.push(`  (target "${escapeString(agg.target)}")`);
  lines.push(
    `  (description "Generated from design profile: ${agg.class} aggregate must remain reviewable.")`,
  );
  lines.push(
    `  (rationale "${agg.class} protects core ${contextId} invariants; complexity drift makes agent changes risky.")`,
  );

  // Metrics
  const m = agg.metrics;
  if (m.sloc) {
    lines.push(`  (metric sloc (ideal ${m.sloc.ideal}) (max ${m.sloc.max}))`);
  }
  if (m["public-method-count"]) {
    lines.push(`  (metric public-method-count (ideal ${m["public-method-count"].ideal}) (max ${m["public-method-count"].max}))`);
  }
  if (m["max-cyclomatic"]) {
    lines.push(`  (metric max-cyclomatic (ideal ${m["max-cyclomatic"].ideal}) (max ${m["max-cyclomatic"].max}))`);
  }

  lines.push(")");
  return lines.join("\n");
}
