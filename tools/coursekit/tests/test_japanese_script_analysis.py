"""Bound Japanese A/C evidence; structure does not certify contextual pronunciation."""

from __future__ import annotations

from copy import deepcopy

import pytest


def api():
    from coursekit import japanese_script as module

    return module


def fixture():
    from coursekit.artifacts import sentence_id

    text = "国家公務員です。"
    rows = [
        ("国家", 0, 2, "NOUN", "コッカ"),
        ("公務", 2, 4, "NOUN", "コウム"),
        ("員", 4, 5, "NOUN", "イン"),
        ("です", 5, 7, "AUX", "デス"),
        ("。", 7, 8, "PUNCT", "。"),
    ]
    tokens = [
        {
            "surface": s,
            "start": a,
            "end": b,
            "lemma": s,
            "normalized_form": s,
            "reading": r,
            "pos": p,
            "morph": "",
        }
        for s, a, b, p, r in rows
    ]
    analysis = {
        "schema_version": 1,
        "lang": "ja",
        "sentence_id": sentence_id("ja", text),
        "adapter": {
            "name": "sudachipy",
            "version": "0.6.11",
            "model": "sudachidict_core-20260723",
            "split_mode": "A",
        },
        "tokens": tokens,
        "lemmas": [t["lemma"] for t in tokens if t["pos"] != "PUNCT"],
        "display_tokens": ["国家公務員", "です"],
    }
    mode_c = [
        {"surface": "国家公務員", "start": 0, "end": 5, "reading": "コッカコウムイン"},
        {"surface": "です", "start": 5, "end": 7, "reading": "デス"},
        {"surface": "。", "start": 7, "end": 8, "reading": "。"},
    ]
    surfaces = [
        dict(
            token_index=i,
            surface=t["surface"],
            start=t["start"],
            end=t["end"],
            reading=t["reading"],
        )
        for i, t in enumerate(tokens)
    ]
    return text, analysis, mode_c, surfaces


def record():
    text, analysis, mode_c, surfaces = fixture()
    script = api().build_script_analysis(
        analysis,
        text=text,
        mode_c_tokens=mode_c,
        mode_a_surface_readings=surfaces,
        tts_reading="こっかこうむいんです。",
    )
    return text, analysis, script


def test_INV_PACK_40_47_exact_A_C_projection_is_total_without_counting_compounds_once():
    from coursekit.ledger import count_units

    text, analysis, script = record()
    proof = api().validate_script_analysis(script, analysis, text=text)
    assert proof.mode_a_to_mode_c == (0, 0, 0, 1, 2)
    assert count_units(analysis) == 4
    assert proof.reading_review_status == "unreviewed"


@pytest.mark.parametrize(
    "field,value",
    [
        ("text", "別の文章。"),
        ("text_sha256", "0" * 64),
        ("analysis_sha256", "0" * 64),
        ("sentence_id", "ffffffffffffffff"),
        ("lang", "fr"),
    ],
)
def test_INV_PACK_40_script_cannot_join_a_stale_or_different_source(field, value):
    text, analysis, script = record()
    script[field] = value
    with pytest.raises(api().ScriptAnalysisError):
        api().validate_script_analysis(script, analysis, text=text)


def test_INV_PACK_06_analysis_hash_binds_adapter_and_each_token_reading():
    text, analysis, script = record()
    altered = deepcopy(analysis)
    altered["tokens"][0]["reading"] = "ベツ"
    with pytest.raises(api().ScriptAnalysisError, match="analysis"):
        api().validate_script_analysis(script, altered, text=text)
    script["adapter"]["version"] = "future"
    with pytest.raises(api().ScriptAnalysisError, match="adapter"):
        api().validate_script_analysis(script, analysis, text=text)


@pytest.mark.parametrize(
    "change",
    [
        "missing_c",
        "overlap_c",
        "wrong_surface",
        "cross_a",
        "wrong_display",
        "blank_reading",
        "false_offset",
    ],
)
def test_INV_PACK_43_47_cannot_hide_gaps_overlap_or_crossing_A_spans(change):
    text, analysis, script = record()
    if change == "missing_c":
        script["mode_c_tokens"].pop(1)
    elif change == "overlap_c":
        script["mode_c_tokens"].insert(1, deepcopy(script["mode_c_tokens"][0]))
    elif change == "wrong_surface":
        script["mode_c_tokens"][0]["surface"] = "国家公務"
    elif change == "cross_a":
        script["mode_c_tokens"] = [
            {"surface": "国家公", "start": 0, "end": 3, "reading": "コッカコウ"},
            {"surface": "務員", "start": 3, "end": 5, "reading": "ムイン"},
            *script["mode_c_tokens"][1:],
        ]
    elif change == "wrong_display":
        analysis["display_tokens"] = ["国家", "公務", "員", "です"]
        script["analysis_sha256"] = api().analysis_digest(analysis)
    elif change == "blank_reading":
        script["mode_c_tokens"][0]["reading"] = " "
    elif change == "false_offset":
        script["mode_c_tokens"][0]["start"] = False
    with pytest.raises(api().ScriptAnalysisError):
        api().validate_script_analysis(script, analysis, text=text)


@pytest.mark.parametrize("change", ["missing", "duplicate", "span", "reading"])
def test_INV_PACK_52_surface_readings_cover_exact_A_tokens(change):
    text, analysis, script = record()
    if change == "missing":
        script["mode_a_surface_readings"].pop()
    elif change == "duplicate":
        script["mode_a_surface_readings"][1]["token_index"] = 0
    elif change == "span":
        script["mode_a_surface_readings"][0]["end"] = 1
    elif change == "reading":
        script["mode_a_surface_readings"][0]["reading"] = ""
    with pytest.raises(api().ScriptAnalysisError):
        api().validate_script_analysis(script, analysis, text=text)


def test_INV_PACK_51_surface_and_lemma_readings_are_preserved_separately():
    text, analysis, mode_c, surfaces = fixture()
    # A different reading is allowed structurally: only external linguistic evidence
    # can certify correctness. The identities must not be silently overwritten.
    analysis["tokens"][0]["reading"] = "ジショヨミ"
    script = api().build_script_analysis(
        analysis,
        text=text,
        mode_c_tokens=mode_c,
        mode_a_surface_readings=surfaces,
        tts_reading="こっかこうむいんです。",
    )
    assert script["mode_a_surface_readings"][0]["reading"] == "コッカ"
    assert analysis["tokens"][0]["reading"] == "ジショヨミ"


def test_INV_PACK_52_analysis_only_cannot_self_declare_linguistic_review():
    text, analysis, script = record()
    script["reading_review_status"] = "reviewed"
    with pytest.raises(api().ScriptAnalysisError, match="review"):
        api().validate_script_analysis(script, analysis, text=text)


def test_INV_PACK_40_empty_or_unknown_shape_is_not_bound_evidence():
    text, analysis, script = record()
    script["invented"] = True
    with pytest.raises(api().ScriptAnalysisError):
        api().validate_script_analysis(script, analysis, text=text)
    _, analysis, mode_c, surfaces = fixture()
    analysis["tokens"] = []
    with pytest.raises(api().ScriptAnalysisError):
        api().build_script_analysis(
            analysis,
            text=text,
            mode_c_tokens=mode_c,
            mode_a_surface_readings=surfaces,
            tts_reading="こっかこうむいんです。",
        )


@pytest.mark.parametrize("reading", ["国家公務員です。", "123", " ", "。"])
def test_INV_PACK_52_tts_reading_is_nonempty_kana_not_display_kanji(reading):
    text, analysis, script = record()
    script["tts_reading"] = reading
    with pytest.raises(api().ScriptAnalysisError, match="kana"):
        api().validate_script_analysis(script, analysis, text=text)


def test_INV_PACK_40_source_id_is_bound_even_if_a_forged_pair_agrees():
    text, analysis, mode_c, surfaces = fixture()
    analysis["sentence_id"] = "f" * 16
    with pytest.raises(api().ScriptAnalysisError, match="identity"):
        api().build_script_analysis(
            analysis,
            text=text,
            mode_c_tokens=mode_c,
            mode_a_surface_readings=surfaces,
            tts_reading="こっかこうむいんです。",
        )


def test_INV_PACK_51_lemma_cannot_switch_from_shared_normalized_form():
    text, analysis, mode_c, surfaces = fixture()
    analysis["tokens"][0]["lemma"] = "別"
    with pytest.raises(api().ScriptAnalysisError, match="normalized_form"):
        api().build_script_analysis(
            analysis,
            text=text,
            mode_c_tokens=mode_c,
            mode_a_surface_readings=surfaces,
            tts_reading="こっかこうむいんです。",
        )


def test_INV_PACK_40_lemma_array_cannot_hide_or_invent_mode_A_items():
    text, analysis, mode_c, surfaces = fixture()
    analysis["lemmas"] = ["別"]
    with pytest.raises(api().ScriptAnalysisError, match="lemma sequence"):
        api().build_script_analysis(
            analysis,
            text=text,
            mode_c_tokens=mode_c,
            mode_a_surface_readings=surfaces,
            tts_reading="こっかこうむいんです。",
        )


@pytest.mark.parametrize("mode", ["A", "C"])
def test_INV_PACK_47_coherent_surface_forgery_still_cannot_change_the_source_span(mode):
    text, analysis, script = record()
    if mode == "A":
        analysis["tokens"][0]["surface"] = "別物"
        script["mode_a_surface_readings"][0]["surface"] = "別物"
    else:
        script["mode_c_tokens"][0]["surface"] = "別物の名前"
        analysis["display_tokens"][0] = "別物の名前"
    script["analysis_sha256"] = api().analysis_digest(analysis)
    with pytest.raises(api().ScriptAnalysisError, match="source span"):
        api().validate_script_analysis(script, analysis, text=text)
