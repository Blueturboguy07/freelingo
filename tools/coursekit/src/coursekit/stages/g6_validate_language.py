"""G6 — validate language. Perplexity band, grammar rules, back-translation.

G6 is the one stage in `BUILD_STAGE_IDS` that emits no artefact record. It re-reads G5's
candidates, applies the three language checks, flips the ones that fail to
`accepted: false` with a `g6:` reason, and writes a runlog entry. `docs/pipeline.md`:
"a downstream validator reads [the entry] to learn that G6 ran and what it concluded".

**Flipping `accepted` is not patching.** INV-PACK-10 forbids editing content that fails
a filter; this stage only ever narrows the surviving set. No `text` in
`g5/candidates.jsonl` changes, which the tests assert byte for byte across the rewrite.

## The honest part

Every one of the three engines can be absent, and an absent engine finds no errors. That
is the failure INV-PACK-14 exists for: *"a validator that reports 0 errors when no engine
ran fails this gate"*. So this stage never reports a count without reporting what
produced it. Four fields go into the runlog on every run, present whether or not anything
ran:

    grammar_engine · spellcheck_engine · perplexity_engine · backtranslation_engine

each either an engine id carrying its version, or the literal `none`. `degraded_to`
names the fallback when one is missing, **in both directions**: `perplexity_only` when
the grammar engine is absent (the one `scope2/00` §2.4 names) and `grammar_only` when
the perplexity model is. §2.4 naming only the first is not a reason for the second to be
nameless — it is the more common of the two, since a LanguageTool sidecar is one command
and a perplexity band needs a model trained over a corpus. V8 reads these and refuses to
pass on a run where nothing ran.

`spellcheck_engine` is separate from `grammar_engine` because they come apart in
practice, and the way they come apart was got backwards once already: `deep/10` §S6 had
Japanese as spell-check-only, and review R1 found the ✓ was the **Spell check** column
and the quoted sentence was about Norwegian. Probed against a real LanguageTool 6.6
server (`languagetool-server.jar`, build `f3e8d91`, Java 22.0.1) on 2026-09-12: Spanish
raises `MORFOLOGIK_RULE_ES` for a nonce token and Japanese raises nothing across four
nonce shapes, so Japanese is 735 grammar rules with **no** spell checker, and Spanish —
which the correction says nothing about — has both, and degrades to nothing at all.
Running the jar also corrected this lane's own French probe; `config/g6.py` has the
table.

## Requested-but-broken is not the same as not requested

No `--set languagetool_url=` means nobody started a sidecar: `grammar_engine: none`,
degrade, carry on, and let V8 decide whether a pack may ship that way. A URL that does
not answer means somebody meant to validate and did not: the stage fails. The two states
produce the same number of grammar errors — zero — which is exactly why they must not
produce the same exit code.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from ..artifacts import artifact_path, read_records, write_records
from ..config.g5 import GAPFILL_RUBRIC_FILENAME
from ..config.g6 import (
    B3_REVIEW_DEFECT_PAIRS,
    BACKTRANSLATION_AUTHORSHIP,
    BACKTRANSLATION_ENGINE_OPTION,
    BACKTRANSLATION_MIN_SCORE,
    BLOCKING_ISSUE_TYPES,
    DEFAULT_BACKTRANSLATION_ENGINE,
    DEFAULT_GRAMMAR_ENGINE,
    DEFAULT_PERPLEXITY_ENGINE,
    DEGRADATION_NAMES,
    ENGINE_NONE,
    ENGINES_THAT_CAN_FIND_AN_ERROR,
    G6_REJECT_AXES,
    G6_REJECT_PREFIX,
    GRAMMAR_ENGINE_OPTION,
    KENLM_BAND_OPTION,
    KENLM_MODEL_OPTION,
    LANGUAGETOOL_URL_OPTION,
    PERPLEXITY_ENGINE_OPTION,
)
from ..engines import ENGINES
from ..runlog import require_successful
from ..stages.g5_gapfill import authored_candidates_path, authored_candidates_paths
from . import StageContext, StageResult, register_stage

__all__ = ["validate_language"]


def _engine(ctx: StageContext, option: str, default: str) -> tuple[str, Any]:
    """Which engine id this run asked for, and the registered factory behind it."""
    engine_id = ctx.options.get(option, default)
    factory = ENGINES.get(engine_id)
    if factory is None:
        raise RuntimeError(
            f"--set {option}={engine_id!r} names no registered engine; "
            f"coursekit/engines/ declares {', '.join(sorted(ENGINES.ids()))}"
        )
    return engine_id, factory


def _probe(built: Any, lang: str, fields: tuple[str, ...]) -> dict[str, Any]:
    """A uniform probe result, including for an engine nobody asked for."""
    if built is None:
        return {
            "available": False,
            "requested": False,
            "reason": "not requested: no option named a model or a server for this run",
            "detail": {},
            **dict.fromkeys(fields, ENGINE_NONE),
        }
    report = dict(built.probe(lang))
    report["requested"] = True
    for field in fields:
        report.setdefault(field, ENGINE_NONE)
    return report


@register_stage("g6", reads=("candidate",), writes=())
def validate_language(ctx: StageContext) -> StageResult:
    """Narrow G5's surviving candidates, and record which engines did the narrowing."""
    require_successful(ctx.lang, ("g5",))

    _, grammar_factory = _engine(ctx, GRAMMAR_ENGINE_OPTION, DEFAULT_GRAMMAR_ENGINE)
    _, perplexity_factory = _engine(ctx, PERPLEXITY_ENGINE_OPTION, DEFAULT_PERPLEXITY_ENGINE)
    _, backtranslation_factory = _engine(
        ctx, BACKTRANSLATION_ENGINE_OPTION, DEFAULT_BACKTRANSLATION_ENGINE
    )

    grammar = grammar_factory(ctx.options.get(LANGUAGETOOL_URL_OPTION))
    perplexity = perplexity_factory(
        ctx.options.get(KENLM_MODEL_OPTION), ctx.options.get(KENLM_BAND_OPTION)
    )
    # EVERY authored file, not just the legacy single one: the rubric score lives beside
    # the sentence that was scored, and after sharding those sentences are in
    # `content/<lang>/candidates/*.jsonl`. Passing one path here probed a file the P2 fix
    # round had emptied out, so the engine reported `none` and this stage failed the build
    # with "an engine was requested and could not run" while every score existed on disk.
    backtranslation = backtranslation_factory(
        [str(path) for path in authored_candidates_paths(ctx.lang)]
    )

    grammar_probe = _probe(grammar, ctx.lang, ("grammar_engine", "spellcheck_engine"))
    perplexity_probe = _probe(perplexity, ctx.lang, ("perplexity_engine",))
    backtranslation_probe = _probe(backtranslation, ctx.lang, ("backtranslation_engine",))

    engines = {
        "grammar_engine": grammar_probe["grammar_engine"],
        "spellcheck_engine": grammar_probe["spellcheck_engine"],
        "perplexity_engine": perplexity_probe["perplexity_engine"],
        "backtranslation_engine": backtranslation_probe["backtranslation_engine"],
    }

    # A run that asked for an engine and could not have it is a broken build, not a
    # degraded one. Recorded first so the entry carries the engine fields either way.
    broken = [
        f"{name}: {probe['reason']}"
        for name, probe in (
            ("grammar", grammar_probe),
            ("perplexity", perplexity_probe),
            ("backtranslation", backtranslation_probe),
        )
        if probe["requested"] and not probe["available"]
    ]

    rows = list(read_records("candidate", lang=ctx.lang))
    rejected_by_axis = dict.fromkeys(G6_REJECT_AXES, 0)
    checked = 0
    checked_answers = 0
    perplexities: list[float] = []
    findings: list[dict[str, Any]] = []
    out: list[dict[str, Any]] = []

    for row in rows:
        if not row["accepted"] or broken:
            out.append(row)
            continue
        checked += 1
        axis = None
        detail: dict[str, Any] = {}
        surfaces = [
            ("preferred", row["text"]),
            *(("alternate", alternate) for alternate in row["accepted_alternates"]),
        ]
        for answer_kind, surface in surfaces:
            checked_answers += 1
            checked_row = dict(row)
            checked_row["text"] = surface
            axis, detail = _axis(
                checked_row,
                ctx.lang,
                grammar if grammar_probe["available"] else None,
                perplexity if perplexity_probe["available"] else None,
                backtranslation if backtranslation_probe["available"] else None,
                perplexities,
            )
            if axis is not None:
                detail = {"answer_kind": answer_kind, "answer": surface, **detail}
                break
        if axis is None:
            out.append(row)
            continue
        rejected_by_axis[axis] += 1
        findings.append({"candidate_id": row["candidate_id"], "axis": axis, **detail})
        narrowed = dict(row)
        narrowed["accepted"] = False
        narrowed["reject_reason"] = f"{G6_REJECT_PREFIX}{axis}"
        out.append(narrowed)

    write_records("candidate", out, lang=ctx.lang)

    survivors: dict[tuple[int, int, int], int] = {}
    for row in out:
        key = (row["unit_index"], row["lesson_index"], row["slot_index"])
        survivors[key] = survivors.get(key, 0) + (1 if row["accepted"] else 0)
    starved = sorted(
        f"u{unit}/l{lesson}/s{slot}"
        for (unit, lesson, slot), count in survivors.items()
        if count == 0
    )

    ctx.entry.read = len(rows)
    ctx.entry.written = 0
    ctx.entry.rejected = sum(rejected_by_axis.values())
    ctx.entry.note(
        **engines,
        engines_ran=sorted(name for name, value in engines.items() if value != ENGINE_NONE),
        degraded_to=_degraded_to(engines),
        engine_detail={
            "grammar": grammar_probe,
            "perplexity": perplexity_probe,
            "backtranslation": backtranslation_probe,
        },
        backtranslation_authorship=BACKTRANSLATION_AUTHORSHIP,
        backtranslation_rubric=str(
            authored_candidates_path(ctx.lang).parent / GAPFILL_RUBRIC_FILENAME
        ),
        checked=checked,
        checked_answers=checked_answers,
        rejected_by_axis=rejected_by_axis,
        findings=findings,
        slots_without_survivor=starved,
        perplexity_observed=(
            {"min": min(perplexities), "max": max(perplexities)} if perplexities else {}
        ),
        candidates_file=str(artifact_path(ctx.lang, "candidate")),
        text_unchanged=all(a["text"] == b["text"] for a, b in zip(rows, out, strict=True)),
    )

    if broken:
        return StageResult(
            ok=False,
            message=(
                "an engine was requested and could not run: "
                + "; ".join(broken)
                + ". Zero errors from an engine that is not there is the failure "
                "INV-PACK-14 names; nothing was checked and nothing was narrowed."
            ),
        )
    return StageResult(
        ok=True,
        message=(
            f"{checked} checked, {sum(rejected_by_axis.values())} narrowed; "
            f"engines: {', '.join(f'{k}={v}' for k, v in engines.items())}"
        ),
        detail={"rejected_by_axis": rejected_by_axis},
    )


def _degraded_to(engines: dict[str, str]) -> str:
    """The named fallback, or the empty string when nothing was missing.

    Both directions are named. `scope2/00` §2.4 names only `perplexity_only` (grammar
    missing), and this function used to return `""` for the inverse — a grammar engine up
    and no KenLM model, which is the *more likely* of the two on a real machine, because
    a sidecar is one command and a band needs a model trained over a corpus. V8 then
    blocked that run with a message asking the operator to name the fallback as
    `perplexity_only`, i.e. after the engine that was missing. Measured on this branch,
    2026-09-12, which is how it was found.
    """
    dead = [field for field in ENGINES_THAT_CAN_FIND_AN_ERROR if engines[field] == ENGINE_NONE]
    if len(dead) == len(ENGINES_THAT_CAN_FIND_AN_ERROR):
        return ENGINE_NONE
    if len(dead) == 1:
        return DEGRADATION_NAMES[dead[0]]
    return ""


def _axis(
    row: dict[str, Any],
    lang: str,
    grammar: Any,
    perplexity: Any,
    backtranslation: Any,
    perplexities: list[float],
) -> tuple[str | None, dict[str, Any]]:
    """The first G6 axis this candidate fails, or `None`. Never modifies the row."""
    pair = (str(row["text"]), str(row["translation"]))
    if pair in B3_REVIEW_DEFECT_PAIRS:
        return "review_defect", {
            "text": pair[0],
            "translation": pair[1],
            "review": "P2 B3 2026-09-12",
        }

    if perplexity is not None:
        inside, score = perplexity.in_band(row["text"])
        perplexities.append(score)
        if not inside:
            return "perplexity_out_of_band", {
                "perplexity": score,
                "band": list(perplexity.band),
            }

    if grammar is not None:
        blocking = tuple(BLOCKING_ISSUE_TYPES[lang])
        matches = [
            match for match in grammar.check(lang, row["text"]) if match.issue_type in blocking
        ]
        if matches:
            return "grammar", {"matches": [match.to_json() for match in matches]}

    if backtranslation is not None:
        score = backtranslation.score(row["text"])
        if score is None or score < BACKTRANSLATION_MIN_SCORE:
            return "backtranslation", {
                "score": score,
                "minimum": BACKTRANSLATION_MIN_SCORE,
                "judgement": backtranslation.judgement(row["text"]),
            }

    return None, {}


def read_band_file(path: Path) -> dict[str, Any]:
    """The band recorded beside a KenLM model, for `coursekit doctor` and for tests."""
    return json.loads(path.read_text(encoding="utf-8"))
