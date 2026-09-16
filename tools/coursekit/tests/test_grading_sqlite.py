"""Actual SQLite integration; the small producer population is original test data only."""

from __future__ import annotations

import hashlib
import json
import sqlite3
from dataclasses import replace

import pytest
from test_grading_payload import fixture

from coursekit.packbuild.grading import build_grading_payload
from coursekit.packbuild.sqlite import write_pack


def population(inputs=None):
    inputs = fixture() if inputs is None else inputs
    payload = build_grading_payload(inputs)
    exercise = {
        **inputs.exercises[0],
        "slot_index": 1,
        "preferred_surface": "Quiero cantar.",
        "register": "neutral",
    }
    rows = {
        "meta": [
            {"key": k, "value": v}
            for k, v in {
                "pack_id": "original",
                "course_id": "en-es",
                "version": "1.0.0",
                "lang": "es",
            }.items()
        ],
        "grammar_concept": [
            {
                "concept_id": "g1",
                "name": "Original",
                "description": "Fixture",
                "register_slot": "neutral",
            }
        ],
        "unit": [
            {
                "unit_id": "u1",
                "section_index": 1,
                "section_cefr": "A1",
                "unit_index": 1,
                "title": "One",
                "function": "greet",
                "grammar_concept": "g1",
                "register_slot": "neutral",
                "level_count": 1,
            }
        ],
        "exercise": [exercise],
        "exercise_item_tag": list(inputs.exercise_tags),
        "lexeme": [
            {
                **row,
                "rank": 4,
                "frequency": 1,
                "decile": 1,
                "band": "A1",
                "band_source": "frequency_decile",
                "band_source_licence": None,
                "gloss": None,
            }
            for row in inputs.lexemes
        ],
    }
    proof = payload.provenance["dictionaryProofs"][0]
    credits = [
        {
            "source_id": proof["sourceId"],
            "owner": "Original fixture author",
            "licence": proof["license"],
            "url": proof["sourceUrl"],
            "notice": proof["notice"],
        }
    ]
    return rows, payload, credits


def test_INV_PACK_35_writes_the_real_producer_payload_and_exact_utf8_digest(tmp_path):
    rows, payload, credits = population()
    file = write_pack(tmp_path / "pack.sqlite", rows, grading=payload, grading_credits=credits)
    with sqlite3.connect(file) as db:
        encoded, digest = db.execute(
            "SELECT payload_json,payload_sha256 FROM exercise_runtime WHERE exercise_id='ex1'"
        ).fetchone()
        assert json.loads(encoded) == payload.runtime_items[0]
        assert digest == hashlib.sha256(encoded.encode("utf-8")).hexdigest()
        assert db.execute(
            "SELECT profile_id,surface FROM grading_word ORDER BY surface"
        ).fetchall() == [("spanish", word) for word in ("cantar", "contar", "quiero")]
        assert (
            json.loads(db.execute("SELECT value FROM meta WHERE key='grading:v1'").fetchone()[0])
            == payload.metadata
        )
        assert db.execute("PRAGMA foreign_key_check").fetchall() == []


def test_INV_PACK_17_dictionary_credits_retain_their_exact_source_licence_and_notice(tmp_path):
    rows, payload, credits = population()
    file = write_pack(tmp_path / "pack.sqlite", rows, grading=payload, grading_credits=credits)
    with sqlite3.connect(file) as db:
        credit = json.loads(
            db.execute(
                "SELECT value FROM meta WHERE key='attribution:original-fixture'"
            ).fetchone()[0]
        )
        assert {k: credit[k] for k in credits[0]} == credits[0]
        assert credit["kind"] == "derived-list"
        assert credit["items"] == 3
        assert (
            json.loads(
                db.execute("SELECT value FROM meta WHERE key='grading-provenance:v1'").fetchone()[0]
            )
            == payload.provenance
        )


@pytest.mark.parametrize("change", ["missing", "owner", "licence", "notice", "url"])
def test_INV_PACK_17_missing_or_conflicting_dictionary_credit_refuses_output(tmp_path, change):
    rows, payload, credits = population()
    if change == "missing":
        credits = []
    else:
        credits[0][change] = "" if change == "owner" else "wrong"
    with pytest.raises(ValueError, match="dictionary credit"):
        write_pack(tmp_path / "pack.sqlite", rows, grading=payload, grading_credits=credits)
    assert not list(tmp_path.iterdir())


@pytest.mark.parametrize("change", ["missing", "extra", "identity", "item"])
def test_INV_PACK_35_refuses_runtime_rows_from_a_different_population(tmp_path, change):
    rows, payload, credits = population()
    if change == "missing":
        payload = replace(payload, runtime_items=())
    elif change == "extra":
        payload = replace(payload, runtime_items=(*payload.runtime_items, payload.runtime_items[0]))
    elif change == "identity":
        rows["meta"][0]["value"] = "another-pack"
    else:
        rows["exercise"][0]["item_id"] = "different-item"
    with pytest.raises(ValueError, match="grading"):
        write_pack(tmp_path / "pack.sqlite", rows, grading=payload, grading_credits=credits)
    assert not list(tmp_path.iterdir())


def test_INV_PACK_35_changed_dictionary_at_final_stream_preserves_the_existing_pack(tmp_path):
    rows, payload, credits = population()
    destination = tmp_path / "pack.sqlite"
    destination.write_bytes(b"previous immutable pack")
    dictionary = payload._dictionaries[0]
    dictionary.surfaces = lambda: iter(("cantar", "contar", "wrong"))
    with pytest.raises(ValueError, match="dictionary count/content hash"):
        write_pack(destination, rows, grading=payload, grading_credits=credits)
    assert destination.read_bytes() == b"previous immutable pack"
    assert list(tmp_path.iterdir()) == [destination]


def test_INV_PACK_35_declared_grading_without_payload_refuses_a_partial_pack(tmp_path):
    rows, payload, _ = population()
    rows["meta"].append({"key": "grading:v1", "value": json.dumps(payload.metadata)})
    with pytest.raises(ValueError, match="grading"):
        write_pack(tmp_path / "pack.sqlite", rows)
    assert not list(tmp_path.iterdir())


def test_INV_PACK_35_rejects_unconsumed_table_rows_instead_of_silently_dropping_them(tmp_path):
    rows, _, _ = population()
    rows["unexpected"] = [{"data": "must not disappear"}]
    with pytest.raises(ValueError, match="unknown pack table"):
        write_pack(tmp_path / "pack.sqlite", rows)
    assert not list(tmp_path.iterdir())


@pytest.mark.parametrize(
    "field,value",
    [
        ("prompt", "Translate this sentence\nI want to count."),
        ("accepted_answers_json", json.dumps(["Quiero contar."])),
        ("type", "reverse_translate"),
        ("preferred_surface", "Quiero contar."),
    ],
)
def test_INV_PACK_35_same_id_sql_content_mutation_must_not_publish_stale_runtime(
    tmp_path, field, value
):
    rows, payload, credits = population()
    destination = tmp_path / "published.sqlite"
    destination.write_bytes(b"previous published pack")
    rows["exercise"][0][field] = value
    with pytest.raises(ValueError, match="grading"):
        write_pack(destination, rows, grading=payload, grading_credits=credits)
    assert destination.read_bytes() == b"previous published pack"


def test_INV_PACK_17_changed_stream_source_provenance_must_not_publish_original_credit(tmp_path):
    rows, payload, credits = population()
    dictionary = payload._dictionaries[0]
    changed_raw = b"cantar\r\ncontar\r\nquiero\r\n"
    dictionary.source_chunks = lambda: iter((changed_raw,))
    dictionary.provenance = {
        **dictionary.provenance,
        "sourceSha256": hashlib.sha256(changed_raw).hexdigest(),
        "sourceId": "different-origin",
        "sourceUrl": "https://different.example.test/dictionary",
        "license": "CC-BY-4.0",
    }
    with pytest.raises(ValueError, match="grading|dictionary"):
        write_pack(tmp_path / "pack.sqlite", rows, grading=payload, grading_credits=credits)


def test_INV_PACK_35_late_generator_exception_keeps_existing_file_and_removes_partial(tmp_path):
    rows, payload, credits = population()

    def late():
        yield "cantar"
        yield "contar"
        raise RuntimeError("late source read error")

    payload._dictionaries[0].surfaces = late
    destination = tmp_path / "published.sqlite"
    destination.write_bytes(b"previous published pack")
    with pytest.raises(RuntimeError, match="late source read"):
        write_pack(destination, rows, grading=payload, grading_credits=credits)
    assert destination.read_bytes() == b"previous published pack"
    assert list(tmp_path.iterdir()) == [destination]


def test_INV_PACK_35_complete_stream_and_real_payload_control(tmp_path):
    rows, payload, credits = population()
    path = write_pack(tmp_path / "pack.sqlite", rows, grading=payload, grading_credits=credits)
    with sqlite3.connect(path) as db:
        assert db.execute("select count(*) from grading_word").fetchone()[0] == 3
        assert db.execute("select count(*) from exercise_runtime").fetchone()[0] == 1


@pytest.mark.parametrize(
    "fault",
    ["absent-digest", "absent-tags", "changed-reference", "changed-kind", "changed-new-flag"],
)
def test_INV_SCH_11_post_insert_objective_tags_must_match_producer_evidence(tmp_path, fault):
    rows, payload, credits = population()
    destination = tmp_path / "pack.sqlite"
    destination.write_bytes(b"existing immutable pack")
    if fault == "absent-digest":
        payload = replace(
            payload,
            provenance={k: v for k, v in payload.provenance.items() if k != "exerciseTagsSha256"},
        )
    if fault == "absent-tags":
        rows["exercise_item_tag"] = []
    if fault == "changed-reference":
        rows["exercise_item_tag"][0]["item_ref"] = "other"
    if fault == "changed-kind":
        rows["exercise_item_tag"][0]["item_kind"] = "grammar_concept"
    if fault == "changed-new-flag":
        rows["exercise_item_tag"][0]["is_new"] = 0
    with pytest.raises(ValueError, match="objective tags"):
        write_pack(destination, rows, grading=payload, grading_credits=credits)
    assert destination.read_bytes() == b"existing immutable pack"
    assert list(tmp_path.iterdir()) == [destination]


@pytest.mark.parametrize(
    "fault", ["unit-grammar", "lexeme-pos", "lexeme-lemma", "absent-definition-proof"]
)
def test_INV_SCH_11_actual_objective_definitions_cannot_change_after_assembly(tmp_path, fault):
    from test_grading_payload import digest, reviewed

    inputs = fixture()
    if fault == "unit-grammar":
        inputs.drafts[0]["lexicalBindings"] = []
        inputs.drafts[0]["schedulerObjective"] = reviewed(
            {
                "exerciseId": "ex1",
                "sourceId": "s1",
                "sourceSha256": digest(inputs.sources["s1"]),
                "kind": "grammarConcept",
                "itemRef": "g1",
            }
        )
        inputs.exercise_tags.append(
            {"exercise_id": "ex1", "item_kind": "grammar_concept", "item_ref": "g1", "is_new": 1}
        )
    rows, payload, credits = population(inputs)
    if fault == "absent-definition-proof":
        payload = replace(
            payload,
            provenance={
                k: v for k, v in payload.provenance.items() if k != "objectiveDefinitionsSha256"
            },
        )
    if fault == "unit-grammar":
        inputs.drafts[0]["lexicalBindings"] = []
        rows["grammar_concept"].append(
            {**rows["grammar_concept"][0], "concept_id": "g2", "name": "Other"}
        )
        rows["unit"][0]["grammar_concept"] = "g2"
    if fault == "lexeme-pos":
        rows["lexeme"][0]["pos"] = "NOUN"
    if fault == "lexeme-lemma":
        rows["lexeme"][0]["lemma"] = "other"
    destination = tmp_path / "pack.sqlite"
    destination.write_bytes(b"existing immutable pack")
    with pytest.raises(ValueError, match="objective definitions"):
        write_pack(destination, rows, grading=payload, grading_credits=credits)
    assert destination.read_bytes() == b"existing immutable pack"
    assert list(tmp_path.iterdir()) == [destination]
