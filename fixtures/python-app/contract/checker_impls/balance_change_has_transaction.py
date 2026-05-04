def _read_path(root, *parts):
    current = root
    for part in parts:
        if isinstance(current, dict) and part in current:
            current = current[part]
        elif hasattr(current, part):
            current = getattr(current, part)
        else:
            current = getattr(current, part.replace("-", "_"))
    return current


def check(stele_context, **_kwargs):
    account_id = _read_path(stele_context["account"], "id")
    balance_before = _read_path(stele_context["state-before"], "account", "balance")
    balance_after = _read_path(stele_context["state-after"], "account", "balance")

    if balance_before == balance_after:
        return {
            "passed": True,
            "message": None,
            "context": {"account_id": account_id, "delta": 0},
        }

    balance_delta = balance_after - balance_before

    for transaction in stele_context["transactions"]:
        if (
            _read_path(transaction, "account-id") == account_id
            and _read_path(transaction, "amount") == balance_delta
            and _read_path(transaction, "balance-before") == balance_before
            and _read_path(transaction, "balance-after") == balance_after
        ):
            return {
                "passed": True,
                "message": None,
                "context": {"account_id": account_id, "delta": balance_delta},
            }

    return {
        "passed": False,
        "message": f"Missing transaction proving balance delta {balance_delta} for {account_id}.",
        "context": {
            "account_id": account_id,
            "balance_before": balance_before,
            "balance_after": balance_after,
        },
    }
