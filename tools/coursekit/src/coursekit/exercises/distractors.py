"""The distractor rule core, and the re-rank hook that is deliberately unreachable.

`scope2/00` §2.3, row G7: distractors come from a **rule core** — same POS, same
frequency band, morphological wrong-form — with an **LLM as re-ranker only**. §2.4 row
V5 says why the core has to be a rule and not a model: measured distractor quality for
an LLM-only pipeline is NDCG@10 ~34/100, so a model choosing freely produces
distractors that are wrong in ways nobody can audit.

**There is no re-ranker here.** No hosted model is reachable from this environment, so
`rerank()` raises and has no call site. A heuristic wearing the re-ranker's name would
put a claim in the pack manifest that is not true, and the manifest is the thing the
learner is asked to trust. `tests/test_distractors.py` walks this module with `ast` and
fails if a call site appears while `RERANK_ENABLED` is false.

## What V5 actually asks for

> Distractor != any accepted answer; same POS; not a valid alternative translation.

The first two are local. The third is not: "a valid alternative translation" cannot be
decided from one row, because the alternative may be authored on a *different* exercise
over the same sentence. So the core takes an `AlternativesIndex` built over the whole
unit and refuses to emit anything inside it. Where a back-translation engine exists
(G6's lane), it widens that index; where it does not, the index is still non-empty,
because the authored accepted-answer sets of sibling exercises are themselves the
alternatives that matter most.

## Determinism

A pack must rebuild byte-identically or the content-addressed audio and the FSRS item
ids move under the learner. Every choice here is ordered by an explicit key and shuffled
with a seeded `random.Random`; nothing reads `set` iteration order, the clock, or
`PYTHONHASHSEED`.
"""

from __future__ import annotations

import random
import unicodedata
from collections import defaultdict
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any, Protocol

from ..config.g7 import (
    DISTRACTOR_BAND_WIDENING,
    DISTRACTOR_SEED,
    DISTRACTOR_STRATEGIES,
    RERANK_ENABLED,
    RERANK_UNAVAILABLE_REASON,
)

__all__ = [
    "AlternativesIndex",
    "Candidate",
    "DistractorPool",
    "NotEnoughDistractors",
    "RerankerUnavailable",
    "normalise",
    "rerank",
    "rule_core_distractors",
]


class NotEnoughDistractors(RuntimeError):
    """The rule core could not fill the slot inside its constraints.

    Raised rather than padded. Padding with a different POS is precisely the V5
    violation the core exists to prevent, and a shape with one fewer option renders as
    a different exercise. The fix is content — a wider ledger, a different item — not a
    looser rule.
    """


class RerankerUnavailable(RuntimeError):
    """The LLM re-ranker was called. It is declared and not implemented."""


def normalise(text: str) -> str:
    """Case-folded, NFC, trimmed. The comparison key for "is this the same string".

    NFC rather than NFD because the ledger stores composed forms; folding without
    normalising makes `casa` and `casa` with a combining accent compare unequal on one
    machine and equal on another.
    """
    return unicodedata.normalize("NFC", text).casefold().strip()


# ---------------------------------------------------------------------------
# The alternatives index — V5's third clause
# ---------------------------------------------------------------------------


@dataclass(slots=True)
class AlternativesIndex:
    """Every string that is a *correct* answer somewhere, keyed by what it answers.

    Built over a whole unit before any distractor is drawn, because a distractor for
    exercise A must not be an accepted answer of exercise B over the same sentence or
    the same lexeme. A learner who taps it is right and is told they are wrong, which
    is the one grading failure a pack cannot apologise its way out of.
    """

    #: `key -> {normalised accepted strings}`. A key is a sentence id or a lemma.
    by_key: dict[str, set[str]] = field(default_factory=lambda: defaultdict(set))
    #: Every accepted string anywhere, for the cross-item check.
    everywhere: set[str] = field(default_factory=set)

    def add(self, key: str, accepted: Iterable[str]) -> None:
        bucket = self.by_key.setdefault(key, set())
        for answer in accepted:
            folded = normalise(answer)
            bucket.add(folded)
            self.everywhere.add(folded)

    def forbidden_for(self, key: str) -> set[str]:
        """What may not be a distractor for this key."""
        return set(self.by_key.get(key, set()))

    def is_alternative(self, key: str, text: str) -> bool:
        return normalise(text) in self.by_key.get(key, set())


# ---------------------------------------------------------------------------
# The pool
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class Candidate:
    """One distractor the core is considering, with the reason it was reachable."""

    surface: str
    lemma: str
    pos: str
    band: str
    strategy: str


@dataclass(slots=True)
class DistractorPool:
    """The two rule-core sources, built once per language.

    `by_pos_band` is `(POS, band) -> [lemma]`, from G2's `banded_lemma` rows.
    `forms` is `lemma -> {morph key -> surface}`, from G1's `analysed_sentence` tokens,
    and is what makes "morphological wrong-form" a real strategy without a Spanish
    inflection engine: a wrong form of a lemma the learner has met is a form that is
    *attested in the ledger*, which is a stronger guarantee than one a generator would
    invent.
    """

    by_pos_band: dict[tuple[str, str], list[str]] = field(default_factory=dict)
    forms: dict[str, dict[str, str]] = field(default_factory=dict)
    pos_of_lemma: dict[str, str] = field(default_factory=dict)
    band_of_lemma: dict[str, str] = field(default_factory=dict)

    @classmethod
    def build(
        cls,
        banded: Iterable[Mapping[str, Any]],
        analysed: Iterable[Mapping[str, Any]],
    ) -> DistractorPool:
        pool = cls()
        for row in banded:
            lemma, pos, band = row["lemma"], row["pos"], row["band"]
            pool.by_pos_band.setdefault((pos, band), []).append(lemma)
            # A lemma can carry more than one POS row (`frío` is ADJ and NOUN in the
            # es-mini ledger). These two maps are FIRST-SEEN, deterministic because the
            # ledger is rank-ordered, and are only ever a default for a caller that has
            # no POS of its own: the rule core itself never reads them to decide POS
            # agreement — `(pos, band)` bucket membership is what decides that.
            pool.pos_of_lemma.setdefault(lemma, pos)
            pool.band_of_lemma.setdefault(lemma, band)
        for key in pool.by_pos_band:
            # Sorted so the pool does not inherit the ledger's file order, which is
            # itself a frequency ranking: unsorted, every distractor would be the most
            # frequent word in the band.
            pool.by_pos_band[key] = sorted(set(pool.by_pos_band[key]))
        for sentence in analysed:
            for token in sentence["tokens"]:
                bucket = pool.forms.setdefault(token["lemma"], {})
                bucket.setdefault(token.get("morph", ""), token["surface"])
        return pool

    def wrong_forms(self, lemma: str, correct_surface: str, pos: str, band: str) -> list[Candidate]:
        """Attested surfaces of the same lemma that are not the correct one.

        Same POS by construction — they are inflections of one lemma — so the candidate
        carries the CALLER's POS rather than a lookup. A lemma with two ledger rows
        (`frío` is ADJ and NOUN) would otherwise have its inflections rejected by the
        core's own POS filter depending on which row was read first.
        """
        correct = normalise(correct_surface)
        return [
            Candidate(surface=surface, lemma=lemma, pos=pos, band=band, strategy="wrong_form")
            for _morph, surface in sorted(self.forms.get(lemma, {}).items())
            if normalise(surface) != correct
        ]

    def same_pos_same_band(self, pos: str, band: str, exclude_lemma: str) -> list[Candidate]:
        out: list[Candidate] = []
        for offset in (0, *DISTRACTOR_BAND_WIDENING):
            target_band = _band_at(band, offset)
            if target_band is None:
                continue
            for lemma in self.by_pos_band.get((pos, target_band), []):
                if lemma == exclude_lemma:
                    continue
                out.append(
                    Candidate(
                        surface=lemma,
                        lemma=lemma,
                        pos=pos,
                        band=target_band,
                        strategy="same_pos_same_band",
                    )
                )
        return out


def _band_at(band: str, offset: int) -> str | None:
    from ..config.g7 import BAND_ORDER  # noqa: PLC0415 — keeps the constant in config

    if band not in BAND_ORDER:
        return None
    index = BAND_ORDER.index(band) + offset
    if not 0 <= index < len(BAND_ORDER):
        return None
    return BAND_ORDER[index]


# ---------------------------------------------------------------------------
# The core
# ---------------------------------------------------------------------------


def rule_core_distractors(
    *,
    pool: DistractorPool,
    alternatives: AlternativesIndex,
    key: str,
    answer_surface: str,
    answer_lemma: str,
    pos: str,
    band: str,
    accepted_answers: Sequence[str],
    count: int,
    seed: int = DISTRACTOR_SEED,
) -> tuple[str, ...]:
    """`count` distractors obeying all three V5 clauses, or `NotEnoughDistractors`.

    Strategy order is `DISTRACTOR_STRATEGIES`: wrong forms of the right lemma first,
    because a wrong inflection is the distractor that teaches the grammar point, then
    same-POS same-band lexemes. There is no third fallback, and the band does not widen
    (`DISTRACTOR_BAND_WIDENING` is empty) — a distractor from a band the learner has
    never met is eliminable without knowing anything.
    """
    if count == 0:
        return ()

    forbidden = {normalise(answer) for answer in accepted_answers}
    forbidden.add(normalise(answer_surface))
    forbidden |= alternatives.forbidden_for(key)

    chosen: list[str] = []
    seen: set[str] = set()
    rng = random.Random(f"{seed}:{key}:{answer_surface}")

    for strategy in DISTRACTOR_STRATEGIES:
        if len(chosen) >= count:
            break
        if strategy == "wrong_form":
            candidates = pool.wrong_forms(answer_lemma, answer_surface, pos, band)
        else:
            candidates = pool.same_pos_same_band(pos, band, exclude_lemma=answer_lemma)

        eligible = [
            candidate
            for candidate in candidates
            if normalise(candidate.surface) not in forbidden
            and normalise(candidate.surface) not in seen
            and candidate.pos == pos
        ]
        # Shuffle inside a strategy, never across one: the order of the strategies is
        # pedagogy and must not be randomised away.
        eligible.sort(key=lambda candidate: candidate.surface)
        rng.shuffle(eligible)
        for candidate in eligible:
            if len(chosen) >= count:
                break
            chosen.append(candidate.surface)
            seen.add(normalise(candidate.surface))

    if len(chosen) < count:
        raise NotEnoughDistractors(
            f"{key}: needed {count} distractors for {answer_surface!r} "
            f"(POS {pos}, band {band}) and the rule core found {len(chosen)}. "
            "Padding from another POS or band is a V5 violation, so this is a content "
            "failure: widen the ledger for this band or drop the item."
        )
    return tuple(chosen[:count])


# ---------------------------------------------------------------------------
# The re-rank hook
# ---------------------------------------------------------------------------


class Reranker(Protocol):
    """What an LLM re-ranker would implement, if one were reachable."""

    def rank(self, answer: str, candidates: Sequence[str]) -> Sequence[str]:
        """Return `candidates` best-first. Never adds, never removes."""
        ...


def rerank(answer: str, candidates: Sequence[str], *, ranker: Reranker | None = None) -> None:
    """Declared, unimplemented, and with no call site. Always raises.

    The signature exists so a future lane knows what the contract is — a *permutation*
    of the rule core's output, never a new candidate, so V5 stays true by construction
    whatever the model says. Until a model is reachable it raises, and
    `tests/test_distractors.py` proves nothing calls it.
    """
    raise RerankerUnavailable(
        f"rerank({answer!r}, {len(candidates)} candidates, ranker={ranker!r}): "
        f"{RERANK_UNAVAILABLE_REASON} RERANK_ENABLED={RERANK_ENABLED}."
    )
