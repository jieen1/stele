"""Isolation backstop for the self-protection negative suite.

The negative tests in `test_negative.py` deliberately tamper REAL tracked source
files in place (inject a violation, run the checker, restore in `finally`). If a
test's restore is incomplete — or the test body raises before restoring, or the
process is interrupted between tests — the mutation leaks into the working tree
and poisons every later test, producing misleading failures and a silently dirty
checkout. This was observed in practice (an interrupted run left
`packages/core/src/manifest/hash-manifest.ts` modified, and a follow-on run
reported ~13 spurious failures until the file was restored).

This autouse fixture is a per-test safety net. After each test it restores ONLY
the tracked files that test modified — the delta against the pre-test git state —
and removes probe artifacts the test created. Because it acts on the delta, it
never disturbs pre-existing uncommitted work in a local tree, and a single leaky
or killed test can no longer cascade into the rest of the suite. When a test
restores itself correctly (the normal case), the delta is empty and the fixture
does nothing.
"""
from __future__ import annotations

import pathlib
import subprocess

import pytest

_REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent.parent

# Untracked files whose path contains one of these fragments are test probes the
# suite writes into real source trees; they are safe to delete if a test leaks them.
_PROBE_FRAGMENTS = (
    "__neg",
    "__phase",
    "__closeout",
    "__negtest",
    "__stele",
    "_negative_",
    "_probe",
)


def _git_status() -> dict[str, str]:
    """Map of path -> two-char porcelain status for every dirty/untracked file."""
    result = subprocess.run(
        ["git", "status", "--porcelain", "-z"],
        cwd=_REPO_ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    entries: dict[str, str] = {}
    for record in result.stdout.split("\0"):
        if len(record) < 4:
            continue
        # Porcelain -z: "XY<space>PATH"; XY = status, PATH starts at index 3.
        entries[record[3:]] = record[:2]
    return entries


@pytest.fixture(autouse=True)
def _restore_tampered_sources():
    before = _git_status()
    yield
    after = _git_status()

    for path, status in after.items():
        if before.get(path) == status:
            continue  # unchanged by this test

        if status == "??":
            # Untracked file created during the test — remove only known probes.
            if any(fragment in path for fragment in _PROBE_FRAGMENTS):
                try:
                    (_REPO_ROOT / path).unlink()
                except (FileNotFoundError, IsADirectoryError, OSError):
                    pass
        elif "M" in status or "A" in status:
            # Tracked file the test modified/added but did not fully restore.
            subprocess.run(
                ["git", "checkout", "--", path],
                cwd=_REPO_ROOT,
                check=False,
                capture_output=True,
            )
