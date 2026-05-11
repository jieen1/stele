import type { ConformanceFixture } from "@stele/core";

/**
 * Generate a fixture-specific bootstrap file for Rust conformance testing.
 *
 * Converts `ConformanceFixture.appState` into a `stele_fixture_context()`
 * function that returns the equivalent `SteleValue` literal.
 */
export function writeFixtureBootstrap(fixture: ConformanceFixture): string {
    const lines: string[] = [];

    lines.push("#[path = \"_stele_runtime.rs\"]");
    lines.push("mod _stele_runtime;");
    lines.push("pub use _stele_runtime::SteleValue;");
    lines.push("use std::collections::BTreeMap;");
    lines.push("");
    lines.push("pub fn stele_fixture_context() -> SteleValue {");
    lines.push(`    ${jsonToSteleValueLiteral(fixture.appState)}`);
    lines.push("}");
    lines.push("");

    return lines.join("\n");
}

/**
 * Convert a JSON value to a Rust SteleValue literal.
 * Uses flat (single-line) representation for determinism.
 */
function jsonToSteleValueLiteral(value: unknown): string {
    if (value === null || value === undefined) {
        return "SteleValue::Null";
    }

    if (typeof value === "boolean") {
        return `SteleValue::Bool(${value})`;
    }

    if (typeof value === "number") {
        if (Number.isInteger(value)) {
            return `SteleValue::Int(${value})`;
        }
        return `SteleValue::Float(_stele_runtime::SteleFloat(${value}))`;
    }

    if (typeof value === "string") {
        return `SteleValue::Str(${escapeRustString(value)})`;
    }

    if (Array.isArray(value)) {
        if (value.length === 0) {
            return "SteleValue::List(vec![])";
        }
        const items = value.map((item) => jsonToSteleValueLiteral(item)).join(", ");
        return `SteleValue::List(vec![${items}])`;
    }

    if (typeof value === "object") {
        const entries = Object.entries(value as Record<string, unknown>);
        if (entries.length === 0) {
            return "SteleValue::Map(BTreeMap::new())";
        }
        const pairs = entries
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, val]) => `${escapeRustString(key)}.to_string(), ${jsonToSteleValueLiteral(val)}`)
            .join(", ");
        return `SteleValue::Map(std::collections::BTreeMap::from([${pairs}]))`;
    }

    return "SteleValue::Null";
}

/**
 * Escape a string for use in a Rust string literal.
 */
function escapeRustString(value: string): string {
    return `"${value
        .replace(/\\/g, "\\\\")
        .replace(/"/g, '\\"')
        .replace(/\n/g, "\\n")
        .replace(/\r/g, "\\r")}"`;
}

/** Alias for backend.test.ts and backend.ts import compatibility. */
export { writeFixtureBootstrap as generateFixtureBootstrapContent };
