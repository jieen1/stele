from ._stele_runtime import stele_call_checker, stele_get_path, stele_is_modified, stele_sum


def test_OPS_001(stele_context):
    assert (stele_get_path(stele_context["risk"], ["maintenance-margin-used"])) <= (stele_get_path(stele_context["account"], ["equity"]))


def test_OPS_002(stele_context):
    assert (stele_get_path(stele_context["risk"], ["daily-loss"])) < (stele_get_path(stele_context["limits"], ["max-daily-loss"]))


def test_OPS_003(stele_context):
    assert all(
        (stele_get_path(order, ["notional"])) <= (stele_get_path(stele_context["limits"], ["max-order-notional"]))
        for order in stele_context["orders"]
    )


def test_OPS_004(stele_context):
    assert all(
        stele_get_path(order, ["submitted-at"]) < stele_get_path(stele_context["account"], ["last-reviewed-at"])
        for order in stele_context["orders"]
    )


def test_OPS_005(stele_context):
    assert all(
        stele_get_path(txn, ["posted-at"]) < stele_get_path(txn, ["settlement-at"])
        for txn in stele_context["transactions"]
    )


def test_OPS_006(stele_context):
    assert all(
        stele_get_path(txn, ["trade-date"]) < stele_get_path(txn, ["settlement-at"])
        for txn in stele_context["transactions"]
    )


def test_OPS_007(stele_context):
    assert not (any(((stele_get_path(alert, ["severity"])) == ("critical")) and ((stele_get_path(alert, ["status"])) != ("resolved")) for alert in stele_context["alerts"]))


def test_OPS_008(stele_context):
    assert all(
        (stele_get_path(request, ["amount"])) <= (stele_get_path(stele_context["limits"], ["max-withdrawal"]))
        for request in stele_context["withdrawals"]
    )


def test_OPS_009(stele_context):
    assert ((max(stele_get_path(item, ["market-value"]) for item in stele_context["positions"])) / (stele_get_path(stele_context["account"], ["total-value"]))) <= (stele_get_path(stele_context["limits"], ["max-single-position-weight"]))


def test_OPS_010(stele_context):
    assert (not ((len(stele_context["orders"])) > (0)) or ((stele_get_path(stele_context["account"], ["buying-power"])) > (0)))


def test_OPS_011(stele_context):
    assert (((stele_get_path(stele_context["account"], ["status"])) == ("active")) == ((stele_get_path(stele_context["account"], ["buying-power"])) > (0)))


def test_OPS_012(stele_context):
    assert (stele_get_path(stele_context["account"], ["day-trade-buying-power"])) == ((8000 if (stele_get_path(stele_context["account"], ["status"])) == ("active") else 0))
