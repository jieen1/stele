/**
 * String operators for the Rust backend.
 */

/**
 * Wrap an argument for a &SteleValue parameter.
 */
function wrapArg(expr: string): string {
    if (/^[a-z_]+$/.test(expr) && !expr.startsWith("stele_") && expr !== "ctx") {
        return expr;
    }
    return `&${expr}`;
}

/**
 * Generate a Rust string operator call: `stele_contains(value, substr)?`
 */
export const STRING_OPERATORS: ReadonlyMap<string, string> = Object.freeze(
    new Map([
        ["contains", "stele_contains"],
        ["starts-with", "stele_starts_with"],
        ["ends-with", "stele_ends_with"],
        ["matches", "stele_matches"],
        ["trim", "stele_trim"],
        ["lower", "stele_lower"],
        ["upper", "stele_upper"],
        ["split", "stele_split"],
        ["join", "stele_join"],
    ]),
);

/**
 * Render a binary string operator call: `stele_contains(a, b)?`
 */
export function renderBinaryStringOperator(operator: string, left: string, right: string, inClosure = false): string {
    const fn = STRING_OPERATORS.get(operator);
    if (fn === undefined) {
        throw new Error(`Unknown string operator: ${operator}`);
    }
    const tryOp = inClosure ? "" : "?";
    return `${fn}(${wrapArg(left)}, ${wrapArg(right)})${tryOp}`;
}

/**
 * Render a unary string operator call: `stele_trim(a)?`
 */
export function renderUnaryStringOperator(operator: string, arg: string, inClosure = false): string {
    const fn = STRING_OPERATORS.get(operator);
    if (fn === undefined) {
        throw new Error(`Unknown string operator: ${operator}`);
    }
    const tryOp = inClosure ? "" : "?";
    return `${fn}(${wrapArg(arg)})${tryOp}`;
}
