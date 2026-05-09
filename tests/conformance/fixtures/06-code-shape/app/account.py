"""Compliant Python module exercised by fixture 06 (Code Shape, EP06).

The Account class and calculate_total function exist with the required
fields, methods, and parameters so the generated pytest passes and
`stele check` reports zero rule violations.
"""

from typing import List, Mapping


class Account:
    id: str
    balance: int

    def __init__(self, id: str, balance: int = 0) -> None:
        self.id = id
        self.balance = balance

    def deposit(self, amount: int) -> None:
        self.balance += amount

    def withdraw(self, amount: int) -> None:
        if amount > self.balance:
            raise ValueError("insufficient funds")
        self.balance -= amount


def calculate_total(cart: List[Mapping[str, int]], tax_rate: float) -> float:
    subtotal = sum(item["price"] * item.get("quantity", 1) for item in cart)
    return subtotal * (1 + tax_rate)
