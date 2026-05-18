# Fixture: Negative failing invariant

This fixture verifies that a failing invariant is reported as a violation
with `ok: false`. It tests the negative path of the conformance pipeline:
invariant failure -> test runner non-zero -> violation report.
