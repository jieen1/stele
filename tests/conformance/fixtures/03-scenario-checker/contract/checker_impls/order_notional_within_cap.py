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
    cap = _read_path(stele_context["limits"], "max-order-notional")
    failing = []

    for order in stele_context["orders"]:
        notional = _read_path(order, "notional")
        if notional > cap:
            failing.append({"id": _read_path(order, "id"), "notional": notional})

    if failing:
        return {
            "passed": False,
            "message": (
                f"{len(failing)} order(s) exceed cap {cap}: "
                + ", ".join(f"{entry['id']}={entry['notional']}" for entry in failing)
            ),
            "context": {"cap": cap, "failing": failing},
        }

    return {
        "passed": True,
        "message": None,
        "context": {"cap": cap, "checked": len(stele_context["orders"])},
    }
