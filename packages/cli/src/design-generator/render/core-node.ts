// Core-node declarations rendered from DDD aggregate roots.
//
// Phase 6 self-dogfooding (2026-05-25): when an aggregate root carries
// `required_methods` and/or `required_fields`, the renderer also emits a
// paired `(class-shape …)` declaration so the aggregate's structural
// identity is locked alongside its complexity metrics. The class-shape
// evaluator only binds to real `class` declarations — function-targeted
// aggregates (e.g. `validateInvariant`, `runCheck`) cannot use this
// extension today (see decision log).

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

/**
 * Phase 6 self-dogfooding: render an optional `(class-shape …)`
 * declaration for an aggregate root that supplied `required_methods`
 * and/or `required_fields`. Returns `undefined` if neither is populated
 * (so the core-node renders alone, byte-identical to the pre-Phase-6
 * output).
 *
 * The id mirrors `<contextId>-<aggId>-aggregate-shape`. The lang is
 * pinned to `typescript` to match the existing core-node lang; the
 * class-shape evaluator runs the TypeScript analyzer and only binds to
 * real `class` declarations on the file referenced by `agg.target`.
 *
 * Order in the generated CDL: the class-shape appears immediately after
 * its companion core-node (see ddd.ts), keeping locality between the
 * complexity-bounded view and the structural-shape view.
 */
export function renderAggregateClassShape(
  contextId: string,
  agg: AggregateRoot,
): string | undefined {
  const hasMethods = (agg.required_methods?.length ?? 0) > 0;
  const hasFields = (agg.required_fields?.length ?? 0) > 0;
  if (!hasMethods && !hasFields) {
    return undefined;
  }

  const csId = `${contextId}-${agg.id}-aggregate-shape`;
  const lines: string[] = [];

  lines.push(`(class-shape ${csId}`);
  lines.push(`  (lang typescript)`);
  lines.push(`  (target "${escapeString(agg.target)}")`);

  // Sorted for deterministic output regardless of YAML key order.
  const methods = [...(agg.required_methods ?? [])].sort();
  const fields = [...(agg.required_fields ?? [])].sort();

  for (const method of methods) {
    lines.push(`  (must-have-method "${escapeString(method)}")`);
  }
  for (const field of fields) {
    lines.push(`  (must-have-field "${escapeString(field)}")`);
  }

  lines.push(")");
  return lines.join("\n");
}
