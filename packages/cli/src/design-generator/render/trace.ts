// Trace-policy declarations (Phase B T3.4).
//
// Translates `trace.policies[*]` entries from the design profile into
// `(trace-policy ...)` CDL forms. The structural parser in `@stele/core`
// (validator/structure-trace-policy.ts) consumes the emitted CDL.
//
// Field-name convention: profile YAML uses snake_case (`must_transit`,
// `deny_direct`, `fix_hint`, `must_be_preceded_by`, `must_be_followed_by`,
// `deny_transit`) to match the rest of the design profile. CDL uses
// kebab-case (`must-transit`, `deny-direct`, `fix-hint`, …). This module
// is the single place that performs that translation.
//
// Output is byte-stable: field order is fixed, list members preserve the
// authoring order from the profile, and rendering the same input twice
// must produce identical strings.

import type { TracePolicySpec, TraceSection } from "../../design-profile/types.js";
import { escapeString } from "./shared.js";

function renderQuotedList(values: readonly string[]): string {
  return values.map((v) => `"${escapeString(v)}"`).join(" ");
}

/**
 * Render a single trace-policy block as CDL text.
 *
 * Field order (deterministic):
 *   id (positional)
 *   description, severity, target,
 *   must-transit, must-be-preceded-by, must-be-followed-by,
 *   deny-direct, deny-transit,
 *   scope,
 *   exempt (one per entry, in authored order),
 *   fix-hint.
 *
 * Optional fields are omitted when undefined/empty so profiles that do not
 * use them keep CDL output tight.
 */
export function renderTracePolicy(policy: TracePolicySpec): string {
  const lines: string[] = [];
  lines.push(`(trace-policy "${escapeString(policy.id)}"`);

  if (policy.description !== undefined) {
    lines.push(`  (description "${escapeString(policy.description)}")`);
  }
  if (policy.severity !== undefined) {
    lines.push(`  (severity "${policy.severity}")`);
  }

  lines.push(`  (target ${renderQuotedList(policy.target)})`);

  if (policy.must_transit && policy.must_transit.length > 0) {
    lines.push(`  (must-transit ${renderQuotedList(policy.must_transit)})`);
  }
  if (policy.must_be_preceded_by && policy.must_be_preceded_by.length > 0) {
    lines.push(`  (must-be-preceded-by ${renderQuotedList(policy.must_be_preceded_by)})`);
  }
  if (policy.must_be_followed_by && policy.must_be_followed_by.length > 0) {
    lines.push(`  (must-be-followed-by ${renderQuotedList(policy.must_be_followed_by)})`);
  }
  if (policy.deny_direct && policy.deny_direct.length > 0) {
    lines.push(`  (deny-direct ${renderQuotedList(policy.deny_direct)})`);
  }
  if (policy.deny_transit && policy.deny_transit.length > 0) {
    lines.push(`  (deny-transit ${renderQuotedList(policy.deny_transit)})`);
  }

  if (policy.scope && policy.scope.length > 0) {
    lines.push(`  (scope ${renderQuotedList(policy.scope)})`);
  }

  for (const ex of policy.exempt ?? []) {
    lines.push(
      `  (exempt "${escapeString(ex.pattern)}" (reason "${escapeString(ex.reason)}"))`,
    );
  }

  if (policy.fix_hint !== undefined) {
    lines.push(`  (fix-hint "${escapeString(policy.fix_hint)}")`);
  }

  lines.push(")");
  return lines.join("\n");
}

/**
 * Render all trace-policy declarations from a TraceSection.
 *
 * Returns the concatenated CDL text separated by a single blank line. When
 * the section is undefined or empty, returns the empty string so the
 * caller can skip without introducing trailing whitespace.
 */
export function renderTraceSection(section: TraceSection | undefined): string {
  if (!section || section.policies.length === 0) {
    return "";
  }
  return section.policies.map(renderTracePolicy).join("\n\n");
}
