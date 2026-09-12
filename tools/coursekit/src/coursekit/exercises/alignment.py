"""Word alignment for word banks and dotted-underline hints — and the honesty rules.

`scope2/00` §2.3 makes SimAlign the default aligner for G7 and `deep/10` §S7 pins its
constructor: `SentenceAligner(model="bert", token_type="bpe", matching_methods="mai")`,
training-free, MIT.

Three facts govern everything in this module.

**1. The published F1 does not cover Spanish.** SimAlign reports eng-fra .94,
eng-ces .87, eng-deu .81, eng-ron .65, eng-fas .67, eng-hin .55 — and **no eng-spa or
eng-jpn figure at all**. `deep/10` edge case 16 says the word-bank/hint feature that
depends on it must be gated behind a manual gold sample for Japanese; the same argument
applies to Spanish with a smaller expected gap. So `alignment_quality` on the runlog is
`published` or `unmeasured`, never "good".

**2. The fallback is a declared engine, not a degradation.** CI does not carry torch —
`pyproject.toml` keeps `align` out of `default-groups` because it is gigabytes of
wheels — so a G7 run in CI cannot use SimAlign. The rule in `docs/pipeline.md` is that
a stage may not quietly reach for a worse tool, so `DEFAULT_ALIGNMENT_ENGINE` is
`simalign` and an absent group is `MissingDependencyGroup` (exit 3). The deterministic
aligner is reachable only by asking for it: `coursekit build es --set
align_engine=deterministic`. Whichever ran is written to the runlog, and
`FALLBACK_ENGINE_NOTE` says in as many words that a pack built with the fallback must
not ship.

**3. The fallback is allowed to produce nothing.** Measured, not assumed: on two
sentences of comparable length it emits exactly `min(len(src), len(tgt))` pairs, because
a proportional diagonal always exists and the greedy always finds it. That is the honest
extent of a positional aligner, and it is why the only real refusal it has is the
length-ratio gate — above `FALLBACK_MAX_LENGTH_RATIO` it returns nothing rather than a
screen of confident wrong glosses. A wrong hint is worse than an absent one: V4 cannot
catch it and the learner cannot tell them apart.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

from ..config import ISO3_BY_LANGUAGE
from ..config.g7 import (
    ALIGNMENT_ENGINES,
    DEFAULT_ALIGNMENT_ENGINE,
    FALLBACK_ENGINE_NOTE,
    FALLBACK_LEXICAL_WEIGHT,
    FALLBACK_MAX_LENGTH_RATIO,
    FALLBACK_MIN_SCORE,
    FALLBACK_POSITION_WEIGHT,
    SIMALIGN_MATCHING_METHODS,
    SIMALIGN_METHOD_KEY,
    SIMALIGN_MODEL,
    SIMALIGN_PUBLISHED_F1,
    SIMALIGN_TOKEN_TYPE,
    SIMALIGN_UNMEASURED_NOTE,
)
from ..inputs import require_group

__all__ = [
    "Aligner",
    "Alignment",
    "DeterministicAligner",
    "SimAlignAligner",
    "UnknownAligner",
    "alignment_provenance",
    "get_aligner",
]


class UnknownAligner(ValueError):
    """An engine id nobody declared. Never falls through to a default."""


@dataclass(frozen=True, slots=True)
class Alignment:
    """Index pairs plus the engine that produced them.

    `engine` is not decoration. The frozen `exercise` record carries only the pairs
    (`additionalProperties: false`), so this field is how the stage knows what to write
    on the runlog entry — and the runlog is the only place a later reader can tell a
    SimAlign pack from a fallback pack.
    """

    pairs: tuple[tuple[int, int], ...]
    engine: str
    quality: str


class Aligner(Protocol):
    """What every engine implements. Two methods, no state the caller can corrupt."""

    id: str

    def align(self, source: list[str], target: list[str]) -> tuple[tuple[int, int], ...]:
        """Index pairs `(source_index, target_index)`, sorted, deduplicated."""
        ...


# ---------------------------------------------------------------------------
# SimAlign
# ---------------------------------------------------------------------------


class SimAlignAligner:
    """`deep/10` §S7, verbatim. Imports simalign lazily; `align` group required."""

    id = "simalign"

    def __init__(self) -> None:
        require_group("align", needed_by="G7 expand (SimAlign word alignment)")
        from simalign import SentenceAligner  # noqa: PLC0415 — optional group

        self._aligner = SentenceAligner(
            model=SIMALIGN_MODEL,
            token_type=SIMALIGN_TOKEN_TYPE,
            matching_methods=SIMALIGN_MATCHING_METHODS,
        )

    def align(self, source: list[str], target: list[str]) -> tuple[tuple[int, int], ...]:
        if not source or not target:
            return ()
        result = self._aligner.get_word_aligns(source, target)
        if SIMALIGN_METHOD_KEY not in result:
            raise UnknownAligner(
                f"simalign returned {sorted(result)}, with no {SIMALIGN_METHOD_KEY!r} "
                f"key. matching_methods={SIMALIGN_MATCHING_METHODS!r} is pinned by "
                "deep/10 §S7 and a changed key set means a changed SimAlign."
            )
        return tuple(sorted((int(a), int(b)) for a, b in result[SIMALIGN_METHOD_KEY]))


# ---------------------------------------------------------------------------
# The deterministic fallback
# ---------------------------------------------------------------------------


def _bigrams(token: str) -> set[str]:
    folded = token.casefold()
    if len(folded) < 2:
        return {folded} if folded else set()
    return {folded[index : index + 2] for index in range(len(folded) - 1)}


def _lexical_similarity(left: str, right: str) -> float:
    """Dice over character bigrams. Catches cognates, and nothing else — which is the
    honest extent of what a fallback aligner can claim between two languages."""
    a, b = _bigrams(left), _bigrams(right)
    if not a or not b:
        return 0.0
    return 2 * len(a & b) / (len(a) + len(b))


class DeterministicAligner:
    """A positional-monotone aligner with a cognate tie-break.

    Greedy over a score matrix, highest score first, one target index per source index
    and vice versa, and nothing below `FALLBACK_MIN_SCORE`. Deterministic in the strong
    sense the pack needs: same inputs, same output, no clock, no hash seed, no dict
    order — ties break on `(source_index, target_index)`.

    It has no measured F1 against anything, and `FALLBACK_ENGINE_NOTE` says so on every
    runlog entry it touches.
    """

    id = "deterministic"

    def align(self, source: list[str], target: list[str]) -> tuple[tuple[int, int], ...]:
        if not source or not target:
            return ()
        ratio = max(len(source), len(target)) / min(len(source), len(target))
        if ratio > FALLBACK_MAX_LENGTH_RATIO:
            # Declining the whole pair, not trimming it. At this ratio the proportional
            # diagonal is a fiction and every pair on it is a guess wearing a gloss.
            return ()
        last_source = max(len(source) - 1, 1)
        last_target = max(len(target) - 1, 1)
        scored: list[tuple[float, int, int]] = []
        for source_index, source_token in enumerate(source):
            for target_index, target_token in enumerate(target):
                position = 1.0 - abs(
                    source_index / last_source - target_index / last_target
                )
                lexical = _lexical_similarity(source_token, target_token)
                score = (
                    FALLBACK_POSITION_WEIGHT * position + FALLBACK_LEXICAL_WEIGHT * lexical
                )
                if score >= FALLBACK_MIN_SCORE:
                    scored.append((score, source_index, target_index))

        # Sort by descending score, then ascending indices: a total order, so two runs
        # over the same tokens cannot disagree about which of two equal scores wins.
        scored.sort(key=lambda row: (-row[0], row[1], row[2]))
        used_source: set[int] = set()
        used_target: set[int] = set()
        pairs: list[tuple[int, int]] = []
        for _score, source_index, target_index in scored:
            if source_index in used_source or target_index in used_target:
                continue
            used_source.add(source_index)
            used_target.add(target_index)
            pairs.append((source_index, target_index))
        return tuple(sorted(pairs))


# ---------------------------------------------------------------------------
# Selection
# ---------------------------------------------------------------------------


def get_aligner(engine: str | None = None) -> Aligner:
    """The engine a caller asked for. There is no `auto`.

    `engine=None` means `DEFAULT_ALIGNMENT_ENGINE`, which is SimAlign, which raises
    `MissingDependencyGroup` when `align` is not installed. That refusal is the
    feature: CI reaches the fallback by naming it, and a developer who forgot to
    `uv sync --group align` gets exit 3 with the command rather than a pack full of
    positional guesses.
    """
    chosen = engine or DEFAULT_ALIGNMENT_ENGINE
    if chosen not in ALIGNMENT_ENGINES:
        raise UnknownAligner(
            f"no alignment engine {chosen!r}; config/g7.py declares "
            f"{', '.join(ALIGNMENT_ENGINES)}"
        )
    if chosen == "simalign":
        return SimAlignAligner()
    return DeterministicAligner()


def alignment_provenance(engine: str, lang: str) -> dict[str, str]:
    """What the stage writes on the runlog entry. One dict, four honest fields."""
    if engine not in ALIGNMENT_ENGINES:
        raise UnknownAligner(f"no alignment engine {engine!r}")
    if engine != "simalign":
        return {
            "alignment_engine": engine,
            "alignment_quality": "unmeasured",
            "alignment_note": FALLBACK_ENGINE_NOTE,
            "alignment_model": "n/a",
        }
    published = SIMALIGN_PUBLISHED_F1.get(lang)
    if published is None:
        note = SIMALIGN_UNMEASURED_NOTE.format(iso3=ISO3_BY_LANGUAGE[lang])
        quality = "unmeasured"
    else:
        note = f"SimAlign mBERT-Argmax F1 eng-{ISO3_BY_LANGUAGE[lang]} = {published}"
        quality = "published"
    return {
        "alignment_engine": engine,
        "alignment_quality": quality,
        "alignment_note": note,
        "alignment_model": (
            f"{SIMALIGN_MODEL}/{SIMALIGN_TOKEN_TYPE}/{SIMALIGN_MATCHING_METHODS}"
        ),
    }
