"""Constants owned by curriculum (G3).

Section skeleton and CEFR labels, units per section, new-item rate, the recycling window (V3's N
and K), and the register slot per language.

EMPTY BY DESIGN. This file is the G3 lane's; `p2-deps-scaffold` created it and
put nothing in it, so that lane can add its thresholds without a merge conflict against
another lane's file. A constant that two stages share belongs in `config/base.py`
instead — and a constant that lives in neither is a rule violation
`tests/test_cli.py::test_no_constant_lives_outside_config` fails the build on.

Owner: p2-g3-curriculum
"""

from __future__ import annotations
