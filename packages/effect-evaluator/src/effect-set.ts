/**
 * Effect set primitives + glob expansion.
 *
 * Effect names follow lowercase dot-notation (`payment.charge`, `db.read`,
 * ...). Policies and annotations may reference effect names with `*` globs
 * (`payment.*`, `db.*`, or the bare `*` meaning "any declared effect").
 * This module handles set union, difference, subset, and the glob expansion
 * needed by policy checking.
 *
 * All public APIs return frozen, deterministically sorted arrays/sets — the
 * effect evaluator's output must be byte-stable across runs.
 */

const GLOB_META = /[*]/;

/**
 * Deterministic union of two effect sets. Returns a new frozen Set with the
 * union of left and right, sorted insertion order (lexicographic).
 */
export function unionEffects(
  left: Iterable<string>,
  right: Iterable<string>,
): ReadonlySet<string> {
  const merged: string[] = [];
  const seen = new Set<string>();
  for (const e of left) {
    if (!seen.has(e)) {
      seen.add(e);
      merged.push(e);
    }
  }
  for (const e of right) {
    if (!seen.has(e)) {
      seen.add(e);
      merged.push(e);
    }
  }
  merged.sort((a, b) => a.localeCompare(b));
  const out = new Set<string>();
  for (const e of merged) {
    out.add(e);
  }
  return out;
}

/**
 * Deterministic set difference: returns elements of `left` not in `right`.
 */
export function differenceEffects(
  left: Iterable<string>,
  right: Iterable<string>,
): ReadonlySet<string> {
  const rightSet = new Set<string>(right);
  const out: string[] = [];
  for (const e of left) {
    if (!rightSet.has(e)) {
      out.push(e);
    }
  }
  out.sort((a, b) => a.localeCompare(b));
  const result = new Set<string>();
  for (const e of out) {
    result.add(e);
  }
  return result;
}

/**
 * Returns the elements common to both sets (set intersection), sorted.
 */
export function intersectEffects(
  left: Iterable<string>,
  right: Iterable<string>,
): ReadonlySet<string> {
  const rightSet = new Set<string>(right);
  const out: string[] = [];
  for (const e of left) {
    if (rightSet.has(e)) {
      out.push(e);
    }
  }
  out.sort((a, b) => a.localeCompare(b));
  const result = new Set<string>();
  for (const e of out) {
    result.add(e);
  }
  return result;
}

/** True if every element of `subset` is in `superset`. */
export function isSubset(
  subset: Iterable<string>,
  superset: Iterable<string>,
): boolean {
  const superSet = new Set<string>(superset);
  for (const e of subset) {
    if (!superSet.has(e)) {
      return false;
    }
  }
  return true;
}

/**
 * Returns true when `pattern` contains glob metacharacters.
 * Currently only `*` is supported in effect references (see CDL grammar
 * EFFECT_GLOB_RE in structure-effect.ts).
 */
export function isEffectGlob(pattern: string): boolean {
  return GLOB_META.test(pattern);
}

/**
 * Compile a single effect-reference pattern into a predicate. Patterns may
 * be:
 *   - Exact names: `db.read` matches only `db.read`
 *   - Subtree globs: `payment.*` matches `payment.charge`, `payment.refund`
 *     (one or more characters after the dot)
 *   - Universal: `*` matches every declared effect
 *   - Mid-pattern globs: `db.*.audit` (rare but supported for symmetry with
 *     CDL grammar)
 */
export function compileEffectPattern(pattern: string): (name: string) => boolean {
  if (!isEffectGlob(pattern)) {
    return (name) => name === pattern;
  }
  if (pattern === "*") {
    return () => true;
  }
  // Build a regex by escaping everything except `*`, which becomes `[^.]+`
  // for segment-bounded globs (`payment.*` → match `payment.X`, `payment.X.Y`).
  // Round 2 spec §3.3 examples imply `payment.*` matches `payment.charge`
  // AND `payment.refund` — both single-segment. We accept either single-
  // segment or multi-segment for safety: `*` becomes `[A-Za-z0-9._-]+`.
  let re = "^";
  for (const ch of pattern) {
    if (ch === "*") {
      re += "[a-z0-9._-]+";
    } else if (/[.+^$|(){}\\\][?]/.test(ch)) {
      re += `\\${ch}`;
    } else {
      re += ch;
    }
  }
  re += "$";
  const compiled = new RegExp(re);
  return (name) => compiled.test(name);
}

/**
 * Expand a list of effect references (names or globs) against the set of
 * known declared effects. Returns a deterministic set.
 *
 * Effect references that resolve to zero declared effects are silently
 * skipped — the evaluator's contract validation is supposed to flag
 * unknown effect names upstream. This function does not throw; it returns
 * the empty set instead so the policy check degrades gracefully.
 */
export function expandEffectPatterns(
  refs: Iterable<string>,
  declaredEffects: Iterable<string>,
): ReadonlySet<string> {
  const declared = [...new Set(declaredEffects)].sort((a, b) =>
    a.localeCompare(b),
  );
  const out = new Set<string>();
  for (const ref of refs) {
    const predicate = compileEffectPattern(ref);
    for (const e of declared) {
      if (predicate(e)) {
        out.add(e);
      }
    }
    // Also: an exact non-glob ref always resolves to itself even if not
    // among `declared` — defensive, lets policies reference effects the
    // declarations forgot. (The validator should already have surfaced
    // this, but the evaluator should not silently drop.)
    if (!isEffectGlob(ref) && !out.has(ref)) {
      out.add(ref);
    }
  }
  return sortedSet(out);
}

/** Convert any iterable of effect names into a deterministic frozen set. */
export function sortedSet(values: Iterable<string>): ReadonlySet<string> {
  const arr = [...new Set(values)].sort((a, b) => a.localeCompare(b));
  const out = new Set<string>();
  for (const e of arr) {
    out.add(e);
  }
  return out;
}

/**
 * Render an effect set as a deterministic comma-separated string, e.g.
 * "[db.read, http.outgoing]". Used in violation cause/detail.
 */
export function renderEffectSet(values: Iterable<string>): string {
  const arr = [...sortedSet(values)];
  return `[${arr.join(", ")}]`;
}
