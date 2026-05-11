/**
 * Temporal operators for the Rust backend.
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
 * Render `stele_is_modified(&ctx, &segments)?`.
 */
export function renderModified(context: string, pathSegments: string[]): string {
    return `stele_is_modified(&${context}, &[${pathSegments.map(rustStringLiteral).join(", ")}])`;
}

/**
 * Render `stele_state_before(&ctx)`.
 */
export function renderStateBefore(context: string): string {
    return `stele_state_before(&${context})`;
}

/**
 * Render `stele_state_after(&ctx)`.
 */
export function renderStateAfter(context: string): string {
    return `stele_state_after(&${context})`;
}

/**
 * Render `stele_within(&event, &duration)?`.
 */
export function renderWithin(event: string, duration: string, inClosure = false): string {
    const tryOp = inClosure ? "" : "?";
    return `stele_within(${wrapArg(event)}, ${wrapArg(duration)})${tryOp}`;
}

/**
 * Render `stele_before(&a, &b)?` / `stele_after(&a, &b)?`.
 */
export function renderTemporalBinary(operator: string, left: string, right: string, inClosure = false): string {
    const tryOp = inClosure ? "" : "?";
    return `stele_${operator}(${wrapArg(left)}, ${wrapArg(right)})${tryOp}`;
}

function rustStringLiteral(value: string): string {
    return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
