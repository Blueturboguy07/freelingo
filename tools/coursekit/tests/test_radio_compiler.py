"""Original Radio preparation fixtures; no timing, audio or language-review claims."""

import hashlib
import json
import re

import pytest

from coursekit.artifacts import sentence_id
from coursekit.narratives.compiler import NarrativeError


def source_fixture():
    return {
        "schema_version": 1,
        "id": "original-radio",
        "title": "El café",
        "translation": "The cafe",
        "language": "es",
        "unit_index": 2,
        "author": "Original author",
        "register": "tu",
        "show": {"id": "original-show", "title": "La charla", "host_character_id": "adult_female"},
        "l1_ratio": 0,
        "target_duration_ms": 240000,
        "segments": [
            {"id": "s1", "character_id": "adult_female", "text": "Hola.", "translation": "Hello."},
            {
                "id": "s2",
                "character_id": "adult_male",
                "text": "Café, pan, leche, agua, queso.",
                "translation": "Coffee, bread, milk, water, cheese.",
            },
            {
                "id": "s3",
                "character_id": "adult_female",
                "text": "Gracias.",
                "translation": "Thank you.",
            },
        ],
        "questions": [
            {
                "id": "q1",
                "kind": "listenSelect",
                "after_segment": "s2",
                "count": 2,
                "correct_lemmas": ["café", "pan"],
                "tile_lemmas": ["café", "pan", "agua", "queso"],
            }
        ],
    }


def analyse(lang, text):
    tokens = [
        {
            "surface": m.group(),
            "lemma": m.group().lower(),
            "pos": "NOUN" if m.group().isalnum() else "PUNCT",
            "morph": "",
            "start": m.start(),
            "end": m.end(),
        }
        for m in re.finditer(r"\w+|[^\w\s]", text)
    ]
    return {
        "schema_version": 1,
        "lang": lang,
        "sentence_id": sentence_id(lang, text),
        "adapter": {
            "name": "original-fixture",
            "version": "1",
            "model": "original",
            "split_mode": None,
        },
        "tokens": tokens,
        "lemmas": [t["lemma"] for t in tokens if t["pos"] == "NOUN"],
        "display_tokens": [t["surface"] for t in tokens if t["pos"] == "NOUN"],
    }


def prepare(source=None, analyser=analyse):
    from coursekit.narratives.radio import prepare_radio
    from coursekit.tts.cast import load_cast

    source = source_fixture() if source is None else source
    raw = json.dumps(source, ensure_ascii=False, indent=2)
    return prepare_radio(raw, analyse=analyser, cast=load_cast("es"))


def test_INV_PACK_10_radio_preparation_preserves_exact_source_and_explicit_unbaked_status():
    source = source_fixture()
    raw = json.dumps(source, ensure_ascii=False, indent=2)
    result = prepare(source)
    assert result.source_hash == hashlib.sha256(raw.encode()).hexdigest()
    assert result.source == source and result.source is not source
    assert result.author == source["author"]
    assert result.analyses["segment:s2"]["sentence_id"] == sentence_id(
        "es", source["segments"][1]["text"]
    )
    assert not hasattr(result, "audio") and not hasattr(result, "document")
    assert result.requires == ("review", "target-bindings", "curriculum-validation", "audio")


@pytest.mark.parametrize(
    "fault",
    [
        "unknown-root",
        "duplicate-segment",
        "unknown-cast",
        "unknown-host",
        "wrong-language",
        "missing-translation",
        "unknown-anchor",
        "duplicate-anchor",
        "wrong-count",
        "missing-tile",
        "unknown-shape",
        "audio-injection",
    ],
)
def test_INV_STO_06_radio_source_rejects_ambiguous_or_undeclared_structure(fault):
    source = source_fixture()
    if fault == "unknown-root":
        source["extra"] = True
    if fault == "duplicate-segment":
        source["segments"][1]["id"] = "s1"
    if fault == "unknown-cast":
        source["segments"][1]["character_id"] = "unknown"
    if fault == "unknown-host":
        source["show"]["host_character_id"] = "unknown"
    if fault == "wrong-language":
        source["language"] = "fr"
    if fault == "missing-translation":
        source["segments"][0].pop("translation")
    if fault == "unknown-anchor":
        source["questions"][0]["after_segment"] = "unknown"
    if fault == "duplicate-anchor":
        source["questions"].append({**source["questions"][0], "id": "q2"})
    if fault == "wrong-count":
        source["questions"][0]["count"] = 3
    if fault == "missing-tile":
        source["questions"][0]["tile_lemmas"] = ["café", "agua"]
    if fault == "unknown-shape":
        source["questions"][0]["kind"] = "quiz"
    if fault == "audio-injection":
        source["segments"][0]["startMs"] = 0
    with pytest.raises(NarrativeError):
        prepare(source)


@pytest.mark.parametrize(
    "fault",
    [
        "wrong-id",
        "wrong-language",
        "wrong-span",
        "missing-token",
        "missing-analysis",
        "wrong-lemma-list",
    ],
)
def test_INV_AUD_04_every_source_surface_has_exact_complete_current_analysis(fault):
    def broken(lang, text):
        row = analyse(lang, text)
        if fault == "wrong-id":
            row["sentence_id"] = "0" * 16
        if fault == "wrong-language":
            row["lang"] = "fr"
        if fault == "wrong-span":
            row["tokens"][0]["start"] += 1
        if fault == "missing-token":
            row["tokens"].pop()
        if fault == "missing-analysis":
            return {}
        if fault == "wrong-lemma-list":
            row["lemmas"] = ["unknown"]
        return row

    with pytest.raises(NarrativeError, match="analysis"):
        prepare(analyser=broken)


def test_INV_PACK_10_duplicate_json_keys_are_not_silently_overwritten():
    from coursekit.narratives.radio import prepare_radio
    from coursekit.tts.cast import load_cast

    raw = json.dumps(source_fixture()).replace(
        '"schema_version": 1', '"schema_version": 1, "schema_version": 1'
    )
    with pytest.raises(NarrativeError, match="Duplicate"):
        prepare_radio(raw, analyse=analyse, cast=load_cast("es"))


def test_INV_STO_10_lemma_claims_do_not_choose_hidden_token_occurrences_or_pack_ids():
    source = source_fixture()
    source["segments"][1]["text"] = "Café y café."
    result = prepare(source)
    assert result.source["questions"][0]["tile_lemmas"] == source["questions"][0]["tile_lemmas"]
    assert "itemIds" not in json.dumps(result.source)
    assert "target-bindings" in result.requires


def test_INV_PACK_10_all_bilingual_question_surfaces_are_preserved_for_review():
    source = source_fixture()
    source["questions"] = [
        {
            "id": "q1",
            "kind": "comprehension",
            "after_segment": "s2",
            "prompt": "¿Qué hay?",
            "accepted": "Café.",
            "distractors": ["Té.", "Jugo."],
            "target_lemmas": ["café"],
        }
    ]
    result = prepare(source)
    assert {
        "question:q1:prompt",
        "question:q1:accepted",
        "question:q1:distractor:0",
        "question:q1:distractor:1",
    } <= result.analyses.keys()
    assert result.source["segments"][1]["translation"] == source["segments"][1]["translation"]
    source["questions"][0]["accepted"] = "Changed."
    assert result.source["questions"][0]["accepted"] == "Café."
