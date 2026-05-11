/**
 * Arithmetic operators for the Rust backend.
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
 * Map of CDL arithmetic operator names to their Rust runtime function names.
 */
export const ARITHMETIC_OPERATORS: ReadonlyMap<string, string> = Object.freeze(
    new Map([
        ["add", "stele_add"],
        ["sub", "stele_sub"],
        ["mul", "stele_mul"],
        ["div", "stele_div"],
        ["neg", "stele_neg"],
        ["abs", "stele_abs"],
        ["mod", "stele_mod"],
        ["pow", "stele_pow"],
        ["round", "stele_round"],
        ["ceil", "stele_ceil"],
        ["floor", "stele_floor"],
    ]),
);

/**
 * Render a binary arithmetic call: `stele_add(&a, &b)?`
 */
export function renderBinaryArithmetic(operator: string, left: string, right: string, inClosure = false): string {
    const fn = ARITHMETIC_OPERATORS.get(operator);
    if (fn === undefined) {
        throw new Error(`Unknown arithmetic operator: ${operator}`);
    }
    const tryOp = inClosure ? "" : "?";
    return `${fn}(${wrapArg(left)}, ${wrapArg(right)})${tryOp}`;
}

/**
 * Render a variadic arithmetic call (add, mul): `stele_add(&a, &b, &c)?`
 */
export function renderVariadicArithmetic(operator: string, args: string[], inClosure = false): string {
    const fn = ARITHMETIC_OPERATORS.get(operator);
    if (fn === undefined) {
        throw new Error(`Unknown arithmetic operator: ${operator}`);
    }
    const tryOp = inClosure ? "" : "?";
    return `${fn}(${args.map(wrapArg).join(", ")})${tryOp}`;
}

/**
 * Render a unary arithmetic call: `stele_neg(&a)?`
 */
export function renderUnaryArithmetic(operator: string, arg: string, inClosure = false): string {
    const fn = ARITHMETIC_OPERATORS.get(operator);
    if (fn === undefined) {
        throw new Error(`Unknown arithmetic operator: ${operator}`);
    }
    const tryOp = inClosure ? "" : "?";
    return `${fn}(${wrapArg(arg)})${tryOp}`;
}
