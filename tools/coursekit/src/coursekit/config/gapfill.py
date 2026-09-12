"""Constants owned by gapfill (G5).

Model ids, over-generation factor, and the batch shape. R10: `effort` errors on claude-
haiku-4-5, which is still on the `thinking`/`budget_tokens` shape, while `budget_tokens` 400s on
opus-5/sonnet-5 — so the request shape is per model, never one global constant. There are no API
keys in this environment: the local path is an Opus agent authoring candidates into a file this
stage reads.

EMPTY BY DESIGN. This file is the G5 lane's; `p2-deps-scaffold` created it and
put nothing in it, so that lane can add its thresholds without a merge conflict against
another lane's file. A constant that two stages share belongs in `config/base.py`
instead — and a constant that lives in neither is a rule violation
`tests/test_cli.py::test_no_constant_lives_outside_config` fails the build on.

Owner: p2-g5-gapfill
"""

from __future__ import annotations
