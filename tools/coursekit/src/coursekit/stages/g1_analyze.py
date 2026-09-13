"""G1 Analyze — segment, lemmatise, morph-feature bundle and UD POS per token.

`scope2/00` §2.3: "Segment -> lemmatize -> morph-feature bundle per token, both sides;
emit SLAM-style UD tags", gated on an **adapter self-test corpus**. That gate is the
first thing this stage runs, before it reads a single corpus row, because everything
after it is partitioned by the lemmatiser's output.

The stage does four things and reports all four:

1. Runs the adapter's frozen self-test. A disagreement is fatal.
2. Analyses every G0 row into an `analysed_sentence`.
3. Reports **mean content-words-per-sentence** for the pack (INV-PACK-40) and writes the
   whole ledger declaration into the runlog, where G9 picks it up for the manifest.
4. **Applies** the pack's own length window — this is the first stage that can, because
   the window is in ledger units and ledger units need the adapter — and counts what it
   drops. A small tail is expected and is dropped: G0 filtered on letter runs because no
   morphology model existed yet, and spaCy splits `del` into two lemmas. A tail above
   `LENGTH_DRIFT_MAX_RATE` is the numeric half of INV-PACK-40 — G0 measured length with a
   materially different notion of a token — and fails the stage. The grep gate in
   `tests/test_ledger_unit.py` is the static half; this is the one that fires on a real
   corpus. Measured on the first real `es` build: 15 of 2,823, 0.53%.
"""

from __future__ import annotations

from collections import Counter
from typing import Any

from ..adapters import ADAPTERS
from ..artifacts import read_records, validate_record, write_records
from ..config.g1 import ADAPTER_BY_LANGUAGE, LENGTH_DRIFT_MAX_RATE
from ..config.japanese_script import READING_REVIEW_STATUS
from ..inputs import MissingInput, licence_row, resolve
from ..japanese_script import ScriptAnalysisError, validate_script_analysis
from ..ledger import (
    count_units,
    ledger_declaration,
    ledger_unit,
    length_ok,
    length_window,
    mean_content_words_per_sentence,
)
from ..runlog import require_successful
from . import StageContext, StageResult, register_stage

__all__ = ["analyze"]


@register_stage(
    "g1",
    reads=("ingested_sentence",),
    writes=("analysed_sentence", "japanese_script_analysis"),
    requires_group="nlp",
)
def analyze(ctx: StageContext) -> StageResult:
    """Analyse every ingested sentence. Fails loudly rather than skipping quietly."""
    require_successful(ctx.lang, ("g0",))
    adapter = adapter_for(ctx.lang)

    # The gate, first. A lemmatiser that has moved must not be allowed to write rows.
    adapter.require_self_test()
    fingerprint = adapter.fingerprint()
    ctx.entry.note(
        adapter=fingerprint,
        adapter_selftest="ok",
        ledger_unit=ledger_unit(ctx.lang),
    )

    source = resolve(ADAPTER_BY_LANGUAGE[ctx.lang], ctx.lang)
    ctx.entry.record_input(source.id)
    ctx.entry.record_licence(licence_row(source))

    paired_analyse = getattr(adapter, "analyse_with_script", None)
    if ctx.lang == "ja" and not callable(paired_analyse):
        raise MissingInput("Japanese G1 requires a paired analyse_with_script adapter")
    analysed: list[dict[str, Any]] = []
    scripts_by_id: dict[str, dict[str, Any]] = {}
    seen_source_ids: set[str] = set()
    rejection_reasons: Counter[str] = Counter()
    rejected = 0
    read = 0
    for row in read_records("ingested_sentence", lang=ctx.lang):
        read += 1
        ctx.entry.read = read
        if ctx.lang == "ja":
            if row["lang"] != ctx.lang or row["sentence_id"] in seen_source_ids:
                raise ScriptAnalysisError(
                    "Japanese G0 population has a foreign or duplicate source"
                )
            seen_source_ids.add(row["sentence_id"])
        try:
            if ctx.lang == "ja":
                pair = paired_analyse(sentence_id=row["sentence_id"], text=row["text"])
                analysis = getattr(pair, "analysed", None)
                script = getattr(pair, "script", None)
                # The schema alone cannot bind an artifact to the input population.
                # Validate both the record and its exact source before writing either.
                validate_script_analysis(script, analysis, text=row["text"])
                if analysis["adapter"] != fingerprint:
                    raise ScriptAnalysisError(
                        "Japanese paired analysis differs from stage fingerprint"
                    )
                validate_record("japanese_script_analysis", script)
                analysed.append(analysis)
                scripts_by_id[row["sentence_id"]] = script
            else:
                analysed.append(adapter.analyse(sentence_id=row["sentence_id"], text=row["text"]))
        except MissingInput as exc:
            # A sentence the adapter cannot turn into a single ledger unit is dropped and
            # COUNTED. Dropping silently is how a corpus loses a percent of itself
            # between two stages and nobody can say which one.
            rejected += 1
            rejection_reasons[str(exc)] += 1

    ctx.entry.read = read
    ctx.entry.rejected = rejected
    ctx.entry.note(source_rejection_reasons=dict(sorted(rejection_reasons.items())))

    if not analysed and read:
        return StageResult(
            ok=False,
            message=(
                f"{read} ingested sentence(s) and not one produced a ledger unit. The "
                f"adapter is running but is analysing nothing usable."
            ),
        )

    # The window, applied in the unit the pack declares. Everything downstream joins on
    # `analysed_sentence`, so a row dropped here never reaches a lesson slot.
    outside = length_report(ctx.lang, analysed)
    in_window = [record for record in analysed if length_ok(record)]
    dropped = len(analysed) - len(in_window)
    rate = dropped / len(analysed) if analysed else 0.0

    # Filter the paired population with the very same retained G1 rows. No independent
    # length rule or second analysis may pick a different set for display/audio.
    scripts = [scripts_by_id[row["sentence_id"]] for row in in_window] if ctx.lang == "ja" else []
    written = write_records("analysed_sentence", in_window, lang=ctx.lang)
    ctx.entry.record_output("analysed_sentence")
    if ctx.lang == "ja":
        write_records("japanese_script_analysis", scripts, lang=ctx.lang)
        ctx.entry.record_output("japanese_script_analysis")
        ctx.entry.note(
            paired_script_rows=len(scripts), script_reading_review_status=READING_REVIEW_STATUS
        )
    ctx.entry.read = read
    ctx.entry.written = written
    ctx.entry.rejected = rejected + dropped

    mean_content = mean_content_words_per_sentence(in_window)
    ctx.entry.note(
        ledger=ledger_declaration(ctx.lang, mean_content_words_per_sentence=mean_content),
        mean_content_words_per_sentence=mean_content,
        outside_length_window=outside,
        outside_length_window_rate=round(rate, 6),
        outside_length_window_max_rate=LENGTH_DRIFT_MAX_RATE,
    )

    if rate > LENGTH_DRIFT_MAX_RATE:
        minimum, maximum = length_window(ctx.lang)
        return StageResult(
            ok=False,
            message=(
                f"{dropped} of {len(analysed)} sentence(s) ({rate:.1%}) fall outside the "
                f"pack's length window {minimum}-{maximum} {ledger_unit(ctx.lang)}(s) — "
                f"shortest {outside['min']}, longest {outside['max']} — which is over the "
                f"{LENGTH_DRIFT_MAX_RATE:.0%} drift this stage tolerates between G0's "
                f"pre-analysis count and the ledger's. A tail is expected (spaCy splits "
                f"`del` into two lemmas); a tail this size means G0 filtered with a "
                f"materially different notion of a token, which is INV-PACK-40's failure "
                f"mode measured on real data."
            ),
        )

    return StageResult(
        ok=True,
        detail={
            "analysed": written,
            "rejected": rejected + dropped,
            "outside_length_window": dropped,
            "mean_content_words_per_sentence": mean_content,
            "adapter": fingerprint,
        },
    )


def adapter_for(lang: str):  # noqa: ANN201 — the adapters are structurally typed
    """The registered morphology adapter for a language, or a named failure.

    `scope2/00` §2.1 puts this input in the "**None.** Hard gate" column: there is no
    fallback tokeniser, because a ledger built by a worse one is wrong in a way every
    downstream validator agrees with.
    """
    build = ADAPTERS.get(lang)
    if build is None:
        raise MissingInput(
            f"no morphology adapter is registered for {lang!r}. Registered: "
            f"{', '.join(ADAPTERS.ids()) or '(none)'}. The ledger is lemma-level and "
            f"there is no fallback: without an adapter, inflected languages break "
            f"silently and a language with no whitespace becomes one unknown token per "
            f"sentence, at which point i+1 no-ops and every validator still passes."
        )
    return build()


def length_report(lang: str, analysed: list[dict[str, Any]]) -> dict[str, int | None]:
    """How many analysed rows fall outside the pack's own window, and the extremes."""
    lengths = [count_units(record) for record in analysed]
    offenders = [record for record in analysed if not length_ok(record)]
    return {
        "count": len(offenders),
        "min": min(lengths) if lengths else None,
        "max": max(lengths) if lengths else None,
    }
