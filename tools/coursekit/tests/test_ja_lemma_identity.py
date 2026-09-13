"""Japanese identity must follow exact dictionary pointers, not surface readings."""

from __future__ import annotations

from types import SimpleNamespace

import pytest


def api():
    from coursekit.adapters.sudachi_identity import LemmaIdentityError, resolve_lemma_identity

    return LemmaIdentityError, resolve_lemma_identity


class Morpheme:
    def __init__(
        self,
        *,
        word_id=11,
        dictionary_id=0,
        base_id=42,
        reading="タベ",
        normalized="食べる",
        oov=False,
    ):
        self.word = word_id
        self.dictionary = dictionary_id
        self.base = base_id
        self.reading = reading
        self.normalized = normalized
        self.oov = oov

    def word_id(self):
        return self.word

    def dictionary_id(self):
        return self.dictionary

    def get_word_info(self):
        return SimpleNamespace(dictionary_form_word_id=self.base)

    def reading_form(self):
        return self.reading

    def normalized_form(self):
        return self.normalized

    def dictionary_form(self):
        return "食べる"

    def surface(self):
        return "食べ"

    def is_oov(self):
        return self.oov

    def part_of_speech(self):
        return ("動詞", "一般", "*", "*", "下一段-バ行", "連用形-一般")


class Dictionary:
    def __init__(self, entries):
        self.entries = entries
        self.looked_up = []

    def lookup(self, text):
        self.looked_up.append(text)
        return self.entries


def test_INV_PACK_51_exact_dictionary_and_word_ids_choose_the_base_not_first_result():
    _, resolve = api()
    source = Morpheme()
    wrong = Morpheme(word_id=42, dictionary_id=1, reading="チガウ")
    first = Morpheme(word_id=41, reading="ベツ")
    base = Morpheme(word_id=42, reading="タベル")
    dictionary = Dictionary([wrong, first, base])
    result = resolve(source, dictionary)
    assert result.lemma == "食べる"
    assert result.reading == "タベル"
    assert result.surface_reading == "タベ"
    assert (result.dictionary_id, result.source_word_id, result.base_word_id) == (0, 11, 42)
    assert dictionary.looked_up == ["食べる"]


@pytest.mark.parametrize(
    "entries",
    [
        [],
        [Morpheme(word_id=41)],
        [Morpheme(word_id=42, dictionary_id=1)],
        [Morpheme(word_id=42), Morpheme(word_id=42)],
    ],
)
def test_INV_PACK_51_absent_wrong_or_ambiguous_link_rejects_by_name(entries):
    error, resolve = api()
    with pytest.raises(error, match="食べ"):
        resolve(Morpheme(), Dictionary(entries))


@pytest.mark.parametrize(
    "source",
    [
        Morpheme(oov=True),
        Morpheme(dictionary_id=-1),
        Morpheme(dictionary_id=1),
        Morpheme(word_id=-1),
    ],
)
def test_INV_PACK_51_oov_or_unpinned_dictionary_cannot_invent_identity(source):
    error, resolve = api()
    with pytest.raises(error, match="食べ"):
        resolve(source, Dictionary([Morpheme(word_id=42, reading="タベル")]))


@pytest.mark.parametrize(
    "base",
    [
        Morpheme(word_id=42, reading=""),
        Morpheme(word_id=42, normalized="飲む"),
        Morpheme(word_id=42, oov=True),
    ],
)
def test_INV_PACK_51_invalid_linked_base_cannot_supply_a_lemma_reading(base):
    error, resolve = api()
    with pytest.raises(error, match="食べ"):
        resolve(Morpheme(), Dictionary([base]))


def test_INV_PACK_51_uninflected_self_pointer_preserves_its_exact_reading():
    _, resolve = api()
    source = Morpheme(word_id=11, base_id=-1, reading="タベル")
    result = resolve(source, Dictionary([source]))
    assert result.reading == "タベル"
    assert result.base_word_id == 11


def test_INV_PACK_51_real_inflections_share_the_dictionary_linked_lemma_reading():
    from sudachipy import Dictionary, SplitMode

    _, resolve = api()
    dictionary = Dictionary(dict="core")
    tokenizer = dictionary.create(SplitMode.A)
    identities = []
    for sentence in ["食べる。", "食べます。", "食べた。"]:
        source = tokenizer.tokenize(sentence)[0]
        identities.append(resolve(source, dictionary))
    assert {(i.lemma, i.reading) for i in identities} == {("食べる", "タベル")}
    assert len({i.base_word_id for i in identities}) == 1
    assert {i.surface_reading for i in identities} == {"タベ", "タベル"}


def test_INV_PACK_51_real_homographic_base_entries_remain_distinct():
    from sudachipy import Dictionary

    _, resolve = api()
    dictionary = Dictionary(dict="core")
    readings = {}
    for source in dictionary.lookup("辛い"):
        if source.reading_form() in {"カライ", "ツライ"}:
            identity = resolve(source, dictionary)
            readings[identity.reading] = identity
    assert set(readings) == {"カライ", "ツライ"}
    assert {i.lemma for i in readings.values()} == {"辛い"}
    assert len({i.base_word_id for i in readings.values()}) == 2


def test_INV_PACK_48_real_synthesized_numeral_is_not_silently_merged():
    from sudachipy import Dictionary, SplitMode

    error, resolve = api()
    dictionary = Dictionary(dict="core")
    source = dictionary.create(SplitMode.A).tokenize("三本あります。")[0]
    assert source.is_oov()
    with pytest.raises(error, match="三"):
        resolve(source, dictionary)
