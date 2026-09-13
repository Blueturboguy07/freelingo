"""Resolve Japanese lemma readings by exact dictionary linkage.

Sudachi's reading_form is a surface reading: 食べ has タベ, not タベル. Its
normalized_form may already be the lemma 食べる. Combining those two directly would
split conjugations into different ledger keys. The source's dictionary-form pointer
preserves the chosen lexical entry through inflection, including homographs.

The pinned0.6.11 API exposes this pointer through deprecated get_word_info(). This
narrow use is deliberate, tested against the exact core20260723 dictionary, and must
be revalidated when either pin moves. No isolated lemma reanalysis, first-result
selection, morphological suffix guessing or OOV fallback is permitted.
"""

from __future__ import annotations

import warnings
from dataclasses import dataclass
from typing import Any

from ..config.p7 import SUDACHI_SYSTEM_DICTIONARY_ID
from ..ledger import normalized_form


class LemmaIdentityError(ValueError):
    """An exact linked lemma reading could not be proved for the named source."""


@dataclass(frozen=True)
class LemmaIdentity:
    lemma: str
    normalized_form: str
    dictionary_form: str
    reading: str
    surface_reading: str
    dictionary_id: int
    source_word_id: int
    base_word_id: int


def resolve_lemma_identity(morpheme: Any, dictionary: Any) -> LemmaIdentity:
    surface = morpheme.surface()
    prefix = f"Unresolved Japanese lemma identity for {surface!r}: "
    dictionary_id = morpheme.dictionary_id()
    source_word_id = morpheme.word_id()
    if (
        morpheme.is_oov()
        or type(dictionary_id) is not int
        or dictionary_id != SUDACHI_SYSTEM_DICTIONARY_ID
        or type(source_word_id) is not int
        or source_word_id < 0
    ):
        raise LemmaIdentityError(prefix + "OOV or unpinned dictionary entry.")
    raw_normalized = morpheme.normalized_form()
    dictionary_form = morpheme.dictionary_form()
    surface_reading = morpheme.reading_form()
    if any(
        not isinstance(value, str) or not value.strip()
        for value in (raw_normalized, dictionary_form, surface_reading)
    ):
        raise LemmaIdentityError(prefix + "missing source normalization or reading.")
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", DeprecationWarning)
        target = morpheme.get_word_info().dictionary_form_word_id
    if type(target) is not int or target < -1:
        raise LemmaIdentityError(prefix + "invalid dictionary-form word pointer.")
    base_word_id = source_word_id if target == -1 else target
    matches = [
        entry
        for entry in dictionary.lookup(dictionary_form)
        if entry.dictionary_id() == dictionary_id and entry.word_id() == base_word_id
    ]
    if len(matches) != 1:
        raise LemmaIdentityError(
            prefix + f"expected one exact dictionary/word link, found {len(matches)}."
        )
    base = matches[0]
    reading = base.reading_form()
    base_normalized = base.normalized_form()
    if (
        base.is_oov()
        or not isinstance(reading, str)
        or not reading.strip()
        or not isinstance(base_normalized, str)
        or not base_normalized.strip()
        or normalized_form("ja", base_normalized) != normalized_form("ja", raw_normalized)
        or tuple(base.part_of_speech()[:5]) != tuple(morpheme.part_of_speech()[:5])
    ):
        raise LemmaIdentityError(prefix + "linked base contradicts normalization, POS or reading.")
    return LemmaIdentity(
        lemma=normalized_form("ja", raw_normalized),
        normalized_form=raw_normalized,
        dictionary_form=dictionary_form,
        reading=reading,
        surface_reading=surface_reading,
        dictionary_id=dictionary_id,
        source_word_id=source_word_id,
        base_word_id=base_word_id,
    )
