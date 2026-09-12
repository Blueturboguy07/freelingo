"""Constants owned by package (G9).

Manifest fields, the attribution table shape, and the budget assertion. INV-PACK-15 covers all
three pipelines (lesson, story, radio), not lessons alone (R14).

EMPTY BY DESIGN. This file is the G9 lane's; `p2-deps-scaffold` created it and
put nothing in it, so that lane can add its thresholds without a merge conflict against
another lane's file. A constant that two stages share belongs in `config/base.py`
instead — and a constant that lives in neither is a rule violation
`tests/test_cli.py::test_no_constant_lives_outside_config` fails the build on.

Owner: p2-g9-package
"""

from __future__ import annotations
