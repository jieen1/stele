---
name: contract-debugging
description: Helps debug contract violations. Auto-invoked when contract tests fail or stele check reports issues.
---

# Contract Debugging Skill

When a contract test fails or `stele check` reports issues:

## Step 1: Identify the violation

Run `stele list` to see all invariants. Note which invariant ID failed.

## Step 2: Understand the rule

Run `stele explain <invariant-id>` to read the failing invariant. Pay attention to:
- **severity**: Determines how urgently to fix
- **description**: What business rule is being protected
- **rationale**: Why the rule exists (usually references a real incident)
- **assert**: The actual expression that failed

## Step 3: Diagnose

1. Read the failing assertion to understand the expectation vs actual state.
2. Check if the violation is in your change scope or inherited.
3. Run `stele check --diff-from main` to scope failures to your branch.

## Step 4: Fix

The fix is almost always in the source code, not the contract. To fix:

1. Locate the code that violates the invariant.
2. Modify the code to comply with the invariant.
3. Re-run `stele check` to verify.

**DO NOT modify the contract or generated tests.** If the contract itself is wrong:
1. Use `stele propose invariant` for new rules.
2. Use the contract-author agent for changes to existing rules.
3. Document why the contract needs changing.

## Common patterns

| Violation type | Typical fix |
|----------------|------------|
| `eq` assertion failed | Add missing validation or ensure state consistency |
| `forall` failed | Ensure all items in collection satisfy the predicate |
| `not-null` failed | Add null check or ensure field is always populated |
| `modified` failed | Ensure state-before/state-after correctly reflect changes |
| Checker failed | Register or fix the checker implementation |

## Step 5: Verify

After fixing:
1. `npx stele generate` — regenerate tests
2. `python -m pytest tests/contract -q` — run tests
3. `npx stele check` — verify contract integrity
4. `npx stele check --diff-from main` — verify scoped check passes
