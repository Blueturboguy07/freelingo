"""Constants owned by band (G2).

Decile boundaries, the CEFRLex-vs-frequency-proxy switch per language, and the band names. Note
R23: the SECTION CEFR label is a G3 output, not a G2 lookup.

EMPTY BY DESIGN. This file is the G2 lane's; `p2-deps-scaffold` created it and
put nothing in it, so that lane can add its thresholds without a merge conflict against
another lane's file. A constant that two stages share belongs in `config/base.py`
instead — and a constant that lives in neither is a rule violation
`tests/test_cli.py::test_no_constant_lives_outside_config` fails the build on.

Owner: p2-g2-band
"""

from __future__ import annotations
