"""
Stele conftest: wires real domain objects into contract tests.

The stele_context fixture returns a dict whose keys map directly to
(path …) expressions in contract/main.stele. Replace the sample data below
with production fixtures or test-database snapshots as your project grows.
"""

from __future__ import annotations

import sys
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path

import pytest

# Make the app package importable when running pytest from the example root.
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from app.fixtures import sample_items, sample_orders, sample_user  # noqa: E402


def _load_checker(name: str):
    """Load contract/checker_impls/<name>.py and return its check callable."""
    project_root = Path(__file__).resolve().parents[2]
    module_path = project_root / "contract" / "checker_impls" / f"{name}.py"
    spec = spec_from_file_location(name, module_path)
    mod = module_from_spec(spec)
    assert spec is not None and spec.loader is not None
    spec.loader.exec_module(mod)
    return mod.check


@pytest.fixture
def stele_context():
    return {
        "user": sample_user().__dict__,
        "orders": [
            {"id": o.id, "total": float(o.total)}
            for o in sample_orders()
        ],
        "items": [
            {"sku": item.sku, "price": float(item.price), "qty": item.qty}
            for item in sample_items()
        ],
        # _stele_checkers maps CDL checker IDs to Python callables.
        # Each callable receives (stele_context, **kwargs) and returns
        # {"passed": bool, "message": str | None}.
        "_stele_checkers": {
            "validate-sku": _load_checker("validate_sku"),
            "validate-email": _load_checker("validate_email"),
        },
    }


@pytest.fixture
def stele_sandbox():
    """Scenario sandbox — only needed for (scenario …) contracts."""
    return None
