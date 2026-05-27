"""
Custom checker: validate that user.email is RFC-shaped.

Stele calls check(stele_context) when evaluating the EMAIL_FORMAT invariant.
The checker reads stele_context["user"]["email"] — wired in conftest.py.
"""

import re

# Minimal pattern: at least one non-@ non-whitespace char, @, domain, dot, tld.
EMAIL_PATTERN = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def check(stele_context, **_kwargs):
    """
    Returns {"passed": bool, "message": str | None}.

    Checks stele_context["user"]["email"] against a minimal RFC pattern.
    """
    user = stele_context.get("user", {})
    email = user.get("email", "") if isinstance(user, dict) else getattr(user, "email", "")
    if EMAIL_PATTERN.match(str(email)):
        return {"passed": True, "message": None}
    return {
        "passed": False,
        "message": f"Email {email!r} is not RFC-shaped (expected user@domain.tld)",
    }
