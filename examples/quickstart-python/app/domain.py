"""
Tiny e-commerce domain model for the Stele quickstart demo.

Stele contracts (contract/main.stele) enforce business rules on these objects
without requiring any code changes here. Run `npx stele generate && python -m
pytest tests/contract` to verify.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from decimal import Decimal


@dataclass(frozen=True)
class Item:
    sku: str
    price: Decimal
    qty: int


@dataclass
class Order:
    id: str
    total: Decimal
    items: list[Item] = field(default_factory=list)

    def recalculate_total(self) -> None:
        self.total = sum((item.price * item.qty for item in self.items), Decimal("0"))


@dataclass
class User:
    id: str
    email: str
    status: str  # "active" | "suspended" | "deleted"

    ALLOWED_STATUSES = ("active", "suspended", "deleted")

    def is_active(self) -> bool:
        return self.status == "active"
