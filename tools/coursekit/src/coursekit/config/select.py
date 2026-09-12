"""Constants owned by select (G4).

The ledger window, how many sentences a lesson slot needs, and the shippable-corpus filter that
keeps oracle-only text out of a lesson.

EMPTY BY DESIGN. This file is the G4 lane's; `p2-deps-scaffold` created it and
put nothing in it, so that lane can add its thresholds without a merge conflict against
another lane's file. A constant that two stages share belongs in `config/base.py`
instead — and a constant that lives in neither is a rule violation
`tests/test_cli.py::test_no_constant_lives_outside_config` fails the build on.

Owner: p2-g4-select
"""

from __future__ import annotations
