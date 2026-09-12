"""Constants owned by ingest (G0).

Corpus choice per language, dedup thresholds, the 3-12 token A1 length window, the
register/profanity filter, and the script-normalisation table (diacritics stripped BEFORE the
ledger, or one lemma counts as two).

EMPTY BY DESIGN. This file is the G0 lane's; `p2-deps-scaffold` created it and
put nothing in it, so that lane can add its thresholds without a merge conflict against
another lane's file. A constant that two stages share belongs in `config/base.py`
instead — and a constant that lives in neither is a rule violation
`tests/test_cli.py::test_no_constant_lives_outside_config` fails the build on.

Owner: p2-g0-ingest
"""

from __future__ import annotations
