"""Unit tests for _stele_runtime.py -- security-critical runtime with dynamic import execution."""
import contextlib
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent / "src" / "runtime"))

from _stele_runtime import (
    _STELE_ALLOWED_MODULES,
    _STELE_BLOCKED_MODULES,
    _STELE_MISSING,
    _is_module_allowed,
    _is_module_blocked,
    _stele_call_python_import,
    _stele_generate_value,
    _stele_open_sandbox,
    _stele_parse_python_import_target,
    _stele_read_optional_path,
    _stele_resolve_scenario_value,
    stele_call_checker,
    stele_get_path,
    stele_is_modified,
    stele_merge_contexts,
    stele_run_scenario,
    stele_sum,
)


# ──────────────────────────── stele_get_path ────────────────────────────


class TestSteleGetPath:
    """Dict path traversal, attribute access, hyphen-to-underscore fallback, KeyError on missing."""

    def test_simple_dict_traversal(self):
        result = stele_get_path({"a": {"b": 42}}, ["a", "b"])
        assert result == 42

    def test_nested_dict_traversal(self):
        root = {"a": {"b": {"c": {"d": "deep"}}}}
        assert stele_get_path(root, ["a", "b", "c", "d"]) == "deep"

    def test_empty_parts_returns_root(self):
        root = {"a": 1}
        assert stele_get_path(root, []) == root

    def test_attribute_access(self):
        class Obj:
            x = 99

        assert stele_get_path(Obj(), ["x"]) == 99

    def test_hyphen_to_underscore_fallback(self):
        class Obj:
            pass

        obj = Obj()
        obj.foo_bar = 42
        assert stele_get_path(obj, ["foo-bar"]) == 42

    def test_key_error_on_missing_dict_key(self):
        with pytest.raises(KeyError, match="not_found"):
            stele_get_path({"a": 1}, ["not_found"])

    def test_key_error_on_missing_attribute(self):
        class Obj:
            pass

        with pytest.raises(KeyError, match="missing"):
            stele_get_path(Obj(), ["missing"])

    def test_hyphen_fallback_only_when_no_exact_match(self):
        """When the exact attribute exists, hyphen-to-underscore is NOT used."""

        class Obj:
            foo_bar = 10
            foo = 20

        # Asking for "foo" finds attribute "foo" (no fallback needed)
        assert stele_get_path(Obj(), ["foo"]) == 20

    def test_mixed_dict_and_attribute_access(self):
        class Obj:
            value = 3

        root = {"outer": Obj()}
        assert stele_get_path(root, ["outer", "value"]) == 3


# ─────────────────────────── stele_read_optional_path ──────────────────


class TestSteleReadOptionalPath:
    """Internal helper used by stele_is_modified."""

    def test_existing_path(self):
        assert _stele_read_optional_path({"a": {"b": 1}}, ["a", "b"]) == 1

    def test_missing_path_returns_MISSING(self):
        assert _stele_read_optional_path({"a": 1}, ["x", "y"]) is _STELE_MISSING

    def test_empty_parts_returns_root(self):
        root = {}
        assert _stele_read_optional_path(root, []) is root

    def test_partial_path_missing(self):
        root = {"a": {"b": 2}}
        assert _stele_read_optional_path(root, ["a", "c"]) is _STELE_MISSING


# ─────────────────────────── stele_is_modified ─────────────────────────


class TestSteleIsModified:
    """Before/after different, same, both missing, one missing, nested paths."""

    def test_values_different(self):
        ctx = {"state-before": {"a": 1}, "state-after": {"a": 2}}
        assert stele_is_modified(ctx, ["a"]) is True

    def test_values_same(self):
        ctx = {"state-before": {"a": 1}, "state-after": {"a": 1}}
        assert stele_is_modified(ctx, ["a"]) is False

    def test_both_missing(self):
        ctx = {"state-before": {}, "state-after": {}}
        assert stele_is_modified(ctx, ["a"]) is False

    def test_before_missing_after_present(self):
        ctx = {"state-before": {}, "state-after": {"a": 1}}
        assert stele_is_modified(ctx, ["a"]) is True

    def test_before_present_after_missing(self):
        ctx = {"state-before": {"a": 1}, "state-after": {}}
        assert stele_is_modified(ctx, ["a"]) is True

    def test_nested_path(self):
        ctx = {
            "state-before": {"x": {"y": {"z": 1}}},
            "state-after": {"x": {"y": {"z": 2}}},
        }
        assert stele_is_modified(ctx, ["x", "y", "z"]) is True

    def test_nested_path_same(self):
        ctx = {
            "state-before": {"x": {"y": 3}},
            "state-after": {"x": {"y": 3}},
        }
        assert stele_is_modified(ctx, ["x", "y"]) is False


# ──────────────────────────── stele_sum ─────────────────────────────────


class TestSteleSum:
    """Items with parts, items without parts, empty collection."""

    def test_sum_with_parts(self):
        items = [{"n": 1}, {"n": 2}, {"n": 3}]
        assert stele_sum(items, ["n"]) == 6

    def test_sum_without_parts(self):
        items = [1, 2, 3]
        assert stele_sum(items, []) == 6

    def test_empty_collection_with_parts(self):
        assert stele_sum([], ["x"]) == 0

    def test_empty_collection_without_parts(self):
        assert stele_sum([], []) == 0

    def test_nested_parts(self):
        items = [{"a": {"b": 10}}, {"a": {"b": 20}}]
        assert stele_sum(items, ["a", "b"]) == 30

    def test_single_item(self):
        assert stele_sum([{"v": 5}], ["v"]) == 5


# ───────────────────────── stele_call_checker ──────────────────────────


class TestSteleCallChecker:
    """Dict result with passed, dict without passed, non-dict result, missing registry, missing checker."""

    def test_dict_result_with_passed(self):
        checker = lambda ctx, x: {"passed": True, "message": "ok"}
        ctx = {"_stele_checkers": {"chk": checker}}
        result = stele_call_checker("chk", ctx, {"x": 1})
        assert result == {"passed": True, "message": "ok"}

    def test_dict_result_without_passed_raises(self):
        checker = lambda ctx: {"message": "nope"}
        ctx = {"_stele_checkers": {"chk": checker}}
        with pytest.raises(KeyError, match="without 'passed'"):
            stele_call_checker("chk", ctx, {})

    def test_non_dict_result_wrapped(self):
        checker = lambda ctx, v: True
        ctx = {"_stele_checkers": {"chk": checker}}
        result = stele_call_checker("chk", ctx, {"v": 1})
        assert result == {"passed": True, "message": None}

    def test_non_dict_false_result_wrapped(self):
        checker = lambda ctx: False
        ctx = {"_stele_checkers": {"chk": checker}}
        result = stele_call_checker("chk", ctx, {})
        assert result == {"passed": False, "message": None}

    def test_missing_registry_raises(self):
        ctx = {}
        with pytest.raises(KeyError, match="registry not found"):
            stele_call_checker("chk", ctx, {})

    def test_missing_checker_raises(self):
        ctx = {"_stele_checkers": {}}
        with pytest.raises(KeyError, match="not registered"):
            stele_call_checker("chk", ctx, {})

    def test_registry_on_object_attribute(self):
        """Checker registry can also be an object attribute."""
        ctx_obj = type("Ctx", (), {"_stele_checkers": {"chk": lambda c: True}})()
        result = stele_call_checker("chk", ctx_obj, {})
        assert result == {"passed": True, "message": None}


# ───────────────────────── stele_merge_contexts ────────────────────────


class TestSteleMergeContexts:
    """Multiple dicts, None handling, non-dict error, empty merge."""

    def test_merge_multiple_dicts(self):
        result = stele_merge_contexts({"a": 1}, {"b": 2}, {"c": 3})
        assert result == {"a": 1, "b": 2, "c": 3}

    def test_later_dicts_overwrite_earlier(self):
        result = stele_merge_contexts({"a": 1}, {"a": 2})
        assert result == {"a": 2}

    def test_none_skipped(self):
        result = stele_merge_contexts(None, {"a": 1}, None)
        assert result == {"a": 1}

    def test_all_none(self):
        result = stele_merge_contexts(None, None)
        assert result == {}

    def test_non_dict_raises(self):
        with pytest.raises(TypeError, match="must be dict-like"):
            stele_merge_contexts("not a dict")

    def test_empty_merge(self):
        assert stele_merge_contexts() == {}


# ────────────────────────── stele_run_scenario ────────────────────────


@pytest.fixture
def mock_sandbox():
    """A simple context-managing object for scenario tests."""
    return contextlib.nullcontext("sandbox")


@pytest.fixture
def minimal_context():
    return {}


class TestSteleRunScenario:
    """Basic step execution, capture-state, unsupported kind."""

    def test_basic_step_with_capture(self, mock_sandbox, minimal_context):
        """A step that captures its result into scenario_context."""

        def dummy_fn(body, ctx):
            return 42

        # Patch the internal call function for this test
        scenario = {
            "steps": [
                {
                    "kind": "step",
                    "call": {"target": "builtins:len", "body": "hello"},
                    "capture": "length",
                }
            ]
        }

        # We cannot easily mock _stele_call_python_import without
        # patching internals, so test with a real safe module.
        # Instead, test via a target we can control.
        import os as _os  # noqa: F811

        class FakeRuntime:
            pass

        runtime = FakeRuntime()
        runtime._stele_call_python_import = lambda tgt, body, ctx: body  # passthrough

        # Patching at the module level
        import _stele_runtime as rt

        orig = rt._stele_call_python_import

        def fake_import(target, body, ctx):
            return {"result": body}

        rt._stele_call_python_import = fake_import
        try:
            result = stele_run_scenario(scenario, minimal_context, mock_sandbox)
            assert "length" in result
            assert result["length"] == {"result": "hello"}
        finally:
            rt._stele_call_python_import = orig

    def test_capture_state_step(self, mock_sandbox, minimal_context):
        """capture-state kind stores result under the capture key."""
        import _stele_runtime as rt

        orig = rt._stele_call_python_import

        def fake_import(target, body, ctx):
            return body

        rt._stele_call_python_import = fake_import
        try:
            scenario = {
                "steps": [
                    {
                        "kind": "capture-state",
                        "call": {"target": "x:y", "body": "val"},
                        "capture": "my_state",
                    }
                ]
            }
            result = stele_run_scenario(scenario, minimal_context, mock_sandbox)
            assert result["my_state"] == "val"
        finally:
            rt._stele_call_python_import = orig

    def test_unsupported_kind_raises(self, mock_sandbox, minimal_context):
        """Unsupported step kind raises KeyError after call resolves."""
        import _stele_runtime as rt

        orig = rt._stele_call_python_import
        rt._stele_call_python_import = lambda t, b, c: "done"
        try:
            scenario = {
                "steps": [
                    {
                        "kind": "unsupported",
                        "call": {"target": "x:y", "body": {}},
                    }
                ]
            }
            with pytest.raises(KeyError, match="Unsupported Stele scenario step kind"):
                stele_run_scenario(scenario, minimal_context, mock_sandbox)
        finally:
            rt._stele_call_python_import = orig

    def test_multiple_steps(self, mock_sandbox, minimal_context):
        """Multiple steps accumulate captures in scenario_context."""
        import _stele_runtime as rt

        orig = rt._stele_call_python_import
        count = [0]

        def fake_import(target, body, ctx):
            count[0] += 1
            return count[0]

        rt._stele_call_python_import = fake_import
        try:
            scenario = {
                "steps": [
                    {
                        "kind": "step",
                        "call": {"target": "a:b", "body": {}},
                        "capture": "first",
                    },
                    {
                        "kind": "step",
                        "call": {"target": "c:d", "body": {}},
                        "capture": "second",
                    },
                ]
            }
            result = stele_run_scenario(scenario, minimal_context, mock_sandbox)
            assert result["first"] == 1
            assert result["second"] == 2
        finally:
            rt._stele_call_python_import = orig

    def test_step_without_capture(self, mock_sandbox, minimal_context):
        """A step with no 'capture' key does not store in scenario_context."""
        import _stele_runtime as rt

        orig = rt._stele_call_python_import
        rt._stele_call_python_import = lambda t, b, c: 99
        try:
            scenario = {
                "steps": [
                    {
                        "kind": "step",
                        "call": {"target": "a:b", "body": {}},
                    }
                ]
            }
            result = stele_run_scenario(scenario, minimal_context, mock_sandbox)
            # No capture key -> result should be empty
            assert result == {}
        finally:
            rt._stele_call_python_import = orig


# ────────────── _stele_parse_python_import_target ─────────────────────


class TestParsePythonImportTarget:
    """Valid target, invalid format, empty parts."""

    def test_valid_target(self):
        module, func = _stele_parse_python_import_target("mymodule:myfunc")
        assert module == "mymodule"
        assert func == "myfunc"

    def test_valid_target_with_dotted_module(self):
        module, func = _stele_parse_python_import_target("pkg.subpkg:func")
        assert module == "pkg.subpkg"
        assert func == "func"

    def test_no_colon_raises(self):
        with pytest.raises(ValueError, match="module:function"):
            _stele_parse_python_import_target("nocolon")

    def test_empty_module_raises(self):
        with pytest.raises(ValueError, match="module:function"):
            _stele_parse_python_import_target(":func")

    def test_empty_function_raises(self):
        with pytest.raises(ValueError, match="module:function"):
            _stele_parse_python_import_target("module:")

    def test_non_string_raises(self):
        with pytest.raises(ValueError, match="module:function"):
            _stele_parse_python_import_target(123)

    def test_multiple_colons_only_first_splits(self):
        module, func = _stele_parse_python_import_target("a:b:c")
        assert module == "a"
        assert func == "b:c"


# ─────────────────────────── _stele_open_sandbox ──────────────────────


class TestOpenSandbox:
    """Context manager, callable, plain object."""

    def test_context_manager_returned_as_is(self):
        cm = contextlib.nullcontext("data")
        result = _stele_open_sandbox(cm)
        assert result is cm

    def test_callable_returning_context_manager(self):
        def factory():
            return contextlib.nullcontext("from factory")

        result = _stele_open_sandbox(factory)
        # nullcontext is the CM type returned; check it has __enter__/__exit__
        assert hasattr(result, "__enter__") and hasattr(result, "__exit__")

    def test_callable_returning_non_context_manager(self):
        def factory():
            return "plain string"

        result = _stele_open_sandbox(factory)
        # Should be wrapped in nullcontext since the result has no __enter__/__exit__
        assert hasattr(result, "__enter__") and hasattr(result, "__exit__")

    def test_plain_object_wrapped_in_nullcontext(self):
        result = _stele_open_sandbox("just a string")
        assert hasattr(result, "__enter__") and hasattr(result, "__exit__")

    def test_callable_returning_callable(self):
        """Double-nesting: callable returns callable (not a CM)."""

        def inner():
            return 42

        result = _stele_open_sandbox(inner)
        assert hasattr(result, "__enter__") and hasattr(result, "__exit__")


# ────────────── _stele_resolve_scenario_value ────────────────────────


class TestResolveScenarioValue:
    """$ref, $gen, nested dicts, lists, plain values."""

    def test_ref_single_key(self):
        scenario_ctx = {"result": 42}
        value = {"$ref": ["result"]}
        result = _stele_resolve_scenario_value(value, {}, scenario_ctx)
        assert result == 42

    def test_ref_nested_path(self):
        scenario_ctx = {"data": {"inner": "value"}}
        value = {"$ref": ["data", "inner"]}
        result = _stele_resolve_scenario_value(value, {}, scenario_ctx)
        assert result == "value"

    def test_gen_unique_name(self):
        value = {"$gen": {"kind": "unique-name", "prefix": "item"}}
        result = _stele_resolve_scenario_value(value, {}, {})
        assert result.startswith("item-")

    def test_nested_dict_recursion(self):
        scenario_ctx = {"x": 1}
        value = {"outer": {"inner": {"$ref": ["x"]}}}
        result = _stele_resolve_scenario_value(value, {}, scenario_ctx)
        assert result == {"outer": {"inner": 1}}

    def test_list_recursion(self):
        scenario_ctx = {"a": 10}
        value = [{"$ref": ["a"]}, 20, {"$gen": {"kind": "unique-name", "prefix": "u"}}]
        result = _stele_resolve_scenario_value(value, {}, scenario_ctx)
        assert result[0] == 10
        assert result[1] == 20
        assert result[2].startswith("u-")

    def test_plain_value_passthrough(self):
        assert _stele_resolve_scenario_value(42, {}, {}) == 42

    def test_plain_string_passthrough(self):
        assert _stele_resolve_scenario_value("hello", {}, {}) == "hello"

    def test_none_passthrough(self):
        assert _stele_resolve_scenario_value(None, {}, {}) is None

    def test_regular_dict_without_special_keys(self):
        value = {"a": 1, "b": 2}
        result = _stele_resolve_scenario_value(value, {}, {})
        assert result == {"a": 1, "b": 2}


# ────────────────────────── _stele_generate_value ──────────────────


class TestGenerateValue:
    """Unique-name generation, unsupported kind."""

    def test_unique_name_default_prefix(self):
        result = _stele_generate_value({"kind": "unique-name"})
        assert result.startswith("value-")
        assert len(result) == len("value-") + 12

    def test_unique_name_custom_prefix(self):
        result = _stele_generate_value({"kind": "unique-name", "prefix": "order"})
        assert result.startswith("order-")
        # Ensure hex portion is exactly 12 chars
        assert len(result.split("-", 1)[1]) == 12

    def test_unique_name_is_unique(self):
        r1 = _stele_generate_value({"kind": "unique-name", "prefix": "u"})
        r2 = _stele_generate_value({"kind": "unique-name", "prefix": "u"})
        assert r1 != r2

    def test_unsupported_kind_raises(self):
        with pytest.raises(KeyError, match="Unsupported Stele scenario generator"):
            _stele_generate_value({"kind": "random-int"})

    def test_missing_kind_raises(self):
        with pytest.raises(KeyError, match="Unsupported Stele scenario generator"):
            _stele_generate_value({})


# ──────────────────── _STELE_MISSING sentinel ───────────────────────


class TestMissingSentinel:
    """The _STELE_MISSING sentinel object behavior."""

    def test_missing_is_singleton(self):
        assert _stele_read_optional_path({}, ["x"]) is _stele_read_optional_path({}, ["y"])

    def test_missing_is_singleton_identical(self):
        """_STELE_MISSING is a singleton; all calls return the same object."""
        val_x = _stele_read_optional_path({}, ["x"])
        val_y = _stele_read_optional_path({}, ["y"])
        assert val_x is val_y is _STELE_MISSING

    def test_missing_is_not_none(self):
        assert _stele_read_optional_path({}, ["x"]) is not None


# ──────────── Security: allowlist + blocklist ──────────────────────────


class TestModuleBlocklist:
    """Blocked modules are rejected immediately, regardless of allowlist."""

    def test_os_system_rejected(self):
        """os:system must be rejected — blocked module."""
        with pytest.raises(ValueError, match="Blocked module"):
            import _stele_runtime as rt

            rt._stele_call_python_import("os:system", {}, {})

    def test_subprocess_run_rejected(self):
        """subprocess:run must be rejected — blocked module."""
        with pytest.raises(ValueError, match="Blocked module"):
            import _stele_runtime as rt

            rt._stele_call_python_import("subprocess:run", {}, {})

    def test_sys_exit_rejected(self):
        """sys:exit must be rejected — blocked module."""
        with pytest.raises(ValueError, match="Blocked module"):
            import _stele_runtime as rt

            rt._stele_call_python_import("sys:exit", {}, {})

    def test_ctypes_CDLL_rejected(self):
        """ctypes:CDLL must be rejected — blocked module."""
        with pytest.raises(ValueError, match="Blocked module"):
            import _stele_runtime as rt

            rt._stele_call_python_import("ctypes:CDLL", {}, {})

    def test_socket_create_rejected(self):
        """socket:create must be rejected — blocked module."""
        with pytest.raises(ValueError, match="Blocked module"):
            import _stele_runtime as rt

            rt._stele_call_python_import("socket:create_connection", {}, {})

    def test_shutil_rmtree_rejected(self):
        """shutil:rmtree must be rejected — blocked module."""
        with pytest.raises(ValueError, match="Blocked module"):
            import _stele_runtime as rt

            rt._stele_call_python_import("shutil:rmtree", {}, {})

    def test_nested_blocked_module_rejected(self):
        """Even submodules of blocked packages are rejected."""
        with pytest.raises(ValueError, match="Blocked module"):
            import _stele_runtime as rt

            rt._stele_call_python_import("os.path:join", {}, {})

    def test_http_server_rejected(self):
        """http.server:BaseHTTPRequestHandler must be rejected."""
        with pytest.raises(ValueError, match="Blocked module"):
            import _stele_runtime as rt

            rt._stele_call_python_import("http.server:BaseHTTPRequestHandler", {}, {})

    def test_popen_rejected(self):
        """popen2: should be blocked."""
        # popen is in the blocklist
        with pytest.raises(ValueError, match="Blocked module"):
            import _stele_runtime as rt

            rt._stele_call_python_import("pexpect:spawn", {}, {})


class TestModuleAllowlist:
    """Only modules in the allowlist are permitted (after passing blocklist)."""

    def test_allowed_prefix_exact_match(self):
        """tests.contract_scenarios (exact match) passes allowlist check."""
        import _stele_runtime as rt

        # Just verify _is_module_allowed works; we can't actually import the module
        assert rt._is_module_allowed("tests.contract_scenarios") is True

    def test_allowed_prefix_submodule(self):
        """tests.contract_scenarios.helpers passes allowlist check."""
        import _stele_runtime as rt

        assert rt._is_module_allowed("tests.contract_scenarios.helpers") is True

    def test_allowed_app_prefix(self):
        """app (exact match) passes allowlist check."""
        import _stele_runtime as rt

        assert rt._is_module_allowed("app") is True

    def test_allowed_app_submodule(self):
        """app.models passes allowlist check."""
        import _stele_runtime as rt

        assert rt._is_module_allowed("app.models") is True

    def test_allowed_deep_app_submodule(self):
        """app.models.user passes allowlist check."""
        import _stele_runtime as rt

        assert rt._is_module_allowed("app.models.user") is True

    def test_not_allowed_random_module(self):
        """A random module not in the allowlist is rejected."""
        import _stele_runtime as rt

        assert rt._is_module_allowed("random") is False

    def test_not_allowed_prefix_match(self):
        """Module that starts with an allowed prefix but isn't actually a sub-module is rejected."""
        import _stele_runtime as rt

        # "apples" starts with "app" but is not "app" or "app.something"
        assert rt._is_module_allowed("apples") is False

    def test_not_allowed_prefix_apple(self):
        """apple is not allowed even though it shares prefix with app."""
        import _stele_runtime as rt

        assert rt._is_module_allowed("apple") is False

    def test_unlisted_module_rejected_at_import(self):
        """A module not in the allowlist raises ValueError at import time."""
        with pytest.raises(ValueError, match="not in allowlist"):
            import _stele_runtime as rt

            rt._stele_call_python_import("math:sin", {}, {})


class TestSecurityIntegration:
    """End-to-end security: blocked modules are rejected even if they'd pass regex."""

    def test_blocklist_checked_before_allowlist(self):
        """Blocked check runs first — even if somehow in allowlist."""
        import _stele_runtime as rt

        # os is blocked, even if we added it to the allowlist it would still be blocked
        assert rt._is_module_blocked("os") is True
        assert rt._is_module_blocked("os.path") is True

    def test_blocklist_and_allowlist_both_required(self):
        """A module must pass blocklist AND allowlist checks."""
        import _stele_runtime as rt

        # os passes regex, is blocked -> rejected by blocklist
        assert rt._is_module_blocked("os") is True

        # random passes blocklist (not in it), but not in allowlist -> rejected by allowlist
        assert rt._is_module_blocked("random") is False
        assert rt._is_module_allowed("random") is False

    def test_allowed_module_passes_regex(self):
        """Allowed modules still pass the regex validation."""
        import _stele_runtime as rt

        # tests.contract_scenarios should pass the regex
        assert rt._STELE_MODULE_RE.match("tests.contract_scenarios") is not None

    def test_app_models_allowed(self):
        """app.models passes all security checks."""
        import _stele_runtime as rt

        assert rt._is_module_blocked("app.models") is False
        assert rt._is_module_allowed("app.models") is True
        assert rt._STELE_MODULE_RE.match("app.models") is not None


class TestFrozensetsAreImmutable:
    """The allowlist and blocklist are frozensets and cannot be mutated at runtime."""

    def test_allowed_modules_is_frozenset(self):
        import _stele_runtime as rt

        assert isinstance(rt._STELE_ALLOWED_MODULES, frozenset)

    def test_blocked_modules_is_frozenset(self):
        import _stele_runtime as rt

        assert isinstance(rt._STELE_BLOCKED_MODULES, frozenset)
