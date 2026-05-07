from ._stele_runtime import stele_call_checker, stele_get_path, stele_is_modified, stele_sum


def test_POS_001(stele_context):
    assert all(
        (stele_get_path(position, ["quantity"])) > (0)
        for position in stele_context["positions"]
    )


def test_POS_002(stele_context):
    assert all(
        (stele_get_path(position, ["market-value"])) > (0)
        for position in stele_context["positions"]
    )


def test_POS_003(stele_context):
    assert (len(stele_context["positions"])) <= (stele_get_path(stele_context["limits"], ["max-open-positions"]))


def test_POS_004(stele_context):
    assert (max(stele_get_path(item, ["market-value"]) for item in stele_context["positions"])) < (stele_get_path(stele_context["account"], ["total-value"]))


def test_POS_005(stele_context):
    assert (len(stele_context["positions"]) and (stele_sum(stele_context["positions"], ["market-value"]) / len(stele_context["positions"])) or 0) > (1000)


def test_POS_006(stele_context):
    assert (min(stele_get_path(item, ["market-value"]) for item in stele_context["positions"])) > (100)


def test_POS_007(stele_context):
    assert (abs(stele_sum(stele_context["positions"], ["unrealized-pnl"]))) < (1000)


def test_POS_008(stele_context):
    assert all(
        ((stele_get_path(position, ["asset-class"])) == ("equity")) or ((stele_get_path(position, ["asset-class"])) == ("etf"))
        for position in stele_context["positions"]
    )
