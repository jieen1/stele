"""
Custom checker: validate that all item SKUs match the expected format.

Stele calls check(stele_context) when evaluating the SKU_FORMAT invariant.
The checker reads stele_context["items"] — a flat list of item dicts wired
in tests/contract/conftest.py.
"""

import re

# SKU format: one or more uppercase letters, a dash, then alphanumerics.
# Examples: WIDGET-A1, GADGET-C3, PRODUCT-123
SKU_PATTERN = re.compile(r"^[A-Z]+-[A-Z0-9]+$")


def check(stele_context, **_kwargs):
    """
    Returns {"passed": bool, "message": str | None}.

    Iterates over stele_context["items"] and fails on the first invalid SKU.
    """
    items = stele_context.get("items", [])
    for item in items:
        sku = item.get("sku", "") if isinstance(item, dict) else getattr(item, "sku", "")
        if not SKU_PATTERN.match(str(sku)):
            return {
                "passed": False,
                "message": f"SKU {sku!r} does not match ^[A-Z]+-[A-Z0-9]+$",
            }
    return {"passed": True, "message": None}
