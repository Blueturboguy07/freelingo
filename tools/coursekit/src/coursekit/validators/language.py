"""V8 — "perplexity inside the band; grammar rules where an engine exists".

And, first, the gate that makes the rest of that sentence mean anything.

## INV-PACK-14

> **V8** records which engines actually ran per language (`grammar_engine`,
> `spellcheck_engine`) and degrades to the named fallback. **A validator that reports
> "0 errors" when no engine ran fails this gate.**

Every other validator in the suite reads rows. V8 reads rows *and* a claim about the
machine that produced them, because its own headline number — grammar errors found — is
produced identically by a clean course and by a sidecar nobody started. Those are the two
states this file exists to keep apart, and the cost of confusing them is a pack that
ships with a validator report saying "V8: 0 errors" over text nothing ever read.

So V8 does not check sentences and then mention its engines. It refuses to report at all
until G6 has told it what ran:

1. No G6 entry, or a failed one → **blocking**. V8 cannot conclude anything.
2. An entry that does not carry all four engine fields → **blocking**. A missing field
   is not `none`; it is an unanswered question, and the fix is a G6 that answers it.
3. Both `grammar_engine` and `perplexity_engine` are `none` → **blocking**, by name:
   nothing that can find an error was present. `spellcheck_engine: none` is not in this
   set — Japanese has no spell checker and still has 735 grammar rules — and neither is
   back-translation, which in an environment with no hosted model is a rubric score an
   agent wrote, not an engine.
4. Exactly one missing → the degradation must be **named** (`perplexity_only`) and is
   reported as a finding, not swallowed.

Only then does it report on what G6 found, and it copies the four engine strings into its
own runlog entry so the manifest, the pack card (INV-PACK-55) and a reviewer all read the
same four values.

## What "the named fallback" costs, per language

Measured against a local LanguageTool 6.6 sidecar on 2026-09-12 rather than read off the
rule table, because that table has been read backwards once (review R1):

| Language | grammar | spellcheck | degrades to |
| -------- | ------- | ---------- | ----------- |
| es | 1,644 rules; `CONCORDANCIAS_ATRIBUTO` fires | `MORFOLOGIK_RULE_ES` fires | nothing |
| ja | 735 rules | the nonce probe raises nothing | `spellcheck_engine: none` |

Spanish — the language this phase ships — degrades on neither axis when the sidecar is
up, which is not what `deep/10` said and not what its correction says either. It is what
the server says.
"""

from __future__ import annotations

from typing import Any

from ..artifacts import read_records
from ..config.g6 import (
    DEGRADED_TO_PERPLEXITY_ONLY,
    ENGINE_FIELDS,
    ENGINE_NONE,
    ENGINES_THAT_CAN_FIND_AN_ERROR,
)
from ..runlog import read_entries
from . import Finding, ValidatorContext, register_validator

__all__ = ["perplexity_and_grammar"]


def _blocking(message: str, subject: str = "", **detail: Any) -> Finding:
    return Finding(
        validator_id="V8", severity="blocking", message=message, subject=subject, detail=detail
    )


@register_validator("V8")
def perplexity_and_grammar(ctx: ValidatorContext) -> list[Finding]:
    """Report G6's language findings — and refuse to report a pass over nothing."""
    entries = read_entries(ctx.lang, stage="g6")
    if not entries:
        ctx.entry.note(**dict.fromkeys(ENGINE_FIELDS, ENGINE_NONE), source="g6", ran=False)
        return [
            _blocking(
                "G6 has no entry in the runlog, so no language engine ran over this "
                "course. V8 reports no result rather than zero errors: the two are "
                "indistinguishable in the output and only one of them is a pass "
                "(INV-PACK-14). Run `coursekit build "
                f"{ctx.lang} --only g6` first."
            )
        ]

    entry = entries[-1]
    notes: dict[str, Any] = entry["notes"]

    if entry["status"] != "ok":
        ctx.entry.note(
            **{field: notes.get(field, ENGINE_NONE) for field in ENGINE_FIELDS},
            source="g6",
            ran=False,
            g6_status=entry["status"],
        )
        return [
            _blocking(
                f"the last G6 run has status {entry['status']!r}. A stage that failed "
                f"checked an unknown fraction of the candidates, and a partial check "
                f"reports the same zero as no check at all."
            )
        ]

    absent_fields = [field for field in ENGINE_FIELDS if field not in notes]
    if absent_fields:
        ctx.entry.note(
            **{field: notes.get(field, ENGINE_NONE) for field in ENGINE_FIELDS},
            source="g6",
            ran=False,
            fields_missing=absent_fields,
        )
        return [
            _blocking(
                f"G6's entry does not record {', '.join(absent_fields)}. A missing "
                f"engine field is an unanswered question, not a {ENGINE_NONE!r}: V8 "
                f"cannot tell whether that engine ran, so it reports nothing."
            )
        ]

    engines = {field: notes[field] for field in ENGINE_FIELDS}
    ctx.entry.note(
        **engines,
        source="g6",
        ran=True,
        degraded_to=notes.get("degraded_to", ""),
        checked=notes.get("checked", 0),
        rejected_by_axis=notes.get("rejected_by_axis", {}),
        backtranslation_authorship=notes.get("backtranslation_authorship", ""),
    )

    findings: list[Finding] = []

    dead = [field for field in ENGINES_THAT_CAN_FIND_AN_ERROR if engines[field] == ENGINE_NONE]
    if len(dead) == len(ENGINES_THAT_CAN_FIND_AN_ERROR):
        findings.append(
            _blocking(
                f"no engine that can find an error ran: {', '.join(dead)} are all "
                f"{ENGINE_NONE!r}. G6 reported {notes.get('rejected_by_axis', {})} over "
                f"{notes.get('checked', 0)} candidate(s), which is zero errors from "
                f"nothing — the exact reading INV-PACK-14 fails.",
                subject=ctx.lang,
                engines=engines,
            )
        )
        return findings

    if dead:
        degraded_to = notes.get("degraded_to", "")
        if degraded_to != DEGRADED_TO_PERPLEXITY_ONLY:
            findings.append(
                _blocking(
                    f"{', '.join(dead)} did not run and G6 named the fallback as "
                    f"{degraded_to!r}. A degradation must be named: 'degrades to the "
                    f"named fallback' is the half of INV-PACK-14 that tells a reader of "
                    f"the manifest what this pack's naturalness claim is worth.",
                    subject=ctx.lang,
                    engines=engines,
                )
            )
        else:
            findings.append(
                Finding(
                    validator_id="V8",
                    severity="warning",
                    message=(
                        f"degraded to {degraded_to}: {', '.join(dead)} was not available. "
                        f"Naturalness rests on the perplexity band alone for this pack."
                    ),
                    subject=ctx.lang,
                    detail={"engines": engines},
                )
            )

    if engines["spellcheck_engine"] == ENGINE_NONE:
        findings.append(
            Finding(
                validator_id="V8",
                severity="info",
                message=(
                    "no spell checker ran for this language. LanguageTool has none for "
                    "Japanese (735 grammar rules, no spell check — the inverse of what "
                    "deep/10 stated, corrected by R1); for any other language this means "
                    "the sidecar was not up."
                ),
                subject=ctx.lang,
                detail={"engines": engines},
            )
        )

    if engines["backtranslation_engine"] == ENGINE_NONE:
        findings.append(
            Finding(
                validator_id="V8",
                severity="warning",
                message=(
                    "the back-translation axis did not run, so no candidate was checked "
                    "for meaning drift between its Spanish and the English a learner is "
                    "shown."
                ),
                subject=ctx.lang,
            )
        )

    # A run that examined nothing is not a clean run, even with every engine present.
    try:
        accepted = sum(1 for row in read_records("candidate", lang=ctx.lang) if row["accepted"])
    except FileNotFoundError:
        return [
            *findings,
            _blocking(
                "G6 reported a successful run and there is no candidate artefact it "
                "could have read. Whatever that run checked, it was not this course.",
                subject=ctx.lang,
            ),
        ]
    if notes.get("checked", 0) == 0 and accepted:
        findings.append(
            _blocking(
                f"G6 recorded every engine but checked 0 candidates, while "
                f"{accepted} are still accepted. Engines that ran over nothing find "
                f"nothing.",
                subject=ctx.lang,
            )
        )

    starved = notes.get("slots_without_survivor", [])
    if starved:
        findings.append(
            _blocking(
                f"{len(starved)} slot(s) have no candidate left after the language "
                f"checks: {', '.join(starved)}. The slot is unfilled; it is never "
                f"filled by a rejected candidate.",
                subject=ctx.lang,
                slots=starved,
            )
        )

    rejected = notes.get("rejected_by_axis", {})
    if any(rejected.values()):
        findings.append(
            Finding(
                validator_id="V8",
                severity="info",
                message=(
                    f"language checks narrowed {sum(rejected.values())} of "
                    f"{notes.get('checked', 0)} candidate(s): {rejected}"
                ),
                subject=ctx.lang,
                detail={"engines": engines},
            )
        )

    return findings
