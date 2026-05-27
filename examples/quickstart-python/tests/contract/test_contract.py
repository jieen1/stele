from ._stele_runtime import stele_call_checker, stele_get_path, stele_is_modified, stele_sum


def test_ORDER_TOTAL_POSITIVE(stele_context):
    assert all(
        (stele_get_path(order, ["total"])) > (0)
        for order in stele_context["orders"]
    )


def test_ORDER_ID_PRESENT(stele_context):
    assert all(
        stele_get_path(order, ["id"]) is not None
        for order in stele_context["orders"]
    )


def test_USER_STATUS_ENUM(stele_context):
    assert ((stele_get_path(stele_context["user"], ["status"])) == ("active")) or ((stele_get_path(stele_context["user"], ["status"])) == ("suspended")) or ((stele_get_path(stele_context["user"], ["status"])) == ("deleted"))


def test_SKU_FORMAT(stele_context):
    result = stele_call_checker("validate-sku", stele_context, {})
    assert result["passed"], result.get("message") or "Checker failed: validate-sku"


def test_EMAIL_FORMAT(stele_context):
    result = stele_call_checker("validate-email", stele_context, {})
    assert result["passed"], result.get("message") or "Checker failed: validate-email"
