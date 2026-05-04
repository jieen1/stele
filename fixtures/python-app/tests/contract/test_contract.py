from ._stele_runtime import stele_call_checker, stele_get_path, stele_is_modified, stele_sum


def test_APP_001(stele_context):
    assert (stele_get_path(stele_context["account"], ["status"])) == ("active")


def test_APP_002(stele_context):
    assert stele_get_path(stele_context["account"], ["id"]) is not None


def test_APP_003(stele_context):
    assert (stele_get_path(stele_context["account"], ["currency"])) == ("USD")


def test_APP_004(stele_context):
    assert any((stele_get_path(request, ["status"])) == ("pending") for request in stele_context["withdrawals"])
