"""The lemma ledger: what a token is, counted one way, in one place. **INV-PACK-40.**

Every other module in this package that needs to know "how many items is this sentence",
"is this a new item", "is this sentence the right length", or "what tokens does the
speaking grader compare against" calls into here. None of them may answer it themselves.

That sounds like ordinary tidiness and it is not. The invariant's failure mode is a
*second* definition, not a wrong one:

- A consumer that whitespace-splits agrees with the ledger on Spanish function words and
  disagrees on every enclitic, every contraction and every compound. V1 ("no lemma
  appears before its introduction unit") then runs over one partition of the vocabulary
  while the length filter and the new-item budget run over another, and the numbers all
  look plausible.
- The same consumer applied to Japanese counts a whole sentence as one token, because
  Japanese has no whitespace. The i+1 mechanism no-ops and every validator downstream
  still passes green.
- A single shared new-item budget, tuned on Spanish lemmas, spends itself on Japanese
  bound morphemes: the invariant's own falsifier is "a `ja` lesson that teaches three
  content words inside its budget".

So the declaration lives once, in `config/g1.py`, this module is its only reader, and
`tests/test_ledger_unit.py` greps the whole `tools/coursekit` tree for a consumer that
brought its own tokeniser. Three things are needed and only together: the declaration,
the single reader, and the gate. The declaration alone is a comment; the reader alone is
a convenience somebody routes around; the gate alone has nothing to point at.

**INV-PACK-51** lives here too, because it is the same subject from the other side. The
ledger's identity key is `(normalized_form, reading_form, POS)`, and two *distinct* items
sharing one is a collapse: `capital` (money) and `capital` (city) become one Words row,
one FSRS item, and one set of reviews scheduled against the wrong half. For Spanish the
reading form is the orthographic form — Spanish spelling determines pronunciation, so
there is nothing else to store — and for Japanese it is SudachiPy's `reading_form()`,
which is the only thing separating 辛い (karai) from 辛い (tsurai).
"""

from __future__ import annotations

import unicodedata
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from typing import Any

from .config import LANGUAGES
from .config.g1 import (
    CONTENT_POS,
    LEDGER_UNIT_BY_LANGUAGE,
    LEDGER_UNIT_PROSE,
    LEDGER_UNITS,
    LENGTH_WINDOW_BY_LANGUAGE,
    NEW_ITEMS_PER_LESSON_BY_LANGUAGE,
    NON_LEXICAL_POS,
    RECYCLING_WINDOW_BY_LANGUAGE,
)

__all__ = [
    "DuplicateLedgerKey",
    "DuplicateTileLabel",
    "LedgerItem",
    "LedgerError",
    "RecyclingWindow",
    "assert_distinct_tile_labels",
    "assert_unique_keys",
    "content_units",
    "count_units",
    "is_content_pos",
    "is_lexical_pos",
    "item_from_token",
    "ledger_declaration",
    "ledger_key",
    "ledger_unit",
    "length_ok",
    "length_window",
    "mean_content_words_per_sentence",
    "new_item_budget",
    "normalized_form",
    "reading_form",
    "recycling_window",
    "speaking_tokens",
    "units",
]


class LedgerError(ValueError):
    """Something asked the ledger a question about a language it does not declare."""


class DuplicateLedgerKey(LedgerError):
    """INV-PACK-51: two distinct ledger items share `(normalized_form, reading_form, POS)`.

    Raised, never merged. Merging is the bug: the two are different words to a learner,
    different rows in the Words list, and different items to FSRS, so folding them
    together teaches one and schedules the other's reviews against it.
    """


class DuplicateTileLabel(LedgerError):
    """INV-PACK-51, second half: two tiles in one item render the same label.

    A word bank whose two tiles read alike is unanswerable — a learner who taps the right
    one is indistinguishable from one who did not — so it is refused at build time rather
    than graded at run time.
    """


# ---------------------------------------------------------------------------
# The declaration (INV-PACK-40)
# ---------------------------------------------------------------------------


def ledger_unit(lang: str) -> str:
    """What one ledger item IS for this pack. The single read of the declaration.

    `lemma` everywhere but Japanese, which counts SudachiPy Mode-A morphemes so a
    compound cannot smuggle unseen morphemes past V1.
    """
    _require_language(lang)
    unit = LEDGER_UNIT_BY_LANGUAGE[lang]
    if unit not in LEDGER_UNITS:
        raise LedgerError(
            f"{lang!r} declares ledger_unit {unit!r}, which is not one of "
            f"{', '.join(LEDGER_UNITS)}. A third policy nobody designed is not a typo "
            f"the pipeline may absorb (INV-PACK-40)."
        )
    return unit


def length_window(lang: str) -> tuple[int, int]:
    """`(min, max)` ledger units a sentence may carry. G0's length filter reads THIS.

    Per pack, never shared: the same sentence measures longer in Mode-A morphemes than in
    lemmas, so reusing the Spanish window for Japanese filters out ordinary A1 Japanese.
    """
    _require_language(lang)
    return LENGTH_WINDOW_BY_LANGUAGE[lang]


def new_item_budget(lang: str) -> int:
    """The most new ledger items one lesson may introduce. V2's K, per pack."""
    _require_language(lang)
    return NEW_ITEMS_PER_LESSON_BY_LANGUAGE[lang]


@dataclass(frozen=True, slots=True)
class RecyclingWindow:
    """V3's window: `min_occurrences` re-appearances within `lessons` lessons."""

    lessons: int
    min_occurrences: int


def recycling_window(lang: str) -> RecyclingWindow:
    """The pack's own recycling window. V3 reads THIS, per pack."""
    _require_language(lang)
    lessons, minimum = RECYCLING_WINDOW_BY_LANGUAGE[lang]
    return RecyclingWindow(lessons=lessons, min_occurrences=minimum)


def ledger_declaration(lang: str, *, mean_content_words_per_sentence: float | None = None) -> dict:
    """The block G9 copies into the pack manifest. **Declared exactly once, here.**

    A pack that carries this block carries every number a consumer needs; a pack that
    does not is the invariant's first falsifier. `mean_content_words_per_sentence` is
    the figure INV-PACK-40 asks the validator to report, and it is None until G1 has
    measured it over a real corpus — never a default, because a plausible default is
    indistinguishable from a measurement.
    """
    unit = ledger_unit(lang)
    minimum, maximum = length_window(lang)
    window = recycling_window(lang)
    return {
        "ledger_unit": unit,
        "ledger_unit_prose": LEDGER_UNIT_PROSE[unit],
        "length_window_units": [minimum, maximum],
        "new_items_per_lesson": new_item_budget(lang),
        "recycling_window_lessons": window.lessons,
        "recycling_min_occurrences": window.min_occurrences,
        "content_pos": list(CONTENT_POS),
        "mean_content_words_per_sentence": mean_content_words_per_sentence,
    }


def _require_language(lang: str) -> None:
    if lang not in LANGUAGES:
        raise LedgerError(f"unknown language {lang!r}; expected one of {', '.join(LANGUAGES)}")
    if lang not in LEDGER_UNIT_BY_LANGUAGE:
        raise LedgerError(
            f"{lang!r} declares no ledger_unit. A pack with no declaration leaves every "
            f"token-counting consumer to guess, and each one guesses differently "
            f"(INV-PACK-40)."
        )


# ---------------------------------------------------------------------------
# Counting — the ONE token counter
# ---------------------------------------------------------------------------


def is_lexical_pos(pos: str) -> bool:
    """Is a token with this UD tag a ledger item at all?

    Punctuation, whitespace, symbols and `X` ride in `tokens[]` with their character
    offsets, because the grader and the word bank need the spans. They are never counted.
    """
    return pos not in NON_LEXICAL_POS


def is_content_pos(pos: str) -> bool:
    """Is a token with this UD tag a CONTENT word, for the per-pack mean?"""
    return pos in CONTENT_POS


def _declared_tokens(analysed: Mapping[str, Any]) -> tuple[list[Mapping[str, Any]], str]:
    """The row's tokens, once the row's segmentation has been checked against the pack's.

    The guard lives here rather than inside `units()` so that every function which reads
    `analysed['tokens']` passes through it. That is not tidiness either: the mean this
    module reports is the one INV-PACK-40 asks the validator to put in the manifest, and a
    `ja` row carrying Mode-C tokens was being refused by `count_units` and silently
    averaged by `mean_content_words_per_sentence` — the single figure that leaves the
    build was the single figure the check did not cover.

    There is no second tokenisation here and there must not be: the adapter already
    segmented the sentence, and the declaration says which of its segmentations counts. A
    Japanese pack declaring Mode-A morphemes and handed Mode-C tokens would count
    compounds as single items, which is the V1 hole Mode A exists to close, and it is
    invisible in the row.
    """
    unit = ledger_unit(analysed["lang"])
    split_mode = analysed["adapter"].get("split_mode")
    if unit == "morpheme_mode_a" and split_mode != "A":
        raise LedgerError(
            f"{analysed['lang']!r} declares ledger_unit {unit!r} but the row was produced "
            f"with split_mode {split_mode!r}. Mode A is what stops a compound smuggling "
            f"unseen morphemes past V1; Mode C is the display string and the audio unit "
            f"and is never counted (INV-PACK-40)."
        )
    if unit == "lemma" and split_mode is not None:
        raise LedgerError(
            f"{analysed['lang']!r} declares ledger_unit {unit!r}, which has no split "
            f"modes, but the row carries split_mode {split_mode!r}. A row whose adapter "
            f"disagrees with the declaration is counted by neither (INV-PACK-40)."
        )
    return list(analysed["tokens"]), unit


def units(analysed: Mapping[str, Any]) -> tuple[str, ...]:
    """The ledger units of one `analysed_sentence` record, in order.

    This is the function INV-PACK-40 is about. Nothing else in the tree may answer this
    question another way.
    """
    tokens, _unit = _declared_tokens(analysed)
    return tuple(token["lemma"] for token in tokens if is_lexical_pos(token["pos"]))


def count_units(analysed: Mapping[str, Any]) -> int:
    """How many ledger units this sentence carries. The length filter's input."""
    return len(units(analysed))


def content_units(analysed: Mapping[str, Any]) -> tuple[str, ...]:
    """The content-word ledger units, in order. The per-pack mean is computed over these.

    Through the same guard as `units()`: the mean is a manifest figure, and a row the
    counter refuses must not be a row the mean accepts.
    """
    tokens, _unit = _declared_tokens(analysed)
    return tuple(token["lemma"] for token in tokens if is_content_pos(token["pos"]))


def length_ok(analysed: Mapping[str, Any]) -> bool:
    """G0's A1 length filter, expressed in the pack's own unit and window."""
    minimum, maximum = length_window(analysed["lang"])
    return minimum <= count_units(analysed) <= maximum


def mean_content_words_per_sentence(records: Iterable[Mapping[str, Any]]) -> float:
    """The figure INV-PACK-40 asks the validator to report, per pack.

    Content words rather than tokens: a Spanish sentence is mostly determiners,
    prepositions and clitics, so a mean over every token reports much the same number for
    a lesson that teaches three things and one that teaches seven. Zero sentences is 0.0
    and not an error — a caller reporting an empty corpus is reporting something true.
    """
    total = 0
    sentences = 0
    for record in records:
        total += len(content_units(record))
        sentences += 1
    if sentences == 0:
        return 0.0
    return total / sentences


def speaking_tokens(analysed: Mapping[str, Any]) -> tuple[str, ...]:
    """The pre-tokenised expected transcript a speaking item ships (INV-MOD-13).

    INV-MOD-13 requires the tokens to be STORED "in the unit `ledger_unit` declares
    (INV-PACK-40)" and forbids the app bundle from linking a tokenizer at all — so the
    speaking grader computes token F1 against exactly these, and never re-derives them on
    the device. Which makes this a consumer of the declaration like any other, and the
    reason it is here rather than in the exercise builder.
    """
    return units(analysed)


# ---------------------------------------------------------------------------
# Identity — INV-PACK-51
# ---------------------------------------------------------------------------


def normalized_form(lang: str, form: str) -> str:
    """The first element of the ledger key: NFC, case-folded.

    Case-folded rather than lowercased because `str.lower()` is not the same relation in
    every script, and the key has to mean the same thing when the Japanese and German
    packs arrive. NFC because the same Spanish word typed with a combining acute and with
    a precomposed one must be one item, not two.
    """
    _require_language(lang)
    return unicodedata.normalize("NFC", form).casefold()


def reading_form(lang: str, form: str, *, reading: str | None = None) -> str:
    """The second element of the ledger key: how the item is READ.

    **Case-folded and NFC-normalised, on both branches**, so it is the same relation as
    `normalized_form`. The alternative was measured and rejected: normalising only the
    first element made `ledger_key("es", "Casa", "NOUN")` and `ledger_key("es", "casa",
    "NOUN")` two different keys, which is two rows in the learner's Words list for one
    word — and the "one item" guarantee then rested on the spaCy adapter remembering to
    lower-case every lemma rather than on the ledger, which is exactly the second
    definition INV-PACK-40 exists to forbid. Case-folding katakana is a no-op, so the
    Japanese branch is unaffected.

    For Spanish (and French and German) this is the orthographic form: the spelling
    determines the pronunciation, so there is no separate reading to store and the key
    degenerates to `(normalized_form, orthographic_form, POS)`. Passing a `reading` for
    one of those languages is refused rather than ignored — a build that thinks it is
    storing readings for Spanish has a bug somewhere upstream, and silently dropping the
    value would hide it.

    For Japanese it is SudachiPy's `reading_form()` (katakana per Mode-A morpheme), which
    is the only thing that tells 辛い/カライ from 辛い/ツライ apart. A Japanese item with no
    reading is refused for the same reason: falling back to the orthographic form makes
    the pair collide, which is INV-PACK-51's falsifier exactly.
    """
    unit = ledger_unit(lang)
    if unit == "morpheme_mode_a":
        if not reading:
            raise LedgerError(
                f"{lang!r} counts Mode-A morphemes, so every ledger item needs a "
                f"reading_form from the adapter; {form!r} has none. Falling back to the "
                f"orthographic form collapses homographs into one Words row "
                f"(INV-PACK-51)."
            )
        return unicodedata.normalize("NFC", reading).casefold()
    if reading is not None:
        raise LedgerError(
            f"{lang!r} stores no separate reading: its spelling determines its "
            f"pronunciation, so reading_form IS the orthographic form. Got "
            f"reading={reading!r} for {form!r}."
        )
    return normalized_form(lang, form)


@dataclass(frozen=True, slots=True)
class LedgerItem:
    """One item in the ledger, and the sense that makes it distinct from its homographs.

    `sense` is what separates "the same item seen twice" — which is every real run, since
    G2 folds many surface forms onto one lemma — from "two items that collided". It is
    None while a stage has no sense inventory, and two Nones are the same item.
    """

    lang: str
    lemma: str
    pos: str
    sense: str | None = None
    reading: str | None = None

    @property
    def key(self) -> tuple[str, str, str]:
        """`(normalized_form, reading_form, POS)` — the INV-PACK-51 key."""
        return ledger_key(self.lang, self.lemma, self.pos, reading=self.reading)

    @property
    def identity(self) -> tuple[str, str, str, str | None]:
        """What makes two items the SAME item. Two of these colliding is a merge."""
        return (self.lang, self.lemma, self.pos, self.sense)


def ledger_key(
    lang: str, lemma: str, pos: str, *, reading: str | None = None
) -> tuple[str, str, str]:
    """The `(normalized_form, reading_form, POS)` key, for a caller with no `LedgerItem`."""
    return (
        normalized_form(lang, lemma),
        reading_form(lang, lemma, reading=reading),
        pos,
    )


def item_from_token(lang: str, token: Mapping[str, Any], *, sense: str | None = None) -> LedgerItem:
    """A ledger item from one adapter token. The only bridge between G1's output and here."""
    return LedgerItem(
        lang=lang,
        lemma=token["lemma"],
        pos=token["pos"],
        sense=sense,
        reading=token.get("reading"),
    )


def assert_unique_keys(items: Iterable[LedgerItem]) -> None:
    """**INV-PACK-51.** Raise unless every DISTINCT item has a distinct key.

    The same item arriving twice is a merge and passes; two items whose `identity`
    differs and whose `key` does not is a collapse and raises, naming both so the fix
    (disambiguate the pair, or give the Japanese one its reading) is obvious from the
    message.
    """
    seen: dict[tuple[str, str, str], LedgerItem] = {}
    for item in items:
        key = item.key
        first = seen.get(key)
        if first is None:
            seen[key] = item
            continue
        if first.identity == item.identity:
            continue
        raise DuplicateLedgerKey(
            f"two distinct ledger items share the key {key}: {first.identity} and "
            f"{item.identity}. They are two rows in the learner's Words list and two "
            f"FSRS items; merging them teaches one and schedules the other's reviews "
            f"against it (INV-PACK-51). Disambiguate the pair — for a Japanese pair that "
            f"means carrying the Sudachi reading_form, for a Latin-script pair it means "
            f"the two senses cannot share a ledger row."
        )


def assert_distinct_tile_labels(labels: Sequence[str], *, where: str) -> None:
    """**INV-PACK-51, second half.** No two tiles in one item render the same label."""
    seen: set[str] = set()
    for label in labels:
        rendered = unicodedata.normalize("NFC", label)
        if rendered in seen:
            raise DuplicateTileLabel(
                f"{where}: two tiles render {label!r}. A learner who taps the right one "
                f"cannot be told apart from one who did not, so the item is "
                f"unanswerable (INV-PACK-51). Add disambiguating ruby, or drop one tile."
            )
        seen.add(rendered)
