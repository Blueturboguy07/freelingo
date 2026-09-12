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
4. Counts how many rows fall outside the pack's own length window. That number should be
   zero — G0 already filtered — and a non-zero one is the numeric half of INV-PACK-40:
   G0 measured length with a different notion of a token than the ledger uses. The grep
   gate in `tests/test_ledger_unit.py` is the static half; this is the one that fires on
   a real corpus.
"""

from __future__ import annotations

from typing import Any

from ..adapters import ADAPTERS
from ..artifacts import read_records, write_records
from ..config.g1 import ADAPTER_BY_LANGUAGE
from ..inputs import MissingInput, licence_row, resolve
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
    writes=("analysed_sentence",),
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

    analysed: list[dict[str, Any]] = []
    rejected = 0
    read = 0
    for row in read_records("ingested_sentence", lang=ctx.lang):
        read += 1
        try:
            analysed.append(adapter.analyse(sentence_id=row["sentence_id"], text=row["text"]))
        except MissingInput:
            # A sentence the adapter cannot turn into a single ledger unit is dropped and
            # COUNTED. Dropping silently is how a corpus loses a percent of itself
            # between two stages and nobody can say which one.
            rejected += 1

    if not analysed and read:
        return StageResult(
            ok=False,
            message=(
                f"{read} ingested sentence(s) and not one produced a ledger unit. The "
                f"adapter is running but is analysing nothing usable."
            ),
        )

    written = write_records("analysed_sentence", analysed, lang=ctx.lang)
    ctx.entry.record_output("analysed_sentence")
    ctx.entry.read = read
    ctx.entry.written = written
    ctx.entry.rejected = rejected

    mean_content = mean_content_words_per_sentence(analysed)
    outside = length_report(ctx.lang, analysed)
    ctx.entry.note(
        ledger=ledger_declaration(ctx.lang, mean_content_words_per_sentence=mean_content),
        mean_content_words_per_sentence=mean_content,
        outside_length_window=outside,
    )

    if outside["count"]:
        minimum, maximum = length_window(ctx.lang)
        return StageResult(
            ok=False,
            message=(
                f"{outside['count']} of {written} sentence(s) fall outside the pack's "
                f"length window {minimum}-{maximum} {ledger_unit(ctx.lang)}(s) — shortest "
                f"{outside['min']}, longest {outside['max']}. G0 filtered this corpus with "
                f"a different notion of a token than the ledger declares, which is "
                f"INV-PACK-40's failure mode measured on real data. G0's length filter "
                f"must read coursekit.ledger.length_window, not count tokens itself."
            ),
        )

    return StageResult(
        ok=True,
        detail={
            "analysed": written,
            "rejected": rejected,
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
