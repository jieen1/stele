"""Account service — provides the business logic for account operations.

This module is completely unaware of Stele. Stele contracts attach
externally via pytest fixtures, enforcing invariants without code
modifications.
"""

from __future__ import annotations

from .models import Account, AccountStatus, Transaction, TransactionType, create_default_account


class AccountService:
    """Manages brokerage accounts."""

    def __init__(self):
        self._accounts: dict[str, Account] = {}

    def create_account(self, account_id: str, currency: str = "USD") -> Account:
        account = create_default_account()
        account.id = account_id
        account.currency = currency
        self._accounts[account_id] = account
        return account

    def get_account(self, account_id: str) -> Account | None:
        return self._accounts.get(account_id)

    def deposit(self, account_id: str, amount: float) -> Account:
        account = self._accounts.get(account_id)
        if account is None:
            raise ValueError(f"Account {account_id} not found")
        account.deposit(amount)
        return account

    def withdraw(self, account_id: str, amount: float) -> Account:
        account = self._accounts.get(account_id)
        if account is None:
            raise ValueError(f"Account {account_id} not found")
        account.withdraw(amount)
        return account

    def list_accounts(self) -> list[Account]:
        return list(self._accounts.values())

    def close_account(self, account_id: str) -> Account:
        account = self._accounts.get(account_id)
        if account is None:
            raise ValueError(f"Account {account_id} not found")
        account.status = AccountStatus.CLOSED
        return account
