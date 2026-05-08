import contextlib
import importlib
import logging
import re
import uuid


_STELE_MISSING = object()
# Security allowlist: only these module prefixes may be dynamically imported.
_STELE_ALLOWED_MODULES = frozenset({
    "tests.contract_scenarios",
    "tests.contract",
    "app",
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


def _is_module_allowed(module_name: str) -> bool:
    """Check if a module name is in the security allowlist."""
    for allowed in _STELE_ALLOWED_MODULES:
        if module_name == allowed or module_name.startswith(allowed + "."):
            return True
    return False


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
