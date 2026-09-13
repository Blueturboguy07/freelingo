"""Occurrence-bound source evidence; a reserve or stale analysis cannot certify G7."""

from copy import deepcopy

import pytest

from coursekit.artifacts import ARTIFACT_SCHEMA_VERSION, dedup_hash, sentence_id
from coursekit.selected_sources import (
    SourceEvidenceError,
    resolve_selected_sources,
    source_population_digest,
)

pytestmark = pytest.mark.parametrize("invariant", ["INV-PACK-06", "INV-PACK-41"])


def source_fixture():
    text = "Gato"
    sid = sentence_id("es", text)
    adapter = {"name": "fixture", "version": "1", "model": "fixture", "split_mode": None}
    token = {
        "surface": text,
        "lemma": "gato",
        "pos": "NOUN",
        "morph": "Number=Sing",
        "start": 0,
        "end": 4,
    }
    source = {
        "schema_version": ARTIFACT_SCHEMA_VERSION,
        "sentence_id": sid,
        "lang": "es",
        "l1": "en",
        "text": text,
        "translation": "Cat",
        "source_id": "fixture",
        "corpus": "fixture",
        "corpus_version": "1",
        "licence": "CC0-1.0",
        "licence_verdict": "shippable",
        "attribution_required": False,
        "attribution_owner": None,
        "token_count": 1,
        "dedup_hash": dedup_hash(text),
    }
    analysis = {
        "schema_version": ARTIFACT_SCHEMA_VERSION,
        "sentence_id": sid,
        "lang": "es",
        "adapter": adapter,
        "tokens": [token],
        "lemmas": ["gato"],
        "display_tokens": [text],
    }
    item = {
        "schema_version": ARTIFACT_SCHEMA_VERSION,
        "lang": "es",
        "unit_index": 1,
        "lesson_index": 1,
        "slot_index": 0,
        "sentence_id": sid,
        "provenance": "corpus",
        "gap": False,
        "new_lemmas": ["gato"],
        "known_lemmas": [],
        "grammar_concept": "being",
        "accepted_alternates": [],
    }
    unit = {"unit_index": 1, "grammar_concept": "being", "register_slot": "n/a"}
    return {
        "selected": [item],
        "candidates": [],
        "ingested": [source],
        "analysed": [analysis],
        "units": [unit],
    }


def resolve(data):
    return resolve_selected_sources("es", **data)


def test_exact_corpus_pair_and_destination_are_bound(invariant):
    data = source_fixture()
    sources = resolve(data)
    assert sources[0].slot == (1, 1, 0)
    assert sources[0].source_kind == "corpus"
    assert sources[0].lemmas == frozenset({"gato"})
    old = source_population_digest(sources)
    data["ingested"][0]["translation"] = "Kitten"
    assert source_population_digest(resolve(data)) != old
    data["selected"][0]["known_lemmas"] = ["perro"]
    assert source_population_digest(resolve(data)) != old


@pytest.mark.parametrize(
    "defect",
    [
        "missing_source",
        "missing_analysis",
        "stale_analysis",
        "duplicate_slot",
        "wrong_language",
        "unknown_unit",
        "wrong_concept",
        "nonshippable",
        "forged_source_id",
    ],
)
def test_incomplete_or_crossed_source_joins_fail_closed(invariant, defect):
    data = source_fixture()
    if defect == "missing_source":
        data["ingested"] = []
    elif defect == "missing_analysis":
        data["analysed"] = []
    elif defect == "stale_analysis":
        data["analysed"][0]["tokens"][0]["surface"] = "Perro"
    elif defect == "duplicate_slot":
        data["selected"].append(deepcopy(data["selected"][0]))
    elif defect == "wrong_language":
        data["selected"][0]["lang"] = "fr"
    elif defect == "unknown_unit":
        data["units"] = []
    elif defect == "wrong_concept":
        data["selected"][0]["grammar_concept"] = "other"
    elif defect == "nonshippable":
        data["ingested"][0]["licence_verdict"] = "oracle_only"
    else:
        data["ingested"][0]["text"] = "Perro"
    with pytest.raises(SourceEvidenceError):
        resolve(data)


def test_only_first_surviving_candidate_may_fill_exact_slot(invariant):
    data = source_fixture()
    item = data["selected"][0]
    item.update(sentence_id=None, gap=True, provenance="llm")
    g1 = data["analysed"][0]
    candidate = {
        "schema_version": ARTIFACT_SCHEMA_VERSION,
        "lang": "es",
        "candidate_id": "1" * 16,
        "unit_index": 1,
        "lesson_index": 1,
        "slot_index": 0,
        "text": "Gato",
        "translation": "Cat",
        "accepted_alternates": [],
        "author": "fixture",
        "generated_at": "2026-09-13",
        "accepted": True,
        "reject_reason": None,
        "provenance": "llm",
        "analysis": {
            "analyser": g1["adapter"],
            "tokens": g1["tokens"],
            "lemmas": g1["lemmas"],
            "display_tokens": g1["display_tokens"],
        },
    }
    reserve = deepcopy(candidate)
    reserve["candidate_id"] = "2" * 16
    rejected = deepcopy(candidate)
    rejected.update(candidate_id="3" * 16, accepted=False, reject_reason="test")
    data["candidates"] = [rejected, candidate, reserve]
    assert resolve(data)[0].source_id == "1" * 16
    candidate["analysis"] = None
    with pytest.raises(SourceEvidenceError):
        resolve(data)
    candidate["analysis"] = reserve["analysis"]
    candidate["lesson_index"] = 2
    reserve["lesson_index"] = 2
    with pytest.raises(SourceEvidenceError):
        resolve(data)


def test_population_digest_binds_actual_analysis_and_legacy_alternates(invariant):
    data = source_fixture()
    old = source_population_digest(resolve(data))
    data["selected"][0]["accepted_alternates"] = ["Un gato"]
    assert source_population_digest(resolve(data)) != old
    data = source_fixture()
    data["analysed"][0]["tokens"][0]["lemma"] = "gatar"
    assert source_population_digest(resolve(data)) != old
