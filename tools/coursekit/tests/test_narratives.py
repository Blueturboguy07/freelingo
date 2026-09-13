"""P6 falsifiers from the invariant text; no baked/audio or linguistic claim from stubs."""

from __future__ import annotations

import re

import pytest

from coursekit.narratives.audio import assert_audio_budget, audio_is_fresh
from coursekit.narratives.compiler import NarrativeError, compile_story, parse_markup
from coursekit.narratives.review import review_hash, select_reviewed

SOURCE = """[DATA]
id=coffee
language=es
unit=5
fromLanguageName=Coffee
author=author-A
narrator_register=tu
cover=coffee.png

[HEADER]
> El café
~ the coffee

[LINE]
Speakeradult_female: Quiero café.
~ I~want coffee
= I want coffee.

[SELECT_PHRASE]
> Select the missing phrase
Speakeradult_male: Quiero [café].
~ I~want coffee
= I want coffee.
@tags=café
+ café
- té
- leche

[MATCH]
- café <> coffee
"""


def analyse(text: str) -> dict:
    return {
        "tokens": [
            {
                "surface": m.group(),
                "lemma": m.group().lower(),
                "pos": "NOUN",
                "start": m.start(),
                "end": m.end(),
                "morph": "",
            }
            for m in re.finditer(r"[^\W\d_]+", text)
        ],
        "lemmas": [m.group().lower() for m in re.finditer(r"[^\W\d_]+", text)],
    }


def compile(source=SOURCE, **kwargs):
    return compile_story(source, analyse=analyse, item_ids={"café": "i_actual_pack_cafe"}, **kwargs)


def test_inv_pack_09_unique_blocks_and_final_match():
    result = compile()
    assert result.document["elements"][-1]["type"] == "MATCH"
    assert any(f.severity == "warning" and "five" in f.message for f in result.findings)
    with pytest.raises(NarrativeError, match="exactly one"):
        compile(SOURCE + "\n[DATA]\nid=other")
    with pytest.raises(NarrativeError, match="last"):
        compile(SOURCE + "\n[LINE]\n> Hola.\n= Hello.")


def test_inv_pack_09_unknown_block_compiles_inline_and_keeps_later_content():
    result = compile(SOURCE.replace("[MATCH]", "[TYPO]\nignored\n\n[MATCH]"))
    assert any(e["type"] == "ERROR" for e in result.document["elements"])
    assert result.document["elements"][-1]["type"] == "MATCH"


def test_inv_pack_22_match_occurrence_uses_lemmas_not_substrings():
    with pytest.raises(NarrativeError, match="occur"):
        compile(SOURCE.replace("- café <> coffee", "- ca <> here"))

    def inflected(text):
        row = analyse(text)
        for t in row["tokens"]:
            if t["surface"].lower() in {"como", "comer"}:
                t["lemma"] = "comer"
        return row

    source = (
        SOURCE.replace("café", "como")
        .replace("- como <> coffee", "- comer <> to eat")
        .replace("@tags=como", "@tags=comer")
    )
    result = compile_story(source, analyse=inflected, item_ids={"comer": "i_eat"})
    assert result.document["elements"][-1]["pairs"][0]["itemIds"] == ["i_eat"]


def test_inv_pack_23_hidden_range_cannot_split_a_morpheme():
    with pytest.raises(NarrativeError, match="boundary"):
        compile(SOURCE.replace("[café]", "ca[fé]"))


def test_inv_sto_03_nested_arrange_and_unicode_wire_spans():
    text, hidden, choices = parse_markup("😀 [(Quiero) (un~café)].")
    assert text == "😀 Quiero un café."
    assert hidden == [{"start": 3, "end": 17}]
    assert choices[1]["start"] == 10
    assert choices[1]["end"] == 17


def test_inv_pack_09_real_ids_are_required_not_derived_from_display_text():
    with pytest.raises(NarrativeError, match="item id"):
        compile_story(SOURCE, analyse=analyse, item_ids={})


def test_inv_pack_10_only_independently_reviewed_exact_candidates_survive():
    first = {"id": "bad", "text": "mal", "author": "a"}
    second = {"id": "good", "text": "bien", "author": "a"}
    reviews = [
        {"content_hash": review_hash(first), "verdict": "reject", "reviewer": "b"},
        {"content_hash": review_hash(second), "verdict": "accept", "reviewer": "b"},
    ]
    chosen, discarded = select_reviewed([first, second], reviews)
    assert chosen is second
    assert discarded == ["bad"]
    assert first["text"] == "mal"
    with pytest.raises(NarrativeError, match="review"):
        select_reviewed([dict(second, text="changed")], reviews)
    with pytest.raises(NarrativeError, match="review"):
        select_reviewed([second], [dict(reviews[1], reviewer="a")])


def test_inv_aud_04_changed_text_or_cast_makes_audio_stale():
    proof = {"text": "Quiero café.", "voice_version": "v1", "asset": "a.opus"}
    assert audio_is_fresh(proof, text="Quiero café.", voice_version="v1")
    assert not audio_is_fresh(proof, text="Quiero té.", voice_version="v1")
    assert not audio_is_fresh(proof, text="Quiero café.", voice_version="v2")


def test_inv_pack_15_budget_counts_all_three_real_pipeline_sizes():
    totals = assert_audio_budget({"lesson": 10, "story": 20, "radio": 30}, budget_bytes=60)
    assert totals == 60
    with pytest.raises(NarrativeError, match="budget"):
        assert_audio_budget({"lesson": 10, "story": 20, "radio": 31}, budget_bytes=60)
    with pytest.raises(NarrativeError, match="three"):
        assert_audio_budget({"lesson": 10}, budget_bytes=60)


def test_inv_sto_03_continuation_omits_hidden_speech_without_splitting_surrogates():
    result = compile(
        SOURCE.replace("[SELECT_PHRASE]", "[CONTINUATION]")
        .replace("Speakeradult_male: Quiero [café].", "Speakeradult_male: 😀 Quiero [café].")
        .replace("~ I~want coffee\n= I want coffee.\n@tags", "= I want coffee.\n@tags")
    )
    line = next(e for e in result.document["elements"] if e.get("spokenText") is not None)
    assert line["spokenText"] == "😀 Quiero ."
    assert line["content"]["text"] == "😀 Quiero café."


def test_INV_PACK_40_story_hints_follow_supplied_lexical_spans_inside_a_fixture_compound():
    # Original exact adapter fixture, deliberately unlike a regex word boundary.
    # It proves which segmentation the parser uses, not a real language analysis.
    source = SOURCE.replace("Speakeradult_female: Quiero café.", "Speakeradult_female: 猫犬.")
    source = source.replace("~ I~want coffee", "~ cat dog", 1)

    def explicit(text):
        if text != "猫犬.":
            return analyse(text)
        return {
            "tokens": [
                {"surface": "猫", "lemma": "猫", "pos": "NOUN", "start": 0, "end": 1, "morph": ""},
                {"surface": "犬", "lemma": "犬", "pos": "NOUN", "start": 1, "end": 2, "morph": ""},
                {"surface": ".", "lemma": ".", "pos": "PUNCT", "start": 2, "end": 3, "morph": ""},
            ],
            "lemmas": ["猫", "犬"],
        }

    story = compile_story(source, analyse=explicit, item_ids={"café": "i_original"})
    line = next(row for row in story.document["elements"] if row["type"] == "LINE")
    assert line["content"]["hints"] == [
        {"start": 0, "end": 1, "gloss": "cat"},
        {"start": 1, "end": 2, "gloss": "dog"},
    ]


def test_INV_PACK_40_story_hint_grouping_uses_only_explicit_tilde_fields():
    source = SOURCE.replace(
        "Speakeradult_female: Quiero café.", "Speakeradult_female: Quiero~café."
    )
    source = source.replace("~ I~want coffee", "~ want~coffee", 1)
    story = compile(source)
    line = next(row for row in story.document["elements"] if row["type"] == "LINE")
    assert line["content"]["hints"] == [{"start": 0, "end": 11, "gloss": "want coffee"}]
