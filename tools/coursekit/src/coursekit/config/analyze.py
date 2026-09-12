"""Constants owned by analyze (G1).

Adapter selection per language, the spaCy pipeline components actually run, and SudachiPy's
split modes (Mode A for the ledger, Mode C for display and audio).

EMPTY BY DESIGN. This file is the G1 lane's; `p2-deps-scaffold` created it and
put nothing in it, so that lane can add its thresholds without a merge conflict against
another lane's file. A constant that two stages share belongs in `config/base.py`
instead — and a constant that lives in neither is a rule violation
`tests/test_cli.py::test_no_constant_lives_outside_config` fails the build on.

Owner: p2-g1-analyze
"""

from __future__ import annotations
