"""Original source evidence fixtures; no language-review or production fallback."""

import copy

import pytest

from coursekit.artifacts import sentence_id
from coursekit.packbuild.grading import content_hash, surface_id


def analysis_fixture():
    text = "Quiero cantar."
    return text, {
        "schema_version": 1,
        "lang": "es",
        "sentence_id": sentence_id("es", text),
        "adapter": {"name": "original", "version": "1", "model": "test-only", "split_mode": None},
        "tokens": [
            {
                "surface": "Quiero",
                "lemma": "querer",
                "pos": "VERB",
                "morph": "",
                "start": 0,
                "end": 6,
            },
            {
                "surface": "cantar",
                "lemma": "cantar",
                "pos": "VERB",
                "morph": "",
                "start": 7,
                "end": 13,
            },
            {"surface": ".", "lemma": ".", "pos": "PUNCT", "morph": "", "start": 13, "end": 14},
        ],
        "lemmas": ["querer", "cantar"],
        "display_tokens": ["Quiero", "cantar"],
    }


def fixture():
    text, analysis = analysis_fixture()
    source = {"text": text, "analysis": analysis, "lang": "es"}
    policy = {
        "algorithm": "stored-unit-f1-v1",
        "threshold": 0.7,
        "fallback": "normalized-levenshtein-v1",
        "fallbackThreshold": 0.7,
        "ignoredPunctuation": ["."],
        "fillers": [],
    }
    approval = {"speech": {"policy": policy, "analyses": [{"text": text, "analysis": analysis}]}}
    return dict(
        language="es",
        source_id="original-source",
        source=source,
        source_sha256=content_hash(source),
        approval=approval,
        accepted=[{"surfaceId": surface_id("es", text), "surface": text}],
    )


def build(data):
    from coursekit.packbuild.speech import build_speech_evidence

    return build_speech_evidence(**data)


def test_INV_MOD_13_produces_ledger_units_from_exact_approved_spans_not_display_words():
    data = fixture()
    result = build(data)
    ref = result["references"][0]
    assert [token["unit"] for token in ref["tokens"]] == ["querer", "cantar"]
    assert ref["tokens"][0] == {"unit": "querer", "surface": "Quiero", "start": 0, "end": 6}
    assert ref["analysisSha256"] == content_hash(data["source"]["analysis"])
    assert ref["adapterFingerprint"] == content_hash(data["source"]["analysis"]["adapter"])
    assert ref["sourceSha256"] == data["source_sha256"]
    assert result["ledgerUnit"] == "lemma"


@pytest.mark.parametrize(
    "fault",
    [
        "missing-proof",
        "missing-surface",
        "duplicate",
        "extra-surface",
        "stale-source",
        "stale-canonical",
        "wrong-span",
        "missing-token",
        "wrong-sentence",
        "wrong-language",
        "wrong-segmentation",
        "missing-adapter",
        "missing-policy",
        "lower-threshold",
        "letter-punctuation",
        "missing-punctuation",
        "unknown",
        "wrong-surface-id",
    ],
)
def test_INV_MOD_13_incomplete_or_stale_source_evidence_is_not_a_speaking_payload(fault):
    from coursekit.packbuild.speech import SpeechBuildError

    data = fixture()
    speech = data["approval"]["speech"]
    if fault == "missing-proof":
        data["approval"].clear()
    if fault == "missing-surface":
        speech["analyses"] = []
    if fault == "duplicate":
        speech["analyses"] *= 2
    if fault == "extra-surface":
        speech["analyses"].append(
            {"text": "Otro.", "analysis": copy.deepcopy(data["source"]["analysis"])}
        )
    if fault == "stale-source":
        data["source_sha256"] = "0" * 64
    if fault == "stale-canonical":
        speech["analyses"][0]["analysis"] = copy.deepcopy(data["source"]["analysis"])
        speech["analyses"][0]["analysis"]["tokens"][0]["lemma"] = "invented"
        speech["analyses"][0]["analysis"]["lemmas"][0] = "invented"
    if fault == "wrong-span":
        data["source"]["analysis"]["tokens"][0]["surface"] = "Otra"
    if fault == "missing-token":
        del data["source"]["analysis"]["tokens"][0]
    if fault == "wrong-sentence":
        data["source"]["analysis"]["sentence_id"] = "0" * 16
    if fault == "wrong-language":
        data["source"]["analysis"]["lang"] = "de"
    if fault == "wrong-segmentation":
        data["source"]["analysis"]["adapter"]["split_mode"] = "C"
    if fault == "missing-adapter":
        del data["source"]["analysis"]["adapter"]
    if fault == "missing-policy":
        del speech["policy"]
    if fault == "lower-threshold":
        speech["policy"]["threshold"] = 0.6
    if fault == "letter-punctuation":
        speech["policy"]["ignoredPunctuation"].append("a")
    if fault == "missing-punctuation":
        speech["policy"]["ignoredPunctuation"] = []
    if fault == "unknown":
        speech["trusted"] = True
    if fault == "wrong-surface-id":
        data["accepted"][0]["surfaceId"] = "sf_wrong"
    if fault not in {"stale-source", "stale-canonical"}:
        data["source_sha256"] = content_hash(data["source"])
    with pytest.raises(SpeechBuildError):
        build(data)


def test_INV_MOD_13_authored_analysis_keeps_native_analyser_and_token_occurrences():
    data = fixture()
    original = data["source"]["analysis"]
    native = {
        "analyser": original["adapter"],
        **{key: original[key] for key in ("tokens", "lemmas", "display_tokens")},
    }
    data["source"]["analysis"] = native
    data["source_sha256"] = content_hash(data["source"])
    data["approval"]["speech"]["analyses"][0]["analysis"] = native
    assert build(data)["references"][0]["analysisSha256"] == content_hash(native)


def test_INV_MOD_13_alternate_requires_its_own_analysis_and_preserves_authored_order():
    data = fixture()
    text, alt = analysis_fixture()
    text = "Yo " + text
    alt["sentence_id"] = sentence_id("es", text)
    for token in alt["tokens"]:
        token["start"] += 3
        token["end"] += 3
    alt["tokens"].insert(
        0, {"surface": "Yo", "lemma": "yo", "pos": "PRON", "morph": "", "start": 0, "end": 2}
    )
    alt["lemmas"].insert(0, "yo")
    alt["display_tokens"].insert(0, "Yo")
    data["approval"]["speech"]["analyses"].insert(0, {"text": text, "analysis": alt})
    data["accepted"].append({"surfaceId": surface_id("es", text), "surface": text})
    result = build(data)
    assert [row["text"] for row in result["references"]] == ["Quiero cantar.", "Yo Quiero cantar."]
    assert [token["unit"] for token in result["references"][1]["tokens"]] == [
        "yo",
        "querer",
        "cantar",
    ]


def test_INV_MOD_13_japanese_uses_exact_contextual_reading_not_linked_lemma_reading():
    from test_japanese_script_analysis import record

    text, analysis, script = record()
    data = fixture()
    data["language"] = "ja"
    # Independently supplied surface reading differs from the dictionary-linked token reading.
    analysis["tokens"][3]["reading"] = "デアル"
    from coursekit.japanese_script import analysis_digest

    script["analysis_sha256"] = analysis_digest(analysis)
    data["source"] = {"lang": "ja", "text": text, "analysis": analysis}
    data["source_sha256"] = content_hash(data["source"])
    data["accepted"] = [{"surfaceId": surface_id("ja", text), "surface": text}]
    data["approval"]["speech"]["policy"]["ignoredPunctuation"] = ["。"]
    data["approval"]["speech"]["analyses"] = [
        {"text": text, "analysis": analysis, "japaneseScript": script}
    ]
    ref = build(data)["references"][0]
    assert ref["tokens"][3]["reading"] == "デス"
    assert ref["reading"] == "こっかこうむいんです。"
    assert ref["japaneseScriptSha256"] == content_hash(script)
    del data["approval"]["speech"]["analyses"][0]["japaneseScript"]
    from coursekit.packbuild.speech import SpeechBuildError

    with pytest.raises(SpeechBuildError):
        build(data)
