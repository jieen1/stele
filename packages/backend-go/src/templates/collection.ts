/**
 * Collection operator templates for Go backend.
 *
 * Maps CDL collection operators to Go function calls in the runtime.
 * Includes aggregates (sum, count, avg, min, max, distinct, unique),
 * collection primitives (has-length, is-empty, exists-in, length, concat),
 * and quantifiers (forall, exists, where, none).
 */

export type AggregateOp = "sum" | "count" | "avg" | "min" | "max" | "distinct" | "unique";

export type CollectionOp =
  | "has-length"
  | "is-empty"
  | "exists-in"
  | "length"
  | "concat";

export type QuantifierOp = "forall" | "exists" | "where" | "none";

export type SortOp = "sort-by" | "sort-by-desc";

const AGGREGATE_MAP: Record<AggregateOp, string> = {
  sum: "steleSum",
  count: "steleCount",
  avg: "steleAvg",
  min: "steleMin",
  max: "steleMax",
  distinct: "steleDistinct",
  unique: "steleUnique",
};

const COLLECTION_MAP: Record<CollectionOp, string> = {
  "has-length": "steleHasLength",
  "is-empty": "steleIsEmpty",
  "exists-in": "steleExistsIn",
  length: "steleLength",
  concat: "steleConcat",
};

const QUANTIFIER_MAP: Record<QuantifierOp, string> = {
  forall: "steleForall",
  exists: "steleExists",
  where: "steleWhere",
  none: "steleNone",
};

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _SORT_MAP: Record<SortOp, string> = {
  "sort-by": "steleSortBy",
  "sort-by-desc": "steleSortByDesc",
};

/**
 * Check if an operator is an aggregate operator.
 */
export function isAggregateOp(op: string): op is AggregateOp {
  return op in AGGREGATE_MAP;
}

/**
 * Check if an operator is a quantifier.
 */
export function isQuantifierOp(op: string): op is QuantifierOp {
  return op in QUANTIFIER_MAP;
}

/**
 * Return the Go runtime function name for an aggregate operator.
 */
export function goAggregateFunc(op: AggregateOp): string {
  return AGGREGATE_MAP[op];
}

/**
 * Return the Go runtime function name for a collection operator.
 */
export function goCollectionFunc(op: CollectionOp): string {
  return COLLECTION_MAP[op];
}

/**
 * Return the Go runtime function name for a quantifier operator.
 */
export function goQuantifierFunc(op: QuantifierOp): string {
  return QUANTIFIER_MAP[op];
}

/**
 * Emit a Go aggregate expression with optional path projection.
 * Aggregates that take a path: sum, avg, min, max, distinct, unique.
 * Aggregates that don't: count.
 */
export function emitAggregate(op: AggregateOp, collection: string, pathSegments?: string[]): string {
  const fn = goAggregateFunc(op);
  if (op === "count") {
    return `${fn}(${collection})`;
  }
  if (pathSegments && pathSegments.length > 0) {
    const segs = formatGoStringSlice(pathSegments);
    return `${fn}(${collection}, ${segs}...)`;
  }
  return `${fn}(${collection})`;
}

/**
 * Emit a Go quantifier expression. In Go, quantifiers receive the test
 * pointer, collection, a predicate closure, and the predicate source string.
 */
export function emitQuantifier(
  op: QuantifierOp,
  collection: string,
  predicateBody: string,
  predicateSource: string,
  bindName: string,
): string {
  const fn = goQuantifierFunc(op);
  const escapedSource = goStringLiteral(predicateSource);
  return `${fn}(t, ${collection}, func(${bindName} any) bool { ${predicateBody} }, ${escapedSource})`;
}

/**
 * Format a slice of strings as a Go string literal slice: []string{"a", "b"}.
 */
function formatGoStringSlice(segments: readonly string[]): string {
  return `[]string{${segments.map((s) => goStringLiteral(s)).join(", ")}}`;
}

/**
 * Wrap a value in Go double quotes.
 */
function goStringLiteral(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
