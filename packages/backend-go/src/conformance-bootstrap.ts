import type { ConformanceFixture } from "@stele/core";

/**
 * Generate a setup_test.go file for conformance testing.
 *
 * Converts fixture.appState (a JSON map) into Go literals embedded in
 * SetupSteleContext(). Mirrors design doc §8.3.
 */
export function writeFixtureBootstrap(fixture: ConformanceFixture): { name: string; content: string } {
  const lines: string[] = [];
  lines.push("// setup_test.go (auto-generated for conformance testing; do not edit)");
  lines.push("package contract_test");
  lines.push("");
  lines.push("");
  lines.push("func SetupSteleContext() *SteleContext {");
  lines.push("\tctx := NewContext()");

  const appState = fixture.appState as Record<string, unknown> | undefined;
  if (appState && typeof appState === "object" && !Array.isArray(appState)) {
    for (const [key, value] of Object.entries(appState)) {
      const goLiteral = toGoLiteral(value);
      lines.push(`\tctx.Data["${escapeGoString(key)}"] = ${goLiteral}`);
    }
  }

  lines.push("\treturn ctx");
  lines.push("}");
  lines.push("");

  return {
    name: "setup_test.go",
    content: lines.join("\n"),
  };
}

/**
 * Convert a JSON value to a Go literal expression.
 * Handles primitives, arrays, objects, and nested structures.
 */
function toGoLiteral(value: unknown): string {
  if (value === null || value === undefined) {
    return "nil";
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (typeof value === "number") {
    if (Number.isInteger(value)) {
      return String(value);
    }
    return `float64(${value})`;
  }
  if (typeof value === "string") {
    return goQuotedString(value);
  }
  if (Array.isArray(value)) {
    return toGoSlice(value);
  }
  if (typeof value === "object") {
    return toGoMap(value as Record<string, unknown>);
  }
  return "nil";
}

function toGoSlice(items: unknown[]): string {
  if (items.length === 0) {
    return "[]any{}";
  }
  const elems = items.map((item) => toGoLiteral(item)).join(", ");
  return `[]any{${elems}}`;
}

function toGoMap(obj: Record<string, unknown>): string {
  if (Object.keys(obj).length === 0) {
    return "map[string]any{}";
  }
  const entries = Object.entries(obj)
    .map(([k, v]) => `\t\t"${escapeGoString(k)}": ${toGoLiteral(v)}`)
    .join(",\n");
  return `map[string]any{\n${entries}\n\t}`;
}

function goQuotedString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\t/g, "\\t")}"`;
}

function escapeGoString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
