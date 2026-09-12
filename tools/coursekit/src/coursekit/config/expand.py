"""Constants owned by expand (G7).

Exercise-shape mix per unit, distractor count, the rule core's same-POS / same-band constraints,
and the alignment model. The LLM re-ranks; it never generates a distractor.

EMPTY BY DESIGN. This file is the G7 lane's; `p2-deps-scaffold` created it and
put nothing in it, so that lane can add its thresholds without a merge conflict against
another lane's file. A constant that two stages share belongs in `config/base.py`
instead — and a constant that lives in neither is a rule violation
`tests/test_cli.py::test_no_constant_lives_outside_config` fails the build on.

Owner: p2-g7-expand
"""

from __future__ import annotations
