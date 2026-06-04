"""Self-protection checkers for the Stele framework.

Each function receives (ctx: dict, **kwargs) and returns
{"passed": bool, "message": str | None}.

These checkers inspect the actual Stele monorepo at test time.

This module is the stable entry point: it re-exports every checker and
helper from the split implementation modules so that both loaders keep
working —

  1. ``tests/contract/conftest.py`` loads this file BY PATH via
     ``importlib.util.spec_from_file_location`` and ``getattr``s each
     checker name off the resulting module.
  2. ``contract/checker_impls/test_negative.py`` does ``import
     self_protection as sp`` and references ``sp.<checker>`` plus a set
     of underscore helpers/constants/caches.

The ``sys.path`` insert below makes the sibling ``sp_*`` modules
importable even when this file is exec'd by absolute path (where the
package directory is not otherwise on ``sys.path``).
"""
from __future__ import annotations

import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

from sp_shared import *  # noqa: E402,F401,F403
from sp_core import *  # noqa: E402,F401,F403
from sp_phase_b import *  # noqa: E402,F401,F403
from sp_dogfood import *  # noqa: E402,F401,F403
from sp_branded import *  # noqa: E402,F401,F403
from sp_lock1 import *  # noqa: E402,F401,F403
