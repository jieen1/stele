"""Account service domain models.

These models represent a simplified brokerage account service.
Stele contracts enforce business invariants on these objects
without requiring any code changes here.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any


class AccountStatus(str, Enum):
    ACTIVE = "active"
    SUSPENDED = "suspended"
    CLOSED = "closed"


class TransactionType(str, Enum):
    DEPOSIT = "deposit"
    WITHDRAWAL = "withdrawal"
    TRADE = "trade"
    FEE = "fee"


@dataclass(frozen=True)
class Transaction:
    id: str
    type: TransactionType
    amount: float  # positive = credit, negative = debit
    timestamp: str  # ISO-8601


@dataclass(frozen=True)
class Position:
    symbol: str
    quantity: float
    avg_cost: float
    current_price: float


@dataclass
class Account:
    id: str
    status: AccountStatus
    currency: str
    balance: float = 0.0
    transactions: list[Transaction] = field(default_factory=list)
    positions: list[Position] = field(default_factory=list)
    metadata: dict[str, Any] = field(default_factory=dict)

    def dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "status": self.status.value,
            "currency": self.currency,
            "balance": self.balance,
            "transactions": self.transactions,
            "positions": self.positions,
            "metadata": self.metadata,
        }

    @property
    def total_equity(self) -> float:
        return self.balance + sum(p.current_price * p.quantity for p in self.positions)

    @property
    def positions_plus_cash(self) -> float:
        return self.total_equity

    def is_active(self) -> bool:
        return self.status == AccountStatus.ACTIVE

    def has_transactions(self) -> bool:
        return len(self.transactions) > 0

    def deposit(self, amount: float):
        self.balance += amount
        self.transactions.append(Transaction(
            id=f"txn_{len(self.transactions):04d}",
            type=TransactionType.DEPOSIT,
            amount=amount,
            timestamp="2026-01-15T10:00:00Z",
        ))

    def withdraw(self, amount: float):
        if amount > self.balance:
            raise ValueError("Insufficient balance")
        self.balance -= amount
        self.transactions.append(Transaction(
            id=f"txn_{len(self.transactions):04d}",
            type=TransactionType.WITHDRAWAL,
            amount=-amount,
            timestamp="2026-01-15T10:00:00Z",
        ))

    def get_open_transactions(self) -> list[Transaction]:
        return [t for t in self.transactions if abs(t.amount) > 0]


def create_default_account() -> Account:
    """Factory for the default demo account."""
    return Account(
        id="ACC-001",
        status=AccountStatus.ACTIVE,
        currency="USD",
        balance=10_000.00,
    )
