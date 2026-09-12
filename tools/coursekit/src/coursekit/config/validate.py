"""Constants owned by validate (G6).

Per-language perplexity bands and LanguageTool severity thresholds. French has 6,984 rules to
Spanish's 1,644, so one global threshold is wrong by 4.2x. R1: Japanese has 735 GRAMMAR rules
and no spell checker, so the degradation to record is `spellcheck_engine: none`.

EMPTY BY DESIGN. This file is the G6 lane's; `p2-deps-scaffold` created it and
put nothing in it, so that lane can add its thresholds without a merge conflict against
another lane's file. A constant that two stages share belongs in `config/base.py`
instead — and a constant that lives in neither is a rule violation
`tests/test_cli.py::test_no_constant_lives_outside_config` fails the build on.

Owner: p2-g6-validate
"""

from __future__ import annotations
