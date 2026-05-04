from __future__ import annotations

from dataclasses import dataclass
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path

import pytest


@dataclass(frozen=True)
class AccountSnapshot:
    id: str
    status: str
    currency: str
    cash: int
    balance: int
    total_value: int
    equity: int
    buying_power: int
    available_withdrawal: int
    day_trade_buying_power: int
    last_reviewed_at: int


@dataclass(frozen=True)
class Position:
    symbol: str
    quantity: int
    market_value: int
    unrealized_pnl: int
    asset_class: str


@dataclass(frozen=True)
class Transaction:
    id: str
    account_id: str
    amount: int
    posted_at: int
    settlement_at: int
    trade_date: int
    type: str
    balance_before: int
    balance_after: int


@dataclass(frozen=True)
class Order:
    id: str
    notional: int
    submitted_at: int
    status: str


@dataclass(frozen=True)
class Alert:
    code: str
    severity: str
    status: str


@dataclass(frozen=True)
class WithdrawalRequest:
    id: str
    amount: int
    status: str
    requested_at: int


@dataclass(frozen=True)
class Limits:
    max_open_positions: int
    max_order_notional: int
    max_withdrawal: int
    max_daily_loss: int
    max_single_position_weight: float


@dataclass(frozen=True)
class RiskSnapshot:
    maintenance_margin_used: int
    daily_loss: int


def _load_balance_checker():
    project_root = Path(__file__).resolve().parents[2]
    module_path = project_root / "contract" / "checker_impls" / "balance_change_has_transaction.py"
    spec = spec_from_file_location("balance_change_has_transaction", module_path)
    module = module_from_spec(spec)
    assert spec is not None and spec.loader is not None
    spec.loader.exec_module(module)
    return module.check


@pytest.fixture
def stele_context():
    account = AccountSnapshot(
        id="acct-001",
        status="active",
        currency="USD",
        cash=5000,
        balance=5000,
        total_value=11375,
        equity=11375,
        buying_power=16000,
        available_withdrawal=4200,
        day_trade_buying_power=8000,
        last_reviewed_at=1714800000,
    )
    positions = [
        Position(symbol="AAPL", quantity=10, market_value=2500, unrealized_pnl=120, asset_class="equity"),
        Position(symbol="MSFT", quantity=15, market_value=3000, unrealized_pnl=-80, asset_class="equity"),
        Position(symbol="VOO", quantity=2, market_value=875, unrealized_pnl=35, asset_class="etf"),
    ]
    transactions = [
        Transaction(
            id="txn-001",
            account_id="acct-001",
            amount=200,
            posted_at=1714700000,
            settlement_at=1714786400,
            trade_date=1714690000,
            type="cash-deposit",
            balance_before=4800,
            balance_after=5000,
        ),
        Transaction(
            id="txn-002",
            account_id="acct-001",
            amount=-150,
            posted_at=1714600000,
            settlement_at=1714686400,
            trade_date=1714590000,
            type="fee",
            balance_before=4950,
            balance_after=4800,
        ),
        Transaction(
            id="txn-003",
            account_id="acct-002",
            amount=1250,
            posted_at=1714500000,
            settlement_at=1714586400,
            trade_date=1714490000,
            type="transfer",
            balance_before=7000,
            balance_after=8250,
        ),
    ]
    orders = [
        Order(id="ord-001", notional=3200, submitted_at=1714790000, status="open"),
        Order(id="ord-002", notional=1500, submitted_at=1714785000, status="filled"),
    ]
    alerts = [
        Alert(code="price-gap", severity="low", status="open"),
        Alert(code="margin-review", severity="critical", status="resolved"),
    ]
    withdrawals = [
        WithdrawalRequest(id="wd-001", amount=800, status="pending", requested_at=1714792000),
        WithdrawalRequest(id="wd-002", amount=500, status="approved", requested_at=1714782000),
    ]
    limits = Limits(
        max_open_positions=5,
        max_order_notional=25000,
        max_withdrawal=5000,
        max_daily_loss=2000,
        max_single_position_weight=0.45,
    )
    risk = RiskSnapshot(
        maintenance_margin_used=3000,
        daily_loss=350,
    )

    return {
        "account": account,
        "positions": positions,
        "transactions": transactions,
        "orders": orders,
        "alerts": alerts,
        "withdrawals": withdrawals,
        "limits": limits,
        "risk": risk,
        "accounts": ["acct-001", "acct-002"],
        "state-before": {
            "account": {
                "balance": 4800,
            }
        },
        "state-after": {
            "account": {
                "balance": 5000,
            }
        },
        "_stele_checkers": {
            "balance-change-has-transaction": _load_balance_checker(),
        },
    }
