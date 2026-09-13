"""Root schema review witness: current closed token rejects necessary stored readings."""

import pytest

from coursekit.artifacts import ArtifactError, validate_record


def row():
    return {
        "schema_version": 1,
        "sentence_id": "0123456789abcdef",
        "lang": "ja",
        "adapter": {
            "name": "sudachipy",
            "version": "0.6.11",
            "model": "sudachidict_core-20260723",
            "split_mode": "A",
        },
        "tokens": [
            {
                "surface": "辛い",
                "lemma": "辛い",
                "pos": "ADJ",
                "morph": "",
                "start": 0,
                "end": 2,
                "reading": "カライ",
                "normalized_form": "辛い",
            }
        ],
        "lemmas": ["辛い"],
        "display_tokens": ["辛い"],
    }


def test_INV_PACK_51_exact_stored_reading_is_a_valid_g1_carrier():
    validate_record("analysed_sentence", row())


def test_INV_PACK_51_missing_reading_cannot_pass_japanese_schema():
    value = row()
    for token in value["tokens"]:
        del token["reading"]
        del token["normalized_form"]
    with pytest.raises(ArtifactError, match="reading"):
        validate_record("analysed_sentence", value)


@pytest.mark.parametrize("field", ["reading", "normalized_form"])
@pytest.mark.parametrize("bad", ["", "   ", None, 7])
def test_INV_PACK_51_reading_carrier_rejects_invalid_values(field, bad):
    value = row()
    value["tokens"][0][field] = bad
    with pytest.raises(ArtifactError):
        validate_record("analysed_sentence", value)


def candidate():
    value = row()
    return {
        "schema_version": 1,
        "lang": "ja",
        "candidate_id": "0123456789abcdef",
        "unit_index": 1,
        "lesson_index": 1,
        "slot_index": 0,
        "text": "辛い",
        "translation": "Spicy",
        "author": "local-fixture",
        "generated_at": "2026-09-13",
        "accepted": True,
        "reject_reason": None,
        "provenance": "llm",
        "analysis": {
            "analyser": value["adapter"],
            "tokens": value["tokens"],
            "lemmas": value["lemmas"],
            "display_tokens": value["display_tokens"],
        },
    }


def test_INV_PACK_51_candidate_carries_the_same_reading_boundary():
    value = candidate()
    validate_record("candidate", value)
    del value["analysis"]["tokens"][0]["reading"]
    with pytest.raises(ArtifactError, match="reading"):
        validate_record("candidate", value)


@pytest.mark.parametrize("kind", ["analysed_sentence", "candidate"])
def test_INV_PACK_40_lexical_ledger_never_claims_mode_C(kind):
    value = row() if kind == "analysed_sentence" else candidate()
    adapter = value["adapter"] if kind == "analysed_sentence" else value["analysis"]["analyser"]
    adapter["split_mode"] = "C"
    with pytest.raises(ArtifactError, match="Mode A"):
        validate_record(kind, value)


@pytest.mark.parametrize("lang", ["es", "fr", "de"])
def test_latin_analysis_remains_compatible_without_japanese_fields(lang):
    value = row()
    value["lang"] = lang
    value["adapter"]["split_mode"] = None
    for token in value["tokens"]:
        del token["reading"]
        del token["normalized_form"]
    validate_record("analysed_sentence", value)


def test_japanese_rejected_candidate_can_still_have_no_analysis():
    value = candidate()
    value.update(accepted=False, reject_reason="not analyzed", analysis=None)
    validate_record("candidate", value)


def test_japanese_punctuation_does_not_require_a_reading():
    value = row()
    value["tokens"].append(
        {"surface": "。", "lemma": "。", "pos": "PUNCT", "morph": "", "start": 2, "end": 3}
    )
    validate_record("analysed_sentence", value)


@pytest.mark.parametrize("pos", ["SYM", "X"])
def test_INV_PACK_40_carrier_reuses_the_shared_nonlexical_policy(pos):
    value = row()
    value["tokens"].append(
        {"surface": "🙂", "lemma": "🙂", "pos": pos, "morph": "", "start": 2, "end": 3}
    )
    validate_record("analysed_sentence", value)
