"""
Sample data used by contract tests.

Import these in conftest.py to wire real domain objects into the Stele fixture.
"""

from __future__ import annotations

from decimal import Decimal

from .domain import Item, Order, User


def sample_user() -> User:
    return User(id="usr-001", email="alice@example.com", status="active")


def sample_orders() -> list[Order]:
    ord1 = Order(
        id="ord-001",
        total=Decimal("49.99"),
        items=[
            Item(sku="WIDGET-A1", price=Decimal("29.99"), qty=1),
            Item(sku="WIDGET-B2", price=Decimal("20.00"), qty=1),
        ],
    )
    ord2 = Order(
        id="ord-002",
        total=Decimal("14.50"),
        items=[
            Item(sku="GADGET-C3", price=Decimal("14.50"), qty=1),
        ],
    )
    return [ord1, ord2]


def sample_items() -> list[Item]:
    """Flat item list used by the SKU_FORMAT checker."""
    orders = sample_orders()
    return [item for order in orders for item in order.items]
