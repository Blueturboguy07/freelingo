"""P7 deterministic adapter falsifiers; injected models are not linguistic evidence."""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from coursekit.adapters import spacy_es
from coursekit.artifacts import validate_record
from coursekit.config.g1 import ADAPTER_SELFTEST
from coursekit.inputs import MissingInput, resolve
from coursekit.ledger import count_units
from coursekit.stages.g1_analyze import adapter_for


@pytest.fixture(
    params=[
        (
            "fr",
            "L'amie vient.",
            [
                ("L'", "le", "DET"),
                ("amie", "ami", "NOUN"),
                ("vient", "venir", "VERB"),
                (".", ".", "PUNCT"),
            ],
        ),
        (
            "de",
            "Die Häuser sind groß.",
            [
                ("Die", "der", "DET"),
                ("Häuser", "Haus", "NOUN"),
                ("sind", "sein", "AUX"),
                ("groß", "groß", "ADJ"),
                (".", ".", "PUNCT"),
            ],
        ),
    ]
)
def case(request, monkeypatch):
    lang, text, rows = request.param

    class Pipeline:
        moved = False

        def __call__(self, value):
            cursor = 0
            result = []
            use = rows if value == text else [(value, value, "NOUN")]
            for surface, lemma, pos in use:
                start = value.index(surface, cursor)
                cursor = start + len(surface)
                result.append(
                    SimpleNamespace(
                        text=surface,
                        lemma_=lemma + ("changed" if self.moved and pos == "NOUN" else ""),
                        pos_=pos,
                        idx=start,
                        is_space=False,
                        morph="Number=Sing",
                    )
                )
            return result

        def pipe(self, values, *, batch_size):
            return map(self, values)

    pipeline = Pipeline()
    monkeypatch.setattr(spacy_es, "_pipeline", lambda model: pipeline)
    expected = " ".join(f"{surface}/{lemma.lower()}/{pos}" for surface, lemma, pos in rows)
    monkeypatch.setitem(ADAPTER_SELFTEST, lang, ((text, expected),))
    return lang, text, rows, pipeline


def test_inv_pack_06_registered_adapter_has_exact_source_and_model(case):
    lang, *_ = case
    adapter = adapter_for(lang)
    assert adapter.name == f"spacy_{lang}"
    assert adapter.model == f"{lang}_core_news_md"
    source = resolve(adapter.name, lang)
    assert source.id == adapter.name
    assert source.url.endswith(f"{lang}_core_news_md-3.8.0-py3-none-any.whl")
    assert source.source.licence == ("LGPL-LR" if lang == "fr" else "MIT")


def test_inv_pack_40_analysis_has_exact_spans_and_counts_lexical_units(case):
    lang, text, rows, _ = case
    record = adapter_for(lang).analyse(sentence_id="0123456789abcdef", text=text)
    validate_record("analysed_sentence", record)
    assert record["lang"] == lang
    assert record["adapter"]["split_mode"] is None
    assert record["lemmas"] == [lemma.lower() for _, lemma, pos in rows if pos != "PUNCT"]
    assert count_units(record) == len(rows) - 1
    for token in record["tokens"]:
        assert text[token["start"] : token["end"]] == token["surface"]
        assert token["morph"] == "Number=Sing"


def test_inv_pack_06_model_drift_fails_before_g1_can_write(case):
    lang, _, _, pipeline = case
    adapter = adapter_for(lang)
    adapter.require_self_test()
    pipeline.moved = True
    with pytest.raises(spacy_es.AdapterSelfTestFailed, match="changed"):
        adapter.require_self_test()


def test_inv_pack_06_empty_or_absent_selftest_is_not_a_green_adapter(case, monkeypatch):
    lang, *_ = case
    adapter = adapter_for(lang)
    for value in ((), None):
        if value is None:
            monkeypatch.delitem(ADAPTER_SELFTEST, lang)
        else:
            monkeypatch.setitem(ADAPTER_SELFTEST, lang, value)
        with pytest.raises(MissingInput, match="self-test"):
            adapter.require_self_test()


def test_inv_pack_40_frequency_batch_uses_same_partition_without_spanish_rules(case):
    lang, *_ = case
    adapter = adapter_for(lang)
    surfaces = ["buenas", "Häuser", "amie"]
    assert adapter.lemmatise_surfaces(surfaces) == [adapter.lemmatise_surface(s) for s in surfaces]
    assert adapter.lemmatise_surface("buenas") == ("buenas", "NOUN")
