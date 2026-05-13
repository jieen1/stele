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
        for name in (
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
        ):
            _checkers[name] = getattr(mod, name, None)


@pytest.fixture
def stele_context():
    _lazy_load_checkers()
    return {
        "_stele_checkers": {
            "backend-registries": _checkers.get("backend_registries"),
            "backend-contains-python": _checkers.get("backend_contains_python"),
            "backend-contains-typescript": _checkers.get("backend_contains_typescript"),
            "backend-contains-go": _checkers.get("backend_contains_go"),
            "backend-contains-rust": _checkers.get("backend_contains_rust"),
            "backend-contains-java": _checkers.get("backend_contains_java"),
            "config-schema-valid": _checkers.get("config_schema_valid"),
            "manifest-version-stable": _checkers.get("manifest_version_stable"),
            "exit-codes-valid": _checkers.get("exit_codes_valid"),
            "cdl-no-single-quotes": _checkers.get("cdl_no_single_quotes"),
            "cdl-utf8-valid": _checkers.get("cdl_utf8_valid"),
            "versions-pinned-together": _checkers.get("versions_pinned_together"),
            "no-secrets-in-source": _checkers.get("no_secrets_in_source"),
            "generation-deterministic": _checkers.get("generation_deterministic"),
            "path-no-traversal": _checkers.get("path_no_traversal"),
        }
    }


@pytest.fixture
def stele_sandbox():
    return None
