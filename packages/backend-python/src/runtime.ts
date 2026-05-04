export const PYTEST_RUNTIME_PATH = "tests/contract/_stele_runtime.py";

const RUNTIME_LINES = [
  "def stele_get_path(root, parts):",
  "    current = root",
  "    for part in parts:",
  "        if isinstance(current, dict) and part in current:",
  "            current = current[part]",
  "        elif hasattr(current, part):",
  "            current = getattr(current, part)",
  "        elif hasattr(current, part.replace(\"-\", \"_\")):",
  "            current = getattr(current, part.replace(\"-\", \"_\"))",
  "        else:",
  "            raise KeyError(f\"Stele path segment not found: {part}\")",
  "    return current",
  "",
  "",
  "def stele_sum(items, parts):",
  "    if parts:",
  "        return sum(stele_get_path(item, parts) for item in items)",
  "    return sum(items)",
  "",
  "",
  "def stele_call_checker(name, stele_context, kwargs):",
  "    registry = None",
  "    if isinstance(stele_context, dict):",
  "        registry = stele_context.get(\"_stele_checkers\")",
  "    else:",
  "        registry = getattr(stele_context, \"_stele_checkers\", None)",
  "    if registry is None:",
  "        raise KeyError(\"Stele checker registry not found at stele_context['_stele_checkers']\")",
  "    checker = registry.get(name)",
  "    if checker is None:",
  "        raise KeyError(f\"Stele checker not registered: {name}\")",
  "    result = checker(stele_context, **kwargs)",
  "    if isinstance(result, dict):",
  "        if \"passed\" not in result:",
  "            raise KeyError(f\"Stele checker '{name}' returned a dict without 'passed'\")",
  "        return result",
  "    return {\"passed\": bool(result), \"message\": None}",
];

const PYTHON_RUNTIME_SOURCE = `${RUNTIME_LINES.join("\n")}\n`;

export function getPythonRuntimeSource(): string {
  return PYTHON_RUNTIME_SOURCE;
}
