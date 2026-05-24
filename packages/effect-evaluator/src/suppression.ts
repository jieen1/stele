/**
 * Effect suppression — CDL-only (Round 1 spec, §five "Effect 衰减"):
 *
 *   (effect-suppression
 *     (target "src/cache/cached-get.ts::cachedGet(1)")
 *     (suppresses db.read)
 *     (reason "..."))
 *
 * The evaluator applies suppressions by removing the listed effects from the
 * target node's INITIAL effect set BEFORE propagation. This means:
 *
 *   - A suppressed db.read at `cachedGet` is removed from `cachedGet`'s
 *     direct effects;
 *   - Callers of `cachedGet` no longer inherit db.read FROM cachedGet
 *     (but may still inherit it from another callee);
 *   - The suppression is observable via the `notices` array — every active
 *     suppression emits one notice so reviewers can audit which effects
 *     were hidden.
 *
 * Source-code `@stele:effects.suppress` annotations are deliberately not
 * supported (Round 1 design — closing the agent backdoor).
 */

import type {
  EffectSuppressionDeclaration,
  Violation,
} from "@stele/core";
import { createViolation, stableStringCompare } from "@stele/core";

import { differenceEffects, expandEffectPatterns } from "./effect-set.js";

export interface ApplySuppressionsInput {
  readonly initialEffectsByNode: ReadonlyMap<string, ReadonlySet<string>>;
  readonly suppressions: readonly EffectSuppressionDeclaration[];
  readonly declaredEffects: ReadonlySet<string>;
  readonly callGraphNodeIds: ReadonlySet<string>;
}

export interface ApplySuppressionsResult {
  readonly initialEffectsByNode: ReadonlyMap<string, ReadonlySet<string>>;
  /**
   * Suppression mask per node — passed to `propagateEffects` so the
   * suppressed effect cannot re-enter the node via callee propagation
   * (breaks the chain at this node, per 04-effect-system.md §five.5).
   */
  readonly suppressionsByNode: ReadonlyMap<string, ReadonlySet<string>>;
  readonly notices: readonly Violation[];
  readonly activeCount: number;
}

/**
 * Apply suppressions to the initial-effect map. Returns a new map (does not
 * mutate the input).
 *
 * Suppressions whose target node does not exist in the call graph emit an
 * advisory notice but are otherwise ignored — the suppression is dormant,
 * not an error (the target may be conditionally compiled away).
 */
export function applySuppressions(
  input: ApplySuppressionsInput,
): ApplySuppressionsResult {
  const { initialEffectsByNode, suppressions, declaredEffects, callGraphNodeIds } = input;

  const out = new Map<string, ReadonlySet<string>>();
  for (const [id, set] of initialEffectsByNode.entries()) {
    out.set(id, set);
  }

  const mask = new Map<string, Set<string>>();

  const notices: Violation[] = [];
  let activeCount = 0;

  for (const s of suppressions) {
    const expanded = expandEffectPatterns(s.suppresses, declaredEffects);
    const targetNodeExists = callGraphNodeIds.has(s.target);

    if (!targetNodeExists) {
      // Target absent — emit a notice and skip.
      notices.push(buildSuppressionDormantNotice(s));
      continue;
    }

    const before = out.get(s.target) ?? new Set<string>();
    const after = differenceEffects(before, expanded);
    out.set(s.target, after);

    // Accumulate the mask so a single node can hold suppressions from
    // multiple `(effect-suppression ...)` declarations.
    let bucket = mask.get(s.target);
    if (bucket === undefined) {
      bucket = new Set<string>();
      mask.set(s.target, bucket);
    }
    for (const e of expanded) {
      bucket.add(e);
    }

    // Active-suppression notice (Round 1 spec § five).
    notices.push(buildSuppressionActiveNotice(s, expanded));
    activeCount += 1;
  }

  // Freeze mask.
  const frozenMask = new Map<string, ReadonlySet<string>>();
  for (const [id, set] of mask.entries()) {
    frozenMask.set(
      id,
      new Set<string>([...set].sort((a, b) => stableStringCompare(a, b))),
    );
  }

  return {
    initialEffectsByNode: out,
    suppressionsByNode: frozenMask,
    notices: Object.freeze(notices),
    activeCount,
  };
}

function buildSuppressionActiveNotice(
  s: EffectSuppressionDeclaration,
  expandedSuppresses: ReadonlySet<string>,
): Violation {
  const expanded = [...expandedSuppresses].sort((a, b) => stableStringCompare(a, b));
  return createViolation({
    rule_id: "effect.suppression_active",
    rule_kind: "effect_suppression_notice",
    severity: s.severity === "error" ? "error" : "warning",
    source: { tool: "stele", command: "check", kind: "effect" },
    location: {
      path: s.filePath,
      line: s.span.line,
      column: s.span.column,
    },
    cause: {
      summary: `Effect suppression active at \`${s.target}\` (suppresses [${expanded.join(", ")}]).`,
      detail: [
        `target: ${s.target}`,
        `suppresses: [${expanded.join(", ")}]`,
        `reason: ${s.reason}`,
      ].join("\n"),
    },
    scope_paths: [s.filePath],
    priority: "minor",
    group_id: s.target,
  });
}

function buildSuppressionDormantNotice(
  s: EffectSuppressionDeclaration,
): Violation {
  return createViolation({
    rule_id: "effect.suppression_dormant",
    rule_kind: "effect_suppression_notice",
    severity: "warning",
    source: { tool: "stele", command: "check", kind: "effect" },
    location: {
      path: s.filePath,
      line: s.span.line,
      column: s.span.column,
    },
    cause: {
      summary: `Effect suppression target \`${s.target}\` not found in the call graph (dormant).`,
      detail: [
        `target: ${s.target}`,
        `suppresses: [${[...s.suppresses].sort((a, b) => stableStringCompare(a, b)).join(", ")}]`,
        `reason: ${s.reason}`,
        `note: the target NodeId did not resolve to any node — this suppression has no effect.`,
      ].join("\n"),
    },
    scope_paths: [s.filePath],
    priority: "minor",
    group_id: s.target,
  });
}
