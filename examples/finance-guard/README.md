# Finance Guard — Stele Demo Project

A realistic brokerage account service demonstrating Stele's contract protection workflow.

## What this demonstrates

- Stele attaches to an existing Python project without code modifications
- Business invariants declared in CDL translate to pytest tests
- Full lifecycle: init → contract → generate → test → lock → check
- 12 invariants covering status, balance, currency, transactions, and composite rules
- All 7 new CDL operators exercised: `between`, `approx-eq`, `contains`, `is-empty`, `starts-with`, `ends-with`, `has-length`

## Prerequisites

- Node.js 20+ (for Stele CLI)
- Python 3.10+ with pytest

## Quick start

```bash
# 1. Install Stele CLI (from monorepo root)
npm install
npm run build

# 2. Initialize
npx stele init --language python

# 3. Define invariants in contract/main.stele

# 4. Generate tests
npx stele generate

# 5. Wire fixtures in tests/contract/conftest.py
#    Point stele_context to your real application state

# 6. Run tests
python -m pytest tests/contract/ -v

# 7. Lock and check
npx stele lock --reason "initial setup"
npx stele check
```

## Invariants

| ID | Severity | Description |
|----|----------|-------------|
| FG_STATUS_001 | critical | Account must be active for contract checks |
| FG_STATUS_002 | high | Account status must contain active state indicator |
| FG_STATUS_003 | medium | Account status must start with 'a' |
| FG_BALANCE_001 | critical | Account balance must be non-negative |
| FG_BALANCE_002 | high | Balance must be between 0 and 1000000 |
| FG_BALANCE_003 | medium | Total equity must approximately equal positions_plus_cash |
| FG_CURRENCY_001 | high | Account currency must be USD |
| FG_CURRENCY_002 | low | Currency code must end with D |
| FG_TXN_001 | high | Active accounts must have at least one transaction |
| FG_TXN_002 | medium | Account must have at least 1 recorded transaction |
| FG_COMPOSITE_001 | critical | Active account with positive balance and valid currency |
| FG_COMPOSITE_002 | high | Account must have non-null ID and non-empty transactions |

## Commands

```bash
npx stele init          # Initialize Stele
npx stele list           # List all invariants
npx stele list --severity critical --format json  # Filter by severity
npx stele generate       # Generate pytest tests
npx stele lock --reason "..."  # Lock manifest
npx stele check          # Verify contracts
npx stele explain FG_STATUS_001  # Explain an invariant
npx stele rules          # List all rules
npx stele doc --format markdown  # Generate documentation
npx stele agent-context --json   # Agent-friendly context
```
