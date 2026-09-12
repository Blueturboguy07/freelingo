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
4. Exactly one missing → the degradation must be **named**, and the name is the one
   belonging to the engine that SURVIVED: `perplexity_only` when grammar is gone,
   `grammar_only` when the perplexity model is. Both are a warning carrying what the
   pack lost and the command that gives it back — never a block, because one engine that
   can find an error did run. `scope2/00` §2.4 names only the first of the two; the
   second is the likelier one on a real machine (a LanguageTool sidecar is one command,
   a perplexity band needs a model trained over a corpus), and before it had a name this
   validator blocked that run and told the operator to name the fallback after the engine
   that was *missing*.
5. Any engine id naming a stand-in (`mock_lt`) → a warning. It may not block, or
   `pack-ci.yml` could not exercise G6 without a JDK at all; it may not be silent either,
   because "0 grammar errors" from a 40-line mock is not "0 grammar errors" from 1,644
   XML rules.

Only then does it report on what G6 found, and it copies the four engine strings into its
own runlog entry so the manifest, the pack card (INV-PACK-55) and a reviewer all read the
same four values.

## What "the named fallback" costs, per language

Measured against a local LanguageTool 6.6 sidecar on 2026-09-12 — the real
`languagetool-server.jar` (build `f3e8d91`) under Java 22.0.1 — rather than read off the
rule table, because that table has been read backwards once (review R1):

| Language | grammar | spellcheck | degrades to |
| -------- | ------- | ---------- | ----------- |
| es | 1,644 rules; `CONCORDANCIAS_ATRIBUTO` fires | `MORFOLOGIK_RULE_ES` fires | nothing |
| de | 5,224 rules | `GERMAN_SPELLER_RULE` fires | nothing |
| fr | 6,984 rules | `FR_SPELLING_RULE` fires — but only for the right probe | nothing |
| ja | 735 rules | nothing, across four nonce probes | `spellcheck_engine: none` |

Spanish — the language this phase ships — degrades on neither axis when the sidecar is
up, which is not what `deep/10` said and not what its correction says either. It is what
the server says.

The French row is the second thing running the jar changed: `Je xqzptv dans la maison.`
raises `JE_VERBE` / `uncategorized` and no misspelling at all, so that probe concludes
French has no spell checker and degrades a pack on an axis that works. `config/g6.py`
carries the whole table and the corrected sentence.
"""

from __future__ import annotations

from typing import Any

from ..artifacts import read_records
from ..config.g6 import (
    DEGRADATION_COST,
    DEGRADATION_NAMES,
    ENGINE_FIELDS,
    ENGINE_NONE,
    ENGINES_THAT_CAN_FIND_AN_ERROR,
    MOCK_ENGINE_IDS,
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
        # The name belongs to the SURVIVING engine, not the missing one, and there is one
        # for each direction. Deriving it from `dead` rather than comparing against a
        # single constant is what closes the defect the adversarial pass found: with a
        # grammar engine up and no KenLM model — the likelier configuration, since a
        # sidecar is one command and a band needs a trained model — V8 blocked the run
        # and told the operator to name the fallback `perplexity_only`, after the engine
        # that was missing.
        expected = DEGRADATION_NAMES[dead[0]]
        degraded_to = notes.get("degraded_to", "")
        if degraded_to != expected:
            findings.append(
                _blocking(
                    f"{', '.join(dead)} did not run and G6 named the fallback as "
                    f"{degraded_to!r}; the name for this state is {expected!r}. A "
                    f"degradation must be named: 'degrades to the named fallback' is the "
                    f"half of INV-PACK-14 that tells a reader of the manifest what this "
                    f"pack's naturalness claim is worth.",
                    subject=ctx.lang,
                    engines=engines,
                    expected_degraded_to=expected,
                )
            )
        else:
            # A warning, in BOTH directions, and deliberately not a block: one engine
            # that can find an error did run, so the pack is weaker rather than
            # unchecked. Only the empty intersection blocks, above.
            findings.append(
                Finding(
                    validator_id="V8",
                    severity="warning",
                    message=(
                        f"degraded to {degraded_to}: {', '.join(dead)} was not available. "
                        f"{DEGRADATION_COST[expected]}"
                    ),
                    subject=ctx.lang,
                    detail={"engines": engines, "degraded_to": expected},
                )
            )

    mocks = sorted(
        f"{field}={value}"
        for field, value in engines.items()
        if value.split("/")[0] in MOCK_ENGINE_IDS
    )
    if mocks:
        findings.append(
            Finding(
                validator_id="V8",
                severity="warning",
                message=(
                    f"validated against a stand-in, not the engine it imitates: "
                    f"{', '.join(mocks)}. `mock_lt` exists so pack-ci can exercise G6 "
                    f"with no JDK; it is not LanguageTool and this course has not met "
                    f"1,644 XML rules. A release pack must be re-validated against the "
                    f"jar."
                ),
                subject=ctx.lang,
                detail={"engines": engines, "mock_engines": mocks},
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
