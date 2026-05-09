import contextlib
import importlib
import logging
import math
import os
import re
import uuid


class SteleRuntimeError(RuntimeError):
    """Raised when a generated contract assertion violates a runtime invariant.

    Mirrors the TypeScript backend's SteleRuntimeError so the cross-backend
    error semantics for new EP04 operators stay byte-equal at the level of
    error class + message format.
    """


_STELE_MISSING = object()
# Security allowlist: only these module prefixes may be dynamically imported by
# user-facing scenario / checker / code-shape paths. EP06 split: this is the
# user-visible surface; do NOT add stdlib modules like importlib here or user
# scenario steps could re-import arbitrary modules and bypass the allowlist.
_STELE_USER_ALLOWED_MODULES = frozenset({
    "tests.contract_scenarios",
    "tests.contract",
    "app",
})

# Backwards-compatible alias; pre-EP06 callers used this name. Kept identical
# to the user-facing list so existing imports (and runtime tests) keep working.
_STELE_ALLOWED_MODULES = _STELE_USER_ALLOWED_MODULES

# EP06 internal allowlist: Stele runtime helpers themselves use these stdlib
# modules. User code can NOT import from this set via scenario / checker
# pathways — this list is documentation + a guard against future refactors
# that try to merge the two allowlists.
_STELE_INTERNAL_ALLOWED_MODULES = frozenset({
    "importlib",
    "inspect",
    "ast",
    "glob",
    "typing",
    "re",
    "decimal",
})

# Security blocklist: these modules are never permitted, regardless of allowlist.
_STELE_BLOCKED_MODULES = frozenset({
    "os", "sys", "subprocess", "shutil", "ctypes", "socket",
    "http.server", "http", "socketserver", "threading", "thread",
    "multiprocessing", "pty", "pexpect", "signal", "fcntl",
})

_STELE_MODULE_RE = re.compile(r"^[a-zA-Z_][a-zA-Z0-9_]*(\.[a-zA-Z_][a-zA-Z0-9_]*)*$")
_stele_logger = logging.getLogger(__name__)


def stele_get_path(root, parts):
    current = root
    for part in parts:
        if isinstance(current, dict) and part in current:
            current = current[part]
        elif hasattr(current, part):
            current = getattr(current, part)
        elif hasattr(current, part.replace("-", "_")):
            current = getattr(current, part.replace("-", "_"))
        else:
            raise KeyError(f"Stele path segment not found: {part}")
    return current


def stele_is_modified(stele_context, parts):
    before_value = _stele_read_optional_path(stele_context["state-before"], parts)
    after_value = _stele_read_optional_path(stele_context["state-after"], parts)
    if before_value is _STELE_MISSING or after_value is _STELE_MISSING:
        return before_value is not after_value
    return before_value != after_value


def stele_sum(items, parts):
    if parts:
        return sum(stele_get_path(item, parts) for item in items)
    return sum(items)


def stele_call_checker(name, stele_context, kwargs):
    registry = None
    if isinstance(stele_context, dict):
        registry = stele_context.get("_stele_checkers")
    else:
        registry = getattr(stele_context, "_stele_checkers", None)
    if registry is None:
        raise KeyError("Stele checker registry not found at stele_context['_stele_checkers']")
    checker = registry.get(name)
    if checker is None:
        raise KeyError(f"Stele checker not registered: {name}")
    result = checker(stele_context, **kwargs)
    if isinstance(result, dict):
        if "passed" not in result:
            raise KeyError(f"Stele checker '{name}' returned a dict without 'passed'")
        return result
    return {"passed": bool(result), "message": None}


def stele_merge_contexts(*contexts):
    merged = {}
    for context in contexts:
        if context is None:
            continue
        if not isinstance(context, dict):
            raise TypeError("Stele contexts must be dict-like mappings for the Python runtime")
        merged = {**merged, **context}
    return merged


def stele_run_scenario(scenario, stele_context, stele_sandbox):
    with _stele_open_sandbox(stele_sandbox):
        scenario_context = {}
        for step in scenario["steps"]:
            body = _stele_resolve_scenario_value(
                step.get("call", {}).get("body", {}), stele_context, scenario_context
            )
            result = _stele_call_python_import(
                step["call"]["target"],
                body,
                stele_merge_contexts(stele_context, scenario_context),
            )
            if step["kind"] == "step":
                capture_name = step.get("capture")
                if capture_name:
                    scenario_context[capture_name] = result
                continue
            if step["kind"] == "capture-state":
                scenario_context[step["capture"]] = result
                continue
            raise KeyError(f"Unsupported Stele scenario step kind: {step['kind']}")
        return scenario_context


def _stele_user_module_allowed(module_name: str) -> bool:
    """EP06: explicit name for the user-facing allowlist check.

    Used by scenario step / checker / code-shape resolution. Returns True only
    when the module sits inside (or matches exactly) one of the user-allowed
    prefixes.
    """
    for allowed in _STELE_USER_ALLOWED_MODULES:
        if module_name == allowed or module_name.startswith(allowed + "."):
            return True
    return False


def _is_module_allowed(module_name: str) -> bool:
    """Backwards-compatible alias kept for existing scenario plumbing."""
    return _stele_user_module_allowed(module_name)


def _is_module_blocked(module_name: str) -> bool:
    """Check if any component of the module path hits the security blocklist."""
    parts = module_name.split(".")
    for part in parts:
        if part in _STELE_BLOCKED_MODULES:
            return True
    return False


def _stele_call_python_import(target, body, stele_context):
    module_name, function_name = _stele_parse_python_import_target(target)
    if _is_module_blocked(module_name):
        _stele_logger.warning("Rejected blocked python-import module: %r", module_name)
        raise ValueError(f"Blocked module in python-import target: {module_name!r}")
    if not _is_module_allowed(module_name):
        _stele_logger.warning("Rejected unlisted python-import module: %r", module_name)
        raise ValueError(f"Module not in allowlist: {module_name!r}")
    if not _STELE_MODULE_RE.match(module_name):
        _stele_logger.warning("Rejected unsafe python-import module name: %r", module_name)
        raise ValueError(f"Unsafe module name in python-import target: {module_name!r}")
    module = importlib.import_module(module_name)
    function = getattr(module, function_name, None)
    if function is None or not callable(function):
        raise AttributeError(f"Stele scenario function not found or not callable: {target}")
    return function(body, stele_context)


def _stele_parse_python_import_target(target):
    if not isinstance(target, str) or ":" not in target:
        raise ValueError("python-import targets must use the module:function format")
    module_name, function_name = target.split(":", 1)
    if not module_name or not function_name:
        raise ValueError("python-import targets must use the module:function format")
    return module_name, function_name


def _stele_open_sandbox(stele_sandbox):
    if hasattr(stele_sandbox, "__enter__") and hasattr(stele_sandbox, "__exit__"):
        return stele_sandbox
    if callable(stele_sandbox):
        candidate = stele_sandbox()
        if hasattr(candidate, "__enter__") and hasattr(candidate, "__exit__"):
            return candidate
        return contextlib.nullcontext(candidate)
    return contextlib.nullcontext(stele_sandbox)


def _stele_resolve_scenario_value(value, stele_context, scenario_context):
    if isinstance(value, dict):
        if "$ref" in value:
            ref_parts = value["$ref"]
            if not isinstance(ref_parts, (list, tuple)) or len(ref_parts) == 0:
                raise KeyError(f"$ref must be a non-empty list, got {ref_parts!r}")
            base = scenario_context[ref_parts[0]]
            return base if len(ref_parts) == 1 else stele_get_path(base, ref_parts[1:])
        if "$gen" in value:
            return _stele_generate_value(value["$gen"])
        return {
            key: _stele_resolve_scenario_value(item, stele_context, scenario_context)
            for key, item in value.items()
        }
    if isinstance(value, list):
        return [_stele_resolve_scenario_value(item, stele_context, scenario_context) for item in value]
    return value


def _stele_generate_value(spec):
    kind = spec.get("kind")
    if kind == "unique-name":
        prefix = spec.get("prefix", "value")
        return f"{prefix}-{uuid.uuid4().hex[:12]}"
    raise KeyError(f"Unsupported Stele scenario generator: {kind}")


def _stele_read_optional_path(root, parts):
    try:
        return stele_get_path(root, parts)
    except KeyError:
        return _STELE_MISSING


# ---------------------------------------------------------------------------
# EP04 batch 1: collection / arithmetic / string / data access / FP helpers
# ---------------------------------------------------------------------------


def _stele_assert_collection(label, value):
    if not isinstance(value, (list, tuple)):
        raise SteleRuntimeError(
            f"{label}: expected collection, got {type(value).__name__}"
        )
    return value


def _stele_assert_number(label, value):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise SteleRuntimeError(
            f"{label}: expected number, got {type(value).__name__}"
        )
    return value


def _stele_assert_string(label, value):
    if not isinstance(value, str):
        raise SteleRuntimeError(
            f"{label}: expected string, got {type(value).__name__}"
        )
    return value


def stele_length(coll):
    """Return collection length. Empty -> 0; non-collection -> SteleRuntimeError."""
    return len(_stele_assert_collection("length", coll))


def stele_concat(*colls):
    """Flat concatenation of one or more collections; preserves duplicates and order."""
    if len(colls) < 1:
        raise SteleRuntimeError("concat: expected at least one collection operand")
    out = []
    for index, coll in enumerate(colls):
        items = _stele_assert_collection(f"concat[{index}]", coll)
        out.extend(items)
    return out


def _stele_sort_key(label, items, parts):
    """Project sort key from path; returns (rank, key) tuples for stable sort."""
    out = []
    for index, item in enumerate(items):
        try:
            key = stele_get_path(item, parts) if parts else item
        except KeyError:
            key = None
        out.append((index, key))
    return out


def _stele_sort_rank(value):
    """Map (rank, value) pairs into a totally orderable key with required ordering.

    Ranks (smaller sorts earlier in ascending):
      0: NaN (always first)
      1: numbers / strings with totally orderable secondary key
      2: null/undefined (always last)
    """
    if value is None:
        return (2, 0, 0)
    if isinstance(value, float) and math.isnan(value):
        return (0, 0, 0)
    if isinstance(value, bool):
        # Treat booleans as numbers (False=0, True=1) for ordering parity with TS.
        return (1, 0, int(value))
    if isinstance(value, (int, float)):
        return (1, 0, value)
    if isinstance(value, str):
        # Lexicographic byte order via UTF-8 encoding; locale-independent.
        return (1, 1, value.encode("utf-8"))
    # Fall back: cast to string for stable ordering of unknown values.
    return (1, 2, repr(value))


def stele_sort_by(coll, parts):
    """Stable ascending sort by a path projection.

    Order: NaN -> numbers/strings (lexicographic UTF-8 byte order) -> null.
    """
    items = list(_stele_assert_collection("sort-by", coll))
    keyed = _stele_sort_key("sort-by", items, parts)
    keyed.sort(key=lambda entry: (_stele_sort_rank(entry[1]), entry[0]))
    return [items[index] for index, _ in keyed]


def stele_sort_by_desc(coll, parts):
    """Stable descending sort by a path projection.

    Order: numbers/strings (descending) -> NaN -> null.
    """
    items = list(_stele_assert_collection("sort-by-desc", coll))
    # Stable descending: invert each rank field while keeping the original
    # index ascending so equal keys preserve insertion order.
    keyed = _stele_sort_key("sort-by-desc", items, parts)

    def _desc_key(entry):
        original_index, value = entry
        rank = _stele_sort_rank(value)
        # NaN -> always first means after inversion it must be largest; null ->
        # always last means after inversion it must be smallest.
        if rank[0] == 0:
            primary = 0
            secondary = (0, 0)
        elif rank[0] == 2:
            primary = 2
            secondary = (0, 0)
        else:
            primary = 1
            kind = rank[1]
            payload = rank[2]
            if kind == 0:
                # numeric -> negate
                secondary = (0, -payload if isinstance(payload, (int, float)) else 0)
            elif kind == 1:
                # bytes -> reverse via tuple of negated codepoints
                secondary = (1, tuple(-b for b in payload))
            else:
                secondary = (2, "".join(chr(0x10FFFF - ord(c)) if ord(c) <= 0x10FFFE else c for c in payload))
        return (primary, secondary, original_index)

    keyed.sort(key=_desc_key)
    return [items[index] for index, _ in keyed]


def stele_pow(base, exponent):
    """IEEE-754 double power; negative base + non-integer exponent yields NaN."""
    base_n = _stele_assert_number("pow", base)
    exp_n = _stele_assert_number("pow", exponent)
    try:
        result = math.pow(base_n, exp_n)
    except ValueError:
        # math.pow raises ValueError for negative base + non-integer exponent;
        # cross-backend semantics require NaN instead of an exception.
        return float("nan")
    return result


def stele_round(value, digits=0):
    """Banker's rounding (half to even); Python 3's built-in round is correct.

    NaN / +inf / -inf propagate without error so the cross-backend behavior
    matches the TypeScript helper.
    """
    value_n = _stele_assert_number("round", value)
    digits_n = _stele_assert_number("round", digits)
    if isinstance(digits_n, float) and not digits_n.is_integer():
        raise SteleRuntimeError(
            "round: digits must be an integer-valued number"
        )
    if isinstance(value_n, float) and (math.isnan(value_n) or math.isinf(value_n)):
        return value_n
    return round(value_n, int(digits_n))


def stele_split(s, sep):
    """Split a string by a literal separator. Empty separator -> SteleRuntimeError."""
    s_n = _stele_assert_string("split", s)
    sep_n = _stele_assert_string("split", sep)
    if sep_n == "":
        raise SteleRuntimeError("split: separator cannot be empty")
    return s_n.split(sep_n)


def stele_type_of(value):
    """Return one of: number, string, boolean, collection, object, null, undefined.

    Cross-backend mapping:
      - Python None -> "null" (Python has no separate "undefined")
      - bool checked before int because bool is a subclass of int in Python
      - list/tuple -> "collection"
      - dict / other objects -> "object"
    """
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, (int, float)):
        return "number"
    if isinstance(value, str):
        return "string"
    if isinstance(value, (list, tuple)):
        return "collection"
    return "object"


def stele_map(coll, parts):
    """Project each item by a path; missing paths skipped silently."""
    items = _stele_assert_collection("map", coll)
    if not parts:
        return list(items)
    out = []
    for item in items:
        try:
            out.append(stele_get_path(item, parts))
        except KeyError:
            # Spec: missing-path elements are skipped silently (different from forall).
            continue
    return out


def stele_first(coll):
    """Return first element; empty collection -> SteleRuntimeError."""
    items = _stele_assert_collection("first", coll)
    if len(items) == 0:
        raise SteleRuntimeError("first: cannot read first element of empty collection")
    return items[0]


def stele_last(coll):
    """Return last element; empty collection -> SteleRuntimeError."""
    items = _stele_assert_collection("last", coll)
    if len(items) == 0:
        raise SteleRuntimeError("last: cannot read last element of empty collection")
    return items[-1]


def stele_join(coll, sep):
    """Join a collection of strings with a separator; mixed types raise."""
    items = _stele_assert_collection("join", coll)
    sep_n = _stele_assert_string("join", sep)
    for index, item in enumerate(items):
        if not isinstance(item, str):
            raise SteleRuntimeError(
                f"join: collection element at index {index} is not a string (got {type(item).__name__})"
            )
    return sep_n.join(items)


def stele_mod(left, right):
    """Sign-of-divisor modulo (Python semantics). Divisor of zero -> SteleRuntimeError."""
    left_n = _stele_assert_number("mod", left)
    right_n = _stele_assert_number("mod", right)
    if right_n == 0:
        raise SteleRuntimeError("mod: divisor cannot be zero")
    return left_n % right_n


def stele_ceil(value):
    """Round toward positive infinity; NaN propagates."""
    value_n = _stele_assert_number("ceil", value)
    if isinstance(value_n, float) and math.isnan(value_n):
        return float("nan")
    return math.ceil(value_n)


def stele_floor(value):
    """Round toward negative infinity; NaN propagates."""
    value_n = _stele_assert_number("floor", value)
    if isinstance(value_n, float) and math.isnan(value_n):
        return float("nan")
    return math.floor(value_n)


def stele_trim(value):
    """Strip Unicode whitespace from both ends. Mirrors JS String.prototype.trim."""
    value_n = _stele_assert_string("trim", value)
    # Use a Unicode-aware regex for parity with JS String.trim semantics.
    return re.sub(r"^\s+|\s+$", "", value_n, flags=re.UNICODE)


def stele_lower(value):
    """Locale-independent Unicode lowercase."""
    return _stele_assert_string("lower", value).lower()


def stele_upper(value):
    """Locale-independent Unicode uppercase."""
    return _stele_assert_string("upper", value).upper()


# ---------------------------------------------------------------------------
# EP06: Code Shape runtime helpers
#
# These helpers back the pytest assertions emitted for boundary / class-shape /
# function-shape / type-policy / file-policy declarations. They live in this
# module so they share the same module allowlist split (user vs internal) as
# the rest of the runtime — see _STELE_USER_ALLOWED_MODULES / _STELE_INTERNAL_*.
# ---------------------------------------------------------------------------


def _stele_split_qualified(qualified_name: str):
    """Split "a.b.C" into ("a.b", "C"); raise on un-dotted input."""
    if not isinstance(qualified_name, str) or qualified_name == "":
        raise SteleRuntimeError(
            f"code-shape: qualified name must be a non-empty string, got {qualified_name!r}"
        )
    module_name, separator, class_name = qualified_name.rpartition(".")
    if separator == "" or module_name == "" or class_name == "":
        raise SteleRuntimeError(
            f"code-shape: qualified name must be of the form 'module.Symbol', got {qualified_name!r}"
        )
    return module_name, class_name


def stele_resolve_class(qualified_name: str):
    """Resolve a class via importlib; obeys the user-facing module allowlist.

    The resolver itself is Stele-internal (uses importlib directly), but the
    *target* module the user references must satisfy the user allowlist —
    otherwise a contract could probe arbitrary stdlib internals via
    code-shape declarations.
    """
    module_name, class_name = _stele_split_qualified(qualified_name)
    if not _stele_user_module_allowed(module_name):
        raise SteleRuntimeError(
            f"code-shape: class resolution blocked by allowlist: {module_name!r} "
            f"is not under any of {sorted(_STELE_USER_ALLOWED_MODULES)}"
        )
    if _is_module_blocked(module_name):
        raise SteleRuntimeError(
            f"code-shape: class resolution blocked: {module_name!r} is on the blocklist"
        )
    if not _STELE_MODULE_RE.match(module_name):
        raise SteleRuntimeError(
            f"code-shape: unsafe module name {module_name!r}"
        )
    try:
        module = importlib.import_module(module_name)
    except ImportError as error:
        raise SteleRuntimeError(
            f"code-shape: failed to import module {module_name!r}: {error}"
        )
    target = getattr(module, class_name, None)
    if target is None:
        raise SteleRuntimeError(
            f"code-shape: module {module_name!r} has no attribute {class_name!r}"
        )
    return target


def stele_resolve_function(qualified_name: str):
    """Resolve a callable via stele_resolve_class; require callable() target."""
    target = stele_resolve_class(qualified_name)
    if not callable(target):
        raise SteleRuntimeError(
            f"code-shape: {qualified_name!r} resolved to a non-callable {type(target).__name__}"
        )
    return target


def stele_get_type_hints(obj):
    """Wrapper around typing.get_type_hints; swallow Exception → empty dict.

    typing.get_type_hints can fail for forward references, partially-evaluated
    annotations, or modules that lack required imports. Code-shape checks
    treat such failures as "no hint available" rather than propagating, so the
    pytest assertion still produces a usable error message.
    """
    try:
        import typing
        return typing.get_type_hints(obj)
    except Exception:
        return {}


def stele_get_class_fields(cls):
    """Return dict[name, type] of class field hints; empty dict on failure.

    Reads typing.get_type_hints for dataclass-style and pydantic-style fields
    plus plain class annotations. Bare attributes without annotations are
    omitted by design — type-policy checks should target annotated fields.
    """
    return stele_get_type_hints(cls)


def stele_type_matches(actual_type, expected_name: str) -> bool:
    """Compare a Python type against a CDL type name.

    Recognised CDL names:
      - "Number"  -> int / float (excluding bool, which is an int subclass) /
                     decimal.Decimal when importable
      - "String"  -> str
      - "Boolean" -> bool
      - any other -> compared by getattr(actual_type, "__name__", None)
    """
    if expected_name == "Number":
        if actual_type is bool:
            return False
        if actual_type in (int, float):
            return True
        try:
            from decimal import Decimal
            if actual_type is Decimal:
                return True
        except ImportError:
            pass
        return False
    if expected_name == "String":
        return actual_type is str
    if expected_name == "Boolean":
        return actual_type is bool
    return getattr(actual_type, "__name__", None) == expected_name


def stele_has_field(cls, field_name: str, expected_type=None) -> bool:
    """Check that cls advertises field_name (attr or annotated hint).

    When expected_type is provided, the annotation must satisfy
    stele_type_matches(actual, expected_type); a bare attribute without a
    hint counts as a type mismatch in that case.
    """
    hints = stele_get_type_hints(cls)
    has_attr = hasattr(cls, field_name)
    has_hint = field_name in hints
    if not (has_attr or has_hint):
        return False
    if expected_type is None:
        return True
    if not has_hint:
        return False
    return stele_type_matches(hints[field_name], expected_type)


def stele_has_callable(cls, method_name: str) -> bool:
    """Return True when cls.method_name exists and is callable."""
    return callable(getattr(cls, method_name, None))


def stele_glob(pattern: str):
    """Return a sorted list of files matching a recursive glob pattern."""
    if not isinstance(pattern, str):
        raise SteleRuntimeError(
            f"code-shape: glob pattern must be a string, got {type(pattern).__name__}"
        )
    import glob as _glob_module
    return sorted(_glob_module.glob(pattern, recursive=True))


def _stele_project_root() -> str:
    """Compute the project root used for stele_read_file's confinement check."""
    return os.path.realpath(os.getcwd())


def stele_read_file(filepath: str) -> str:
    """Read a project file as UTF-8 text; reject paths outside the project root.

    The realpath check defends against symlinks pointing outside the project
    (e.g. /etc/passwd) — a contract could otherwise ask file-policy to read
    arbitrary host files via a crafted symlink in the workspace.
    """
    if not isinstance(filepath, str) or filepath == "":
        raise SteleRuntimeError(
            f"code-shape: read_file path must be a non-empty string, got {filepath!r}"
        )
    project_root = _stele_project_root()
    real_path = os.path.realpath(filepath)
    if real_path != project_root and not real_path.startswith(project_root + os.sep):
        raise SteleRuntimeError(
            f"code-shape: refusing to read outside project root: {filepath!r} -> {real_path!r}"
        )
    with open(real_path, "r", encoding="utf-8") as handle:
        return handle.read()


def stele_collect_imports(filepath: str):
    """Return a set of imported module names found in a Python source file."""
    import ast as _ast_module
    text = stele_read_file(filepath)
    try:
        tree = _ast_module.parse(text, filepath)
    except SyntaxError as error:
        raise SteleRuntimeError(
            f"code-shape: failed to parse {filepath!r}: {error}"
        )
    imports = set()
    for node in _ast_module.walk(tree):
        if isinstance(node, _ast_module.Import):
            for alias in node.names:
                imports.add(alias.name)
        elif isinstance(node, _ast_module.ImportFrom):
            if node.module:
                imports.add(node.module)
    return imports


def _stele_glob_match(text: str, pattern: str) -> bool:
    """Match `text` against a literal/'*' pattern. Anchored at both ends."""
    regex = "^" + re.escape(pattern).replace(r"\*", ".*") + "$"
    return re.match(regex, text) is not None


def stele_import_allowed(imp: str, allowed=None, forbidden=None) -> bool:
    """Decide whether imp passes a boundary's allow/forbid policy.

    forbidden patterns short-circuit the decision; an empty allowed list
    means "no positive list — only forbidden matters". A non-empty allowed
    list requires the import to match at least one entry. Patterns support
    only the '*' wildcard (translated to '.*' in regex space).
    """
    forbidden = list(forbidden or [])
    allowed = list(allowed or [])
    for pattern in forbidden:
        if _stele_glob_match(imp, pattern):
            return False
    if not allowed:
        return True
    return any(_stele_glob_match(imp, pattern) for pattern in allowed)
