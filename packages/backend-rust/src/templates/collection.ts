/**
 * Collection operators for the Rust backend.
 *
 * Includes quantifiers (forall, exists, where, none), aggregates,
 * and EP04 collection helpers (length, concat, sort-by, map, first, last).
 */

/**
 * Render a Rust quantifier call.
 *
 * forall/exists/none return Result<(), SteleAssertionError>.
 * where returns Vec<SteleValue>.
 */
export function renderQuantifier(
    operator: string,
    collection: string,
    binding: string,
    predicate: string,
    predicateSource: string,
    testName: string,
): string {
    const fn = operator === "filter" ? "stele_where" : `stele_${operator}`;
    const closure = `|${binding}: &SteleValue| ${predicate}`;

    if (operator === "where" || operator === "filter") {
        return `${fn}(${collection}, ${closure})`;
    }

    return `${fn}(${collection}, ${closure}, ${rustStringLiteral(predicateSource)}, ${rustStringLiteral(testName)})?`;
}

/**
 * Render a Rust aggregate call with optional projection path.
 */
export function renderAggregate(operator: string, collection: string, pathSegments?: string[], inClosure = false): string {
    const fn = `stele_${operator}`;
    const tryOp = inClosure ? "" : "?";
    if (pathSegments !== undefined) {
        return `${fn}(&${collection}, &${formatSegmentSlice(pathSegments)})${tryOp}`;
    }
    return `${fn}(&${collection})${tryOp}`;
}

/**
 * Render `stele_length(collection)`.
 */
export function renderLength(collection: string): string {
    return `stele_length(${collection})`;
}

/**
 * Render `stele_sort_by(collection, &segments)?`.
 */
export function renderSortBy(collection: string, descending: boolean, pathSegments: string[]): string {
    const fn = descending ? "stele_sort_by_desc" : "stele_sort_by";
    return `${fn}(${collection}, &${formatSegmentSlice(pathSegments)})`;
}

/**
 * Render `stele_map(collection, &segments)`.
 */
export function renderMap(collection: string, pathSegments: string[]): string {
    return `stele_map(${collection}, &${formatSegmentSlice(pathSegments)})`;
}

/**
 * Render `stele_first(collection)` / `stele_last(collection)`.
 */
export function renderFirst(collection: string): string {
    return `stele_first(${collection})`;
}

export function renderLast(collection: string): string {
    return `stele_last(${collection})`;
}

/**
 * Format a segment array as a Rust slice literal.
 */
function formatSegmentSlice(segments: string[]): string {
    return `[${segments.map(rustStringLiteral).join(", ")}]`;
}

function rustStringLiteral(value: string): string {
    return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
