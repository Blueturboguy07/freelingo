"""Word banks and dotted-underline hints (S035, S038 `Tap what you hear`).

Two measured mechanics from `scope/09`, both of which constrain the *pack*, not just
the player:

- **The grid never reflows.** Tapping a bank tile appends its word to the answer strip
  and leaves a blank placeholder in that tile's original grid position, so the tile
  order has to be FIXED for the whole of a session and a repeated answer token needs its
  own tile — removing one word from the strip must not restore a tile that is still in
  use. `build_word_bank` is where that is worked out: `tiles` + `answer_indices`, with
  one ordinal per answer token.
- **The bank always holds more tiles than the answer needs.** `MIN_EXTRA_WORD_BANK_TILES`
  is 2 and the cap is 4, because a four-token sentence with a twelve-tile bank is a
  scanning exercise rather than a language one.

## What of this reaches the pack, and what does not

Be exact about it, because a previous version of this docstring was not. The frozen
`exercise` contract (`coursekit.artifacts.EXERCISE`, `additionalProperties: false`) has
`distractors` and `alignment` and NOTHING ELSE this module produces: no tile array, no
answer-index array, no hint list. So what ships is the EXTRA TILES (`extra_tiles`) plus
the alignment, and the player fixes an order once at session start and stores the
indices in `session_state` — which keeps the grid still, because "still" is a property
of the session and not of the file. `tiles`/`answer_indices` are the build-time proof
that such an order EXISTS with the duplicate-token rule satisfied; they are not a
serialisation format. The request to add the three fields to the contract is filed in
`docs/owned/p2-g7.json`; until it lands, claiming the pack ships a tile order would be
false.

Hints are the dotted underlines: only tokens the scheduler flags new-or-shaky carry
one. At build time "new" is what the pack knows — a lemma introduced in this unit — so
`build_hints` takes that set and attaches a gloss taken from the alignment. A hint is
emitted only when the alignment actually covers the token: a positional guess rendered
as a translation is the failure `deep/10` edge case 16 is about, and the learner has no
way to tell it from a real one. The hint LIST cannot ride the record either, so the
stage ships the `alignment` the hints are derived from and runs `build_hints` at build
time to put the count on the runlog — a pack whose aligner produced no hintable token
then says `word_bank_hints: 0` instead of shipping a feature that renders nothing.
"""

from __future__ import annotations

import random
from collections.abc import Sequence
from dataclasses import dataclass

from ..config.g7 import (
    DISTRACTOR_SEED,
    HINT_ONLY_FOR_NEW_LEMMAS,
    MAX_EXTRA_WORD_BANK_TILES,
    MIN_EXTRA_WORD_BANK_TILES,
)

__all__ = ["Hint", "WordBank", "build_hints", "build_word_bank", "tile_count_is_sane"]


@dataclass(frozen=True, slots=True)
class Hint:
    """One dotted-underline token and its gloss."""

    #: Index into the *source* (prompt-side) tokens.
    source_index: int
    surface: str
    gloss: str


@dataclass(frozen=True, slots=True)
class WordBank:
    """An ordered tile list plus the indices that spell the answer.

    `answer_indices` is the contract with the player: tap order IS the answer (S035),
    so the pack states which tiles, in which order, make the accepted string.
    """

    tiles: tuple[str, ...]
    answer_indices: tuple[int, ...]

    @property
    def answer(self) -> tuple[str, ...]:
        return tuple(self.tiles[index] for index in self.answer_indices)

    @property
    def extra_tiles(self) -> tuple[str, ...]:
        used = set(self.answer_indices)
        return tuple(tile for index, tile in enumerate(self.tiles) if index not in used)


def tile_count_is_sane(extra: int) -> bool:
    """Is this decoy count inside the measured band?

    `deep/01` §S4: the bank always holds more tiles than the answer needs, so the floor
    is 2; the cap is 4 because a four-token sentence with a twelve-tile bank is a
    scanning exercise rather than a language one. The SHAPE TABLE carries the actual
    number per shape, and `tests/test_g7_expand.py` holds every word-bank shape to this
    predicate — so the two constants govern the table rather than sitting next to a
    function nobody calls.
    """
    return MIN_EXTRA_WORD_BANK_TILES <= extra <= MAX_EXTRA_WORD_BANK_TILES


def build_word_bank(
    answer_tokens: Sequence[str],
    decoys: Sequence[str],
    *,
    key: str,
    seed: int = DISTRACTOR_SEED,
) -> WordBank:
    """Interleave the answer tokens and decoys into one fixed, shuffled tile list.

    Deterministic: the shuffle is seeded on `key`, so a rebuild of the same pack
    produces the same grid and the player's saved `session_state` (which stores tile
    indices) survives a pack update that did not touch this item.

    A repeated token in the answer gets its OWN tile — `answer_indices` may not point
    at the same tile twice, or removing one word from the strip would restore a tile
    that is still in use.
    """
    if not answer_tokens:
        raise ValueError(f"{key}: a word bank needs at least one answer token")
    if not decoys:
        raise ValueError(
            f"{key}: a bank with exactly the answer's tiles is a re-ordering puzzle "
            "with no lexical decision in it (deep/01 §S4: always more tiles than needed)"
        )

    rng = random.Random(f"{seed}:wordbank:{key}")

    # (token, is_answer, ordinal) so the positions of duplicate answer tokens stay
    # distinguishable after the shuffle.
    entries: list[tuple[str, int]] = [
        (token, ordinal) for ordinal, token in enumerate(answer_tokens)
    ]
    entries += [(decoy, -1) for decoy in decoys]
    rng.shuffle(entries)

    tiles = tuple(token for token, _ordinal in entries)
    position_of_ordinal = {
        ordinal: index for index, (_token, ordinal) in enumerate(entries) if ordinal >= 0
    }
    answer_indices = tuple(position_of_ordinal[ordinal] for ordinal in range(len(answer_tokens)))
    return WordBank(tiles=tiles, answer_indices=answer_indices)


def build_hints(
    source_tokens: Sequence[str],
    target_tokens: Sequence[str],
    alignment: Sequence[tuple[int, int]],
    *,
    new_lemmas: Sequence[str],
    lemma_of_source_index: Sequence[str],
) -> tuple[Hint, ...]:
    """Dotted-underline hints for the source tokens the alignment actually covers.

    Two refusals, both deliberate:

    - a source token with no alignment pair gets **no hint**, rather than a gloss
      guessed from position;
    - with `HINT_ONLY_FOR_NEW_LEMMAS` set, a token whose lemma the learner already
      knows gets no hint either (`scope/09`: only new-or-shaky tokens are underlined).

    Multi-token glosses are supported — the measured example is `con leche` — by
    joining every target token aligned to the same source index in target order.
    """
    if len(lemma_of_source_index) != len(source_tokens):
        raise ValueError(
            "lemma_of_source_index must have one entry per source token; got "
            f"{len(lemma_of_source_index)} for {len(source_tokens)} tokens"
        )
    new = {lemma for lemma in new_lemmas}
    by_source: dict[int, list[int]] = {}
    for source_index, target_index in alignment:
        if not 0 <= source_index < len(source_tokens):
            raise ValueError(f"alignment source index {source_index} is out of range")
        if not 0 <= target_index < len(target_tokens):
            raise ValueError(f"alignment target index {target_index} is out of range")
        by_source.setdefault(source_index, []).append(target_index)

    hints: list[Hint] = []
    for source_index in sorted(by_source):
        lemma = lemma_of_source_index[source_index]
        if HINT_ONLY_FOR_NEW_LEMMAS and lemma not in new:
            continue
        gloss = " ".join(target_tokens[index] for index in sorted(by_source[source_index]))
        hints.append(
            Hint(source_index=source_index, surface=source_tokens[source_index], gloss=gloss)
        )
    return tuple(hints)
