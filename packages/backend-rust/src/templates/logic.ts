/**
 * Logic operators for the Rust backend.
 *
 * `and`, `or`, `not` are emitted as native Rust operators
 * because they operate on boolean values and don't need runtime helpers.
 */

/**
 * Render a Rust `&&` chain for `(and expr1 expr2 ...)`.
 */
export function renderAnd(expressions: readonly string[]): string {
    if (expressions.length === 0) {
        throw new Error('Operator "and" requires at least one operand.');
    }
    return expressions.map(wrapForLogical).join(" && ");
}

/**
 * Render a Rust `||` chain for `(or expr1 expr2 ...)`.
 */
export function renderOr(expressions: readonly string[]): string {
    if (expressions.length === 0) {
        throw new Error('Operator "or" requires at least one operand.');
    }
    return expressions.map(wrapForLogical).join(" || ");
}

/**
 * Render `!expr` for `(not expr)`.
 */
export function renderNot(expression: string): string {
    return `!${wrapForLogical(expression)}`;
}

/**
 * Render `!cond || body` for `(when cond body)` — lazy semantics.
 */
export function renderWhen(condition: string, body: string): string {
    return `(!${wrapForLogical(condition)} || ${wrapForLogical(body)})`;
}

/**
 * Render `cond ? then_branch : else_branch` for `(if cond then else)`.
 */
export function renderIf(condition: string, thenBranch: string, elseBranch: string): string {
    return `if ${wrapForLogical(condition)} { ${thenBranch} } else { ${elseBranch} }`;
}

/**
 * Render `!antecedent || consequent` for `(implies antecedent consequent)`.
 */
export function renderImplies(antecedent: string, consequent: string): string {
    return `(!${wrapForLogical(antecedent)} || ${wrapForLogical(consequent)})`;
}

/**
 * Render `a == b` for `(iff a b)` — both sides must have the same truth value.
 */
export function renderIff(left: string, right: string): string {
    return `(${wrapForLogical(left)} == ${wrapForLogical(right)})`;
}

/**
 * Wrap an expression in parentheses if it contains operators.
 */
function wrapForLogical(expression: string): string {
    if (/^[A-Za-z0-9_?]+(\(.*\))?$/.test(expression)) {
        return expression;
    }
    return `(${expression})`;
}
