"""Conftest for Stele self-protection contract.

Imports checker implementations and registers them in _stele_checkers
so generated tests can invoke them via (uses-checker ...) forms.
"""
import pytest

# Lazy-load checkers — the module reads from the repo root.
_checkers = {}


def _lazy_load_checkers():
    if _checkers:
        return
    import importlib.util
    import pathlib

    spec_path = (
        pathlib.Path(__file__).resolve().parent.parent.parent
        / "contract"
        / "checker_impls"
        / "self_protection.py"
    )
    mod_name = "stele_self_protection"
    spec = importlib.util.spec_from_file_location(mod_name, str(spec_path))
    if spec and spec.loader:
        mod = importlib.util.module_from_spec(spec)
        import sys
        sys.modules[mod_name] = mod
        spec.loader.exec_module(mod)

        # All checker function names in self_protection.py
        for name in (
            # Original checkers
            "backend_registries",
            "backend_contains_python",
            "backend_contains_typescript",
            "backend_contains_go",
            "backend_contains_rust",
            "backend_contains_java",
            "config_schema_valid",
            "manifest_version_stable",
            "exit_codes_valid",
            "cdl_no_single_quotes",
            "cdl_utf8_valid",
            "versions_pinned_together",
            "no_secrets_in_source",
            "generation_deterministic",
            "path_no_traversal",
            # New checkers
            "operator_count_stable",
            "operator_spec_consistent",
            "manifest_hash_algorithm",
            "structural_types_stable",
            "hooks_fail_closed",
            "hooks_registration_complete",
            "required_commands_exist",
            "config_manifest_path_safe",
            "error_code_families_present",
            "cli_exit_code_enum_complete",
            "protected_pattern_safe",
            "inline_version_sync",
            # Round 3 Phase B self-protection checkers
            "all_evaluators_compile",
            "all_backends_compile",
            "strict_mode_default_in_ci",
            "fix_hint_requires_analysis_branch",
            # Round 4 D-13
            "default_protected_consistent",
            # Round 4 Phase 3 dogfood
            "esm_relative_imports_keep_js",
            "hook_entrypoints_fail_closed",
            "core_has_no_stele_deps",
        ):
            _checkers[name] = getattr(mod, name, None)


# Map CDL hyphenated checker names to Python function names.
_CHECKER_NAME_MAP = {
    # Original checkers
    "backend-registries": "backend_registries",
    "backend-contains-python": "backend_contains_python",
    "backend-contains-typescript": "backend_contains_typescript",
    "backend-contains-go": "backend_contains_go",
    "backend-contains-rust": "backend_contains_rust",
    "backend-contains-java": "backend_contains_java",
    "config-schema-valid": "config_schema_valid",
    "manifest-version-stable": "manifest_version_stable",
    "exit-codes-valid": "exit_codes_valid",
    "cdl-no-single-quotes": "cdl_no_single_quotes",
    "cdl-utf8-valid": "cdl_utf8_valid",
    "versions-pinned-together": "versions_pinned_together",
    "no-secrets-in-source": "no_secrets_in_source",
    "generation-deterministic": "generation_deterministic",
    "path-no-traversal": "path_no_traversal",
    # New checkers
    "operator-count-stable": "operator_count_stable",
    "operator-spec-consistent": "operator_spec_consistent",
    "manifest-hash-algorithm": "manifest_hash_algorithm",
    "structural-types-stable": "structural_types_stable",
    "hooks-fail-closed": "hooks_fail_closed",
    "hooks-registration-complete": "hooks_registration_complete",
    "required-commands-exist": "required_commands_exist",
    "config-manifest-path-safe": "config_manifest_path_safe",
    "error-code-families-present": "error_code_families_present",
    "cli-exit-code-enum-complete": "cli_exit_code_enum_complete",
    "protected-pattern-safe": "protected_pattern_safe",
    "inline-version-sync": "inline_version_sync",
    # Round 3 Phase B self-protection checkers (Round 4 D-04 fix —
    # without these mappings pytest tests/contract fails with KeyError
    # on every run, silently neutering the P0-2 CI enforcement claim).
    "all-evaluators-compile": "all_evaluators_compile",
    "all-backends-compile": "all_backends_compile",
    "strict-mode-default-in-ci": "strict_mode_default_in_ci",
    "fix-hint-requires-analysis-branch": "fix_hint_requires_analysis_branch",
    # Round 4 D-13
    "default-protected-consistent": "default_protected_consistent",
    # Round 4 Phase 3 dogfood
    "esm-relative-imports-keep-js": "esm_relative_imports_keep_js",
    "hook-entrypoints-fail-closed": "hook_entrypoints_fail_closed",
    "core-has-no-stele-deps": "core_has_no_stele_deps",
}


@pytest.fixture
def stele_context():
    _lazy_load_checkers()
    return {
        "_stele_checkers": {
            cdl_name: _checkers.get(py_name)
            for cdl_name, py_name in _CHECKER_NAME_MAP.items()
        }
    }


@pytest.fixture
def stele_sandbox():
    return None
