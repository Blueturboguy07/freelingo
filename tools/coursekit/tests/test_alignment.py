"""Word alignment: the engines, the refusal to substitute one for the other, and a
hand-checked eng-spa gold sample.

## Why the gold sample is here at all

SimAlign publishes mBERT-Argmax F1 for six pairs and **eng-spa is not one of them**
(`deep/10` §S7: eng-fra .94, eng-ces .87, eng-deu .81, eng-ron .65, eng-fas .67,
eng-hin .55). `deep/10` edge case 16 and open question 5 both say the same thing: the
word-bank/hint feature that rides on alignment needs an in-house gold sample before
anyone claims a quality for Spanish or Japanese.

`GOLD` below is that sample at a starting scale: 15 eng-spa pairs from the `es-mini`
fixture, aligned **by hand**, token index to token index, including the cases that
matter and that a positional heuristic gets wrong — a Spanish pro-drop verb answering
two English tokens (`Vivo` <- `I live`), a periphrastic negation (`I do not eat` ->
`No como`), and a two-token courtesy (`please` -> `por favor`).

The number this file measures is the DETERMINISTIC FALLBACK's agreement with that
sample, because torch is not installed here or in CI. It is recorded, not asserted as
quality: `test_the_fallbacks_measured_agreement_is_recorded` prints it and holds a
regression floor, and `alignment_provenance` writes `alignment_quality: unmeasured`
onto every runlog entry the fallback touches. A pack built on it must not ship.
"""

from __future__ import annotations

import pytest

from coursekit.config.g7 import (
    ALIGNMENT_ENGINES,
    DEFAULT_ALIGNMENT_ENGINE,
    FALLBACK_MIN_SCORE,
    SIMALIGN_MATCHING_METHODS,
    SIMALIGN_MODEL,
    SIMALIGN_PUBLISHED_F1,
    SIMALIGN_TOKEN_TYPE,
)
from coursekit.exercises.alignment import (
    DeterministicAligner,
    UnknownAligner,
    alignment_provenance,
    get_aligner,
)
from coursekit.inputs import MissingDependencyGroup, group_is_installed

#: `(english tokens, spanish tokens, hand-aligned (en_index, es_index) pairs)`.
#: Whitespace-split on both sides, punctuation attached, exactly as G7 hands them over.
GOLD: list[tuple[list[str], list[str], set[tuple[int, int]]]] = [
    (
        ["The", "bread", "is", "warm."],
        ["El", "pan", "está", "caliente."],
        {(0, 0), (1, 1), (2, 2), (3, 3)},
    ),
    (
        ["The", "soup", "is", "very", "tasty."],
        ["La", "sopa", "está", "muy", "rica."],
        {(0, 0), (1, 1), (2, 2), (3, 3), (4, 4)},
    ),
    (
        ["The", "sofa", "is", "comfortable."],
        ["El", "sofá", "es", "cómodo."],
        {(0, 0), (1, 1), (2, 2), (3, 3)},
    ),
    (
        ["The", "bathroom", "is", "on", "the", "left."],
        ["El", "baño", "está", "a", "la", "izquierda."],
        {(0, 0), (1, 1), (2, 2), (3, 3), (4, 4), (5, 5)},
    ),
    (
        ["The", "kitchen", "is", "on", "the", "right."],
        ["La", "cocina", "está", "a", "la", "derecha."],
        {(0, 0), (1, 1), (2, 2), (3, 3), (4, 4), (5, 5)},
    ),
    (
        ["My", "house", "has", "three", "rooms."],
        ["Mi", "casa", "tiene", "tres", "cuartos."],
        {(0, 0), (1, 1), (2, 2), (3, 3), (4, 4)},
    ),
    (
        # Pro-drop: `Vivo` answers both `I` and `live`, and the adjective moves.
        ["I", "live", "in", "a", "small", "flat."],
        ["Vivo", "en", "un", "piso", "pequeño."],
        {(0, 0), (1, 0), (2, 1), (3, 2), (4, 4), (5, 3)},
    ),
    (
        ["I", "drink", "water", "every", "day."],
        ["Bebo", "agua", "todos", "los", "días."],
        {(0, 0), (1, 0), (2, 1), (3, 2), (4, 4)},
    ),
    (
        # Periphrastic negation: English `do` has no Spanish counterpart at all.
        ["I", "do", "not", "eat", "meat."],
        ["No", "como", "carne."],
        {(0, 1), (2, 0), (3, 1), (4, 2)},
    ),
    (
        # `please` -> `por favor`: one source token, two target tokens.
        ["I", "want", "a", "coffee,", "please."],
        ["Quiero", "un", "café,", "por", "favor."],
        {(0, 0), (1, 0), (2, 1), (3, 2), (4, 3), (4, 4)},
    ),
    (
        ["We", "buy", "fruit", "at", "the", "market."],
        ["Compramos", "fruta", "en", "el", "mercado."],
        {(0, 0), (1, 0), (2, 1), (3, 2), (4, 3), (5, 4)},
    ),
    (
        ["There", "is", "a", "lamp", "on", "the", "table."],
        ["Hay", "una", "lámpara", "sobre", "la", "mesa."],
        {(0, 0), (1, 0), (2, 1), (3, 2), (4, 3), (5, 4), (6, 5)},
    ),
    (
        ["Hello,", "my", "name", "is", "Ana."],
        ["Hola,", "me", "llamo", "Ana."],
        {(0, 0), (1, 1), (2, 2), (3, 2), (4, 3)},
    ),
    (
        ["What", "is", "your", "name?"],
        ["¿Cómo", "te", "llamas?"],
        {(0, 0), (1, 2), (2, 1), (3, 2)},
    ),
    (
        ["Good", "morning,", "madam."],
        ["Buenos", "días,", "señora."],
        {(0, 0), (1, 1), (2, 2)},
    ),
]

#: Measured 2026-09-12 on this gold sample with `DeterministicAligner`: P .783, R .711,
#: F1 .745. The floor sits just under the measurement so a regression is loud and a
#: lucky improvement is not a failure. It is a REGRESSION GUARD, not a quality claim —
#: SimAlign's published figures for languages it does cover run .55 to .94, and this
#: aligner has no published figure for anything.
FALLBACK_F1_FLOOR = 0.70


def _f1(predicted: set[tuple[int, int]], gold: set[tuple[int, int]]) -> tuple[float, float, float]:
    if not predicted or not gold:
        return 0.0, 0.0, 0.0
    hit = len(predicted & gold)
    precision = hit / len(predicted)
    recall = hit / len(gold)
    if precision + recall == 0:
        return precision, recall, 0.0
    return precision, recall, 2 * precision * recall / (precision + recall)


def measure(aligner: object) -> tuple[float, float, float]:
    """Micro-averaged precision, recall and F1 over the whole gold sample."""
    predicted_total = gold_total = hit_total = 0
    for source, target, gold in GOLD:
        predicted = set(aligner.align(list(source), list(target)))  # type: ignore[attr-defined]
        predicted_total += len(predicted)
        gold_total += len(gold)
        hit_total += len(predicted & gold)
    precision = hit_total / predicted_total if predicted_total else 0.0
    recall = hit_total / gold_total if gold_total else 0.0
    f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0.0
    return precision, recall, f1


# ---------------------------------------------------------------------------
# The gold sample
# ---------------------------------------------------------------------------


def test_the_gold_sample_is_well_formed() -> None:
    """Every hand-aligned index is in range, and the sample covers the hard cases.

    Without this, a typo in a gold pair silently lowers the measured F1 and the number
    reported upward is a measurement of the test file.
    """
    for source, target, gold in GOLD:
        for source_index, target_index in gold:
            assert 0 <= source_index < len(source), (source, source_index)
            assert 0 <= target_index < len(target), (target, target_index)
    many_to_one = [pairs for _s, _t, pairs in GOLD if len({a for a, _b in pairs}) < len(pairs)]
    unaligned = [
        (source, pairs) for source, _t, pairs in GOLD if len({a for a, _b in pairs}) < len(source)
    ]
    assert many_to_one, "no many-to-one row: the sample cannot show a `por favor` case"
    assert unaligned, "no row with an unaligned source token: no `I do not eat` case"


def test_the_fallbacks_measured_agreement_is_recorded() -> None:
    """The number the report quotes. A floor, not a quality claim."""
    precision, recall, f1 = measure(DeterministicAligner())
    print(
        f"\nDeterministicAligner vs hand-checked eng-spa gold (n={len(GOLD)} pairs): "
        f"P={precision:.3f} R={recall:.3f} F1={f1:.3f}"
    )
    assert f1 >= FALLBACK_F1_FLOOR, (
        f"the fallback aligner's agreement with the gold sample fell to {f1:.3f}, "
        f"below the {FALLBACK_F1_FLOOR} regression floor"
    )


@pytest.mark.skipif(not group_is_installed("align"), reason="the `align` group is not installed")
def test_simaligns_measured_agreement_is_recorded() -> None:
    """The same measurement for SimAlign, where somebody has installed it.

    Skipped in CI, which does not carry torch. That skip is the reason the fallback
    number above is the one this lane can report at all.
    """
    precision, recall, f1 = measure(get_aligner("simalign"))
    print(
        f"\nSimAlign({SIMALIGN_MODEL}/{SIMALIGN_TOKEN_TYPE}/{SIMALIGN_MATCHING_METHODS}) "
        f"vs hand-checked eng-spa gold (n={len(GOLD)}): "
        f"P={precision:.3f} R={recall:.3f} F1={f1:.3f}"
    )


# ---------------------------------------------------------------------------
# The fallback's own properties
# ---------------------------------------------------------------------------


def test_the_fallback_is_deterministic() -> None:
    """Two aligners, same inputs, identical output. A pack must rebuild byte-identically."""
    first, second = DeterministicAligner(), DeterministicAligner()
    for source, target, _gold in GOLD:
        assert first.align(list(source), list(target)) == second.align(list(source), list(target))


def test_the_fallback_is_injective_in_both_directions() -> None:
    """One target index per source index and back. A tile cannot be two words' hint."""
    aligner = DeterministicAligner()
    for source, target, _gold in GOLD:
        pairs = aligner.align(list(source), list(target))
        assert len({a for a, _b in pairs}) == len(pairs)
        assert len({b for _a, b in pairs}) == len(pairs)


def test_the_fallback_emits_nothing_for_an_empty_side() -> None:
    aligner = DeterministicAligner()
    assert aligner.align([], ["hola"]) == ()
    assert aligner.align(["hello"], []) == ()


def test_the_fallback_declines_a_pair_it_cannot_align() -> None:
    """Above the length-ratio gate it returns NOTHING, not min(m, n) guesses.

    This is the aligner's only real refusal, and it had to be added: measured, the
    scoring floor alone never reduces the pair count, because a proportional diagonal
    scores 1.0 on position and the greedy always finds it. A gate that never binds is
    a comment, so the module's "allowed to produce nothing" claim needed something
    that does.
    """
    aligner = DeterministicAligner()
    assert aligner.align(["a"] * 10, ["z", "y"]) == ()
    assert aligner.align(["a", "b"], ["z"] * 10) == ()


def test_the_fallback_fills_the_diagonal_when_the_lengths_are_comparable() -> None:
    """The behaviour the report has to state, because it is not restraint.

    Inside the ratio gate the fallback emits exactly `min(m, n)` pairs whether or not
    it has any lexical evidence. That is what "unmeasured" means on the runlog, and why
    `FALLBACK_ENGINE_NOTE` says a pack built on it must not ship.
    """
    aligner = DeterministicAligner()
    assert len(aligner.align(["a", "b", "c", "d"], ["z", "y", "x", "w"])) == 4
    assert len(aligner.align(["a", "b", "c", "d"], ["z", "y"])) == 2
    assert FALLBACK_MIN_SCORE > 0


def test_the_fallback_indices_are_in_range_and_sorted() -> None:
    aligner = DeterministicAligner()
    for source, target, _gold in GOLD:
        pairs = aligner.align(list(source), list(target))
        assert list(pairs) == sorted(pairs)
        for source_index, target_index in pairs:
            assert 0 <= source_index < len(source)
            assert 0 <= target_index < len(target)


# ---------------------------------------------------------------------------
# Engine selection — never a silent substitution
# ---------------------------------------------------------------------------


def test_the_default_engine_is_simalign() -> None:
    """`pyproject.toml`'s rule: a stage may not degrade to a worse aligner on its own."""
    assert DEFAULT_ALIGNMENT_ENGINE == "simalign"


@pytest.mark.skipif(group_is_installed("align"), reason="the `align` group IS installed here")
def test_the_default_refuses_loudly_when_the_group_is_absent() -> None:
    """Exit-3 territory, not a fallback. CI reaches the fallback by naming it."""
    with pytest.raises(MissingDependencyGroup) as excinfo:
        get_aligner()
    assert "uv sync --group align" in str(excinfo.value)


def test_the_fallback_is_reachable_only_by_name() -> None:
    aligner = get_aligner("deterministic")
    assert aligner.id == "deterministic"


def test_an_unknown_engine_is_refused() -> None:
    with pytest.raises(UnknownAligner):
        get_aligner("fast_align")


def test_every_declared_engine_is_constructible_or_declares_its_group() -> None:
    """No engine id exists that nothing can build; `simalign` is allowed to need a group."""
    for engine in ALIGNMENT_ENGINES:
        try:
            assert get_aligner(engine).id == engine
        except MissingDependencyGroup:
            assert engine == "simalign"


# ---------------------------------------------------------------------------
# Provenance
# ---------------------------------------------------------------------------


def test_provenance_says_unmeasured_for_spanish() -> None:
    """No eng-spa F1 is published, so the runlog may not imply one."""
    provenance = alignment_provenance("simalign", "es")
    assert provenance["alignment_quality"] == "unmeasured"
    assert "spa" in provenance["alignment_note"]
    assert "es" not in SIMALIGN_PUBLISHED_F1


def test_provenance_quotes_the_published_figure_for_french_and_german() -> None:
    assert alignment_provenance("simalign", "fr")["alignment_quality"] == "published"
    assert "0.94" in alignment_provenance("simalign", "fr")["alignment_note"]
    assert "0.81" in alignment_provenance("simalign", "de")["alignment_note"]


def test_provenance_for_japanese_is_unmeasured_too() -> None:
    """`deep/10` edge case 16: the ja hint feature is gated behind a gold sample."""
    provenance = alignment_provenance("simalign", "ja")
    assert provenance["alignment_quality"] == "unmeasured"
    assert "jpn" in provenance["alignment_note"]


def test_the_fallbacks_provenance_says_it_must_not_ship() -> None:
    provenance = alignment_provenance("deterministic", "es")
    assert provenance["alignment_engine"] == "deterministic"
    assert provenance["alignment_quality"] == "unmeasured"
    assert "must not ship" in provenance["alignment_note"]
