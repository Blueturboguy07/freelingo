"""Thin dispatchers. Every one of them is the same three steps.

    1. Check the language against `config.LANGUAGES`.                    -> exit 1
    2. Ask the registry for the stages or validators this verb needs.
       Anything unregistered: say which, exit 2.                          -> exit 2
    3. Run what is registered, in order, each inside its runlog entry.    -> 0 / 3 / 4

Step 2 is the only interesting one. `coursekit build es` with nothing registered must
exit **2**, never 0, and it must name the missing stages — because the alternative is a
tool that prints nothing and returns success while producing no pack, which is
indistinguishable from a fast build. `tests/test_cli.py` proves the rule is not vacuous
by registering every stage, watching the same command exit 0, then removing one and
watching it go back to 2.

No command in this package knows what any stage does. That is what lets a wave-2 lane
add `coursekit/stages/select.py` and change nothing here.
"""

from __future__ import annotations

from ._run import (
    check_language,
    fail,
    run_stages,
    run_validators,
)

__all__ = ["check_language", "fail", "run_stages", "run_validators"]
