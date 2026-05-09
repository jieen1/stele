"""Minimal shopping-cart module used in the cursor-demo example.

The Stele contract under contract/main.stele protects this project's
domain rules. The Cursor adapter (`stele install --agent cursor`) injects
those rules into Cursor's prompt; CI enforcement runs through
`@stele/github-action` because Cursor cannot hard-block tool calls.
"""

from dataclasses import dataclass


@dataclass
class CartItem:
    sku: str
    unit_price: float
    quantity: int


@dataclass
class Cart:
    items: list[CartItem]

    @property
    def subtotal(self) -> float:
        return sum(item.unit_price * item.quantity for item in self.items)
