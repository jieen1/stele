"""Conftest for Stele self-protection contract.

Imports checker implementations and registers them in _stele_checkers
so generated tests can invoke them via (uses-checker ...) forms.

Checker registration is AUTO-DISCOVERED from the loaded module: every
public function (no leading underscore) defined in self_protection.py or
one of its sp_* submodules is registered under its hyphenated CDL name
(``foo_bar`` -> ``foo-bar``). This is the single naming convention the
contract uses, so a hand-maintained name list can only drift out of it —
which is exactly how the Lock-1 checkers (scratch-never-hashed, etc.)
ended up unregistered and raising KeyError. Auto-discovery cannot drift.
"""
import pytest

# Lazy-load checkers — the module reads from the repo root.
_checkers = {}


def _lazy_load_checkers():
    if _checkers:
        return
    import importlib.util
    import inspect
    import pathlib
    import sys

    spec_path = (
        pathlib.Path(__file__).resolve().parent.parent.parent
        / "contract"
        / "checker_impls"
        / "self_protection.py"
    )
    mod_name = "stele_self_protection"
    spec = importlib.util.spec_from_file_location(mod_name, str(spec_path))
    if not (spec and spec.loader):
        return

    mod = importlib.util.module_from_spec(spec)
    sys.modules[mod_name] = mod
    spec.loader.exec_module(mod)

    # Register every public checker function under its hyphenated CDL name.
    # Restrict to functions defined in the self_protection module family
    # (the entry module re-exports its sp_* submodules via `import *`), so
    # stdlib functions pulled in at module scope are never registered.
    for py_name, fn in inspect.getmembers(mod, inspect.isfunction):
        if py_name.startswith("_"):
            continue
        owner = getattr(fn, "__module__", "") or ""
        if owner == mod_name or owner.startswith("sp_"):
            _checkers[py_name.replace("_", "-")] = fn


@pytest.fixture
def stele_context():
    _lazy_load_checkers()
    return {"_stele_checkers": dict(_checkers)}


@pytest.fixture
def stele_sandbox():
    return None
