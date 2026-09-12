"""Constants owned by bake (G8).

The voice cast per language, engine selection, and the transcode settings. R15: the Polly roster
forces an accent mix inside one course, which is a recorded founder decision, not a table cell.
R6: the ja MAI/HD voices carry no style tags at all, so SSML prosody is the only lever for the
young character.

EMPTY BY DESIGN. This file is the G8 lane's; `p2-deps-scaffold` created it and
put nothing in it, so that lane can add its thresholds without a merge conflict against
another lane's file. A constant that two stages share belongs in `config/base.py`
instead — and a constant that lives in neither is a rule violation
`tests/test_cli.py::test_no_constant_lives_outside_config` fails the build on.

Owner: p2-g8-bake
"""

from __future__ import annotations
