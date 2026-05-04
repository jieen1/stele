from ._stele_runtime import stele_call_checker, stele_get_path, stele_is_modified, stele_sum


def test_ACCT_001(stele_context):
    assert stele_get_path(stele_context["account"], ["total-value"]) == (
        stele_sum(stele_context["positions"], ["market-value"])
        + stele_get_path(stele_context["account"], ["cash"])
    )


def test_ACCT_002(stele_context):
    assert all(
        stele_get_path(txn, ["account-id"]) in stele_context["accounts"]
        for txn in stele_context["transactions"]
    )


def test_ACCT_003(stele_context):
    if not (stele_is_modified(stele_context, ["account","balance"])):
        return
    result = stele_call_checker("balance-change-has-transaction", stele_context, {})
    assert result["passed"], result.get("message") or "Checker failed: balance-change-has-transaction"


def test_ACCT_004(stele_context):
    assert (stele_get_path(stele_context["account"], ["balance"])) == (stele_get_path(stele_context["account"], ["cash"]))


def test_ACCT_005(stele_context):
    assert (stele_get_path(stele_context["account"], ["equity"])) == (stele_get_path(stele_context["account"], ["total-value"]))


def test_ACCT_006(stele_context):
    assert (stele_get_path(stele_context["account"], ["available-withdrawal"])) <= (stele_get_path(stele_context["account"], ["cash"]))


def test_ACCT_007(stele_context):
    assert (stele_get_path(stele_context["account"], ["buying-power"])) >= (0)
