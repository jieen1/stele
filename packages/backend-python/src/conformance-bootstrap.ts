/**
 * Conformance fixture bootstrap renderer for Python (pytest).
 *
 * Renders a conftest.py whose `stele_context` fixture serves the parsed
 * app-state.json verbatim. If the fixture's app-state.json contains a
 * `_checkers` map (id -> module:function), each checker is dynamically
 * loaded from `contract/checker_impls/<file>.py` and registered under
 * `_stele_checkers` so generated tests using `(uses-checker ...)` can
 * resolve the implementation.
 *
 * Output format example (no leading/trailing whitespace assumed):
 *
 *   import json
 *   from importlib.util import module_from_spec, spec_from_file_location
 *   from pathlib import Path
 *
 *   import pytest
 *
 *   _APP_STATE = json.loads("...")
 *
 *   def _stele_load_checker(file_name, function_name):
 *       project_root = Path(__file__).resolve().parents[2]
 *       module_path = project_root / "contract" / "checker_impls" / file_name
 *       spec = spec_from_file_location("checker_" + file_name.replace(".", "_"), module_path)
 *       assert spec is not None and spec.loader is not None
 *       module = module_from_spec(spec)
 *       spec.loader.exec_module(module)
 *       return getattr(module, function_name)
 *
 *   _CHECKERS = {
 *       "balance-change-has-transaction": _stele_load_checker("balance_change_has_transaction.py", "check"),
 *   }
 *
 *   @pytest.fixture
 *   def stele_context():
 *       state = dict(_APP_STATE)
 *       state["_stele_checkers"] = _CHECKERS
 *       return state
 *
 *   @pytest.fixture
 *   def stele_sandbox():
 *       return None
 */

import { toPythonString } from "./translation-utils.js";

const CHECKERS_KEY = "_checkers";

type CheckerSpec = {
  /** Human-readable id used by `(uses-checker <id>)` and `_stele_checkers` lookup. */
  id: string;
  /** File name in `contract/checker_impls/<file>` (e.g. "balance_change_has_transaction.py"). */
  file: string;
  /** Function name to resolve inside the checker module (e.g. "check"). */
  function: string;
};

/**
 * Render conftest.py source for a given parsed app-state.json.
 *
 * The renderer must be deterministic so that generated bootstrap is
 * stable across runs (sorted checker ids, json.dumps with sort_keys).
 */
export function renderConftest(appState: unknown): string {
  const appStateRecord = isPlainObject(appState) ? appState : {};
  const checkers = parseCheckerSpecs(appStateRecord[CHECKERS_KEY]);
  const sanitizedAppState = stripCheckerKey(appStateRecord);
  const appStateJson = JSON.stringify(sanitizedAppState ?? {});

  const lines = [
    "import json",
  ];

  if (checkers.length > 0) {
    lines.push(
      "from importlib.util import module_from_spec, spec_from_file_location",
      "from pathlib import Path",
    );
  }

  lines.push("", "import pytest", "");

  lines.push(`_APP_STATE = json.loads(${pythonStringLiteral(appStateJson)})`);

  if (checkers.length > 0) {
    lines.push(
      "",
      "",
      "def _stele_load_checker(file_name, function_name):",
      `    project_root = Path(__file__).resolve().parents[2]`,
      `    module_path = project_root / "contract" / "checker_impls" / file_name`,
      `    module_id = "stele_checker_" + file_name.replace(".", "_").replace("-", "_")`,
      "    spec = spec_from_file_location(module_id, module_path)",
      "    if spec is None or spec.loader is None:",
      `        raise ImportError("Cannot load checker module: " + str(module_path))`,
      "    module = module_from_spec(spec)",
      "    spec.loader.exec_module(module)",
      "    return getattr(module, function_name)",
      "",
      "",
      "_CHECKERS = {",
      ...checkers.map(
        (checker) =>
          `    ${pythonStringLiteral(checker.id)}: _stele_load_checker(${pythonStringLiteral(
            checker.file,
          )}, ${pythonStringLiteral(checker.function)}),`,
      ),
      "}",
    );
  }

  lines.push(
    "",
    "",
    "@pytest.fixture",
    "def stele_context():",
    "    state = dict(_APP_STATE)",
  );

  if (checkers.length > 0) {
    lines.push("    state[\"_stele_checkers\"] = _CHECKERS");
  } else {
    lines.push("    state.setdefault(\"_stele_checkers\", {})");
  }

  lines.push(
    "    return state",
    "",
    "",
    "@pytest.fixture",
    "def stele_sandbox():",
    "    return None",
    "",
  );

  return lines.join("\n");
}

function parseCheckerSpecs(value: unknown): CheckerSpec[] {
  if (!isPlainObject(value)) {
    return [];
  }

  const specs: CheckerSpec[] = [];

  for (const [id, raw] of Object.entries(value)) {
    if (typeof id !== "string" || id.length === 0) {
      continue;
    }

    if (!isPlainObject(raw)) {
      continue;
    }

    const file = typeof raw.file === "string" ? raw.file : undefined;
    const fn = typeof raw.function === "string" ? raw.function : "check";

    if (file === undefined || file.length === 0) {
      continue;
    }

    // Reject path traversal: no directory separators, no dot segments, no special chars
    if (file.includes("/") || file.includes("\\") || file.includes("..") || file.startsWith(".")) {
      continue;
    }

    // Reject function name path traversal
    if (fn.includes("/") || fn.includes("\\") || fn.includes("..")) {
      continue;
    }

    specs.push({ id, file, function: fn });
  }

  specs.sort((left, right) => left.id.localeCompare(right.id));
  return specs;
}

function stripCheckerKey(value: Record<string, unknown>): Record<string, unknown> {
  if (!(CHECKERS_KEY in value)) {
    return value;
  }

  const clone: Record<string, unknown> = {};

  for (const [key, entry] of Object.entries(value)) {
    if (key === CHECKERS_KEY) {
      continue;
    }

    clone[key] = entry;
  }

  return clone;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Build a Python string literal that round-trips an arbitrary JS string.
 *
 * Uses double-quoted form with a small escape table; this keeps the rendered
 * conftest.py deterministic and avoids quoting issues with embedded JSON.
 */
function pythonStringLiteral(value: string): string {
  return toPythonString(value);
}
