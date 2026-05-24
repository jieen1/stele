/**
 * Conformance fixture bootstrap renderer for Java (JUnit 5).
 *
 * Renders a SteleConftest.java whose `steleContext()` method serves the parsed
 * app-state.json as a LinkedHashMap literal. If the fixture's app-state.json
 * contains a `_checkers` map, it is stripped (checker implementations are
 * injected by the conformance runner).
 *
 * Output is deterministic: map keys are sorted alphabetically, identical input
 * produces identical byte output.
 */

import { stableStringCompare } from "@stele/core";

const CHECKERS_KEY = "_checkers";

type CheckerSpec = {
  id: string;
  file: string;
  function: string;
};

export function renderSteleConftest(appState: unknown): string {
  const appStateRecord = isPlainObject(appState) ? appState : {};
  const checkers = parseCheckerSpecs(appStateRecord[CHECKERS_KEY]);
  const sanitizedAppState = stripCheckerKey(appStateRecord);
  const sortedKeys = Object.keys(sanitizedAppState).sort();

  const lines: string[] = [];
  lines.push("package contract;");
  lines.push("");
  lines.push("import java.util.*;");

  if (checkers.length > 0) {
    lines.push("import java.lang.reflect.Method;");
  }

  lines.push("");
  lines.push("public class SteleConftest {");

  if (checkers.length > 0) {
    lines.push("");
    lines.push("    static {");
    lines.push("        try {");
    for (const checker of checkers) {
      const safeName = checker.id.replace(/[^A-Za-z0-9]/g, "_");
      lines.push(`            Method ${safeName}Method = SteleConftest.class.getMethod("${checker.function}");`);
      lines.push(`            SteleRuntime.registerScenarioFunction("${checker.id}", ${safeName}Method);`);
    }
    lines.push("        } catch (NoSuchMethodException e) {");
    lines.push("            throw new RuntimeException(\"failed to register scenario function\", e);");
    lines.push("        }");
    lines.push("    }");
  }

  lines.push("");
  lines.push("    public static Map<String, Object> steleContext() {");
  lines.push("        Map<String, Object> ctx = new LinkedHashMap<>();");
  lines.push("");
  for (const key of sortedKeys) {
    lines.push(`        ctx.put("${escapeJavaString(key)}", ${jsonToJavaLiteral(sanitizedAppState[key])});`);
  }
  lines.push("");
  lines.push("        return ctx;");
  lines.push("    }");
  lines.push("");
  lines.push('    @SuppressWarnings("unchecked")');
  lines.push("    private static Map<String, Object> createMap(Object... kvs) {");
  lines.push("        Map<String, Object> map = new LinkedHashMap<>();");
  lines.push("        for (int i = 0; i < kvs.length; i += 2) {");
  lines.push("            map.put((String) kvs[i], kvs[i + 1]);");
  lines.push("        }");
  lines.push("        return map;");
  lines.push("    }");
  lines.push("}");
  lines.push("");

  return lines.join("\n");
}

function jsonToJavaLiteral(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (Number.isInteger(value)) return `${value}L`;
    return String(value);
  }
  if (typeof value === "string") return `"${escapeJavaString(value)}"`;
  if (Array.isArray(value)) {
    if (value.length === 0) return "java.util.Collections.emptyList()";
    return `Arrays.asList(${value.map((item) => jsonToJavaLiteral(item)).join(", ")})`;
  }
  if (isPlainObject(value)) {
    const sortedKeys = Object.keys(value).sort();
    const parts: string[] = [];
    for (const key of sortedKeys) {
      parts.push(`"${escapeJavaString(key)}", ${jsonToJavaLiteral((value as Record<string, unknown>)[key])}`);
    }
    return parts.length === 0 ? "new LinkedHashMap<>()" : `createMap(${parts.join(", ")})`;
  }
  return `"${escapeJavaString(String(value))}"`;
}

function escapeJavaString(value: string): string {
  let out = "";
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (char === "\\") out += "\\\\";
    else if (char === '"') out += '\\"';
    else if (char === "\n") out += "\\n";
    else if (char === "\r") out += "\\r";
    else if (char === "\t") out += "\\t";
    else if (code < 0x20 || code === 0x7f) out += `\\u${code.toString(16).padStart(4, "0")}`;
    else out += char;
  }
  return out;
}

function parseCheckerSpecs(value: unknown): CheckerSpec[] {
  if (!isPlainObject(value)) return [];
  const specs: CheckerSpec[] = [];
  for (const [id, raw] of Object.entries(value)) {
    if (typeof id !== "string" || id.length === 0) continue;
    if (!isPlainObject(raw)) continue;
    const file = typeof raw.file === "string" ? raw.file : undefined;
    const fn = typeof raw.function === "string" ? raw.function : "check";
    if (file === undefined || file.length === 0) continue;
    specs.push({ id, file, function: fn });
  }
  specs.sort((left, right) => stableStringCompare(left.id, right.id));
  return specs;
}

function stripCheckerKey(value: Record<string, unknown>): Record<string, unknown> {
  if (!(CHECKERS_KEY in value)) return value;
  const clone: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === CHECKERS_KEY) continue;
    clone[key] = entry;
  }
  return clone;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
