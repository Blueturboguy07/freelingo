"""Review-free candidate boundaries; independent synthetic source facts."""

import importlib.util
from pathlib import Path

import pytest

# This leaf intentionally imports the separately frozen production compiler, not
# a fixture implementation. P6 alone predates that dependency; the documented
# explicit compiler PYTHONPATH executes every test. Integrated trees have it here.
pytest.importorskip("coursekit.packbuild.grading", reason="requires frozen P7 grading compiler")

MODULE = Path(__file__).parents[1] / "src" / "coursekit_es_u1_authoring.py"
spec = importlib.util.spec_from_file_location("es_u1_authoring", MODULE)
u1 = importlib.util.module_from_spec(spec)
spec.loader.exec_module(u1)


def witness():
    source = {
        "lang": "es",
        "unit_index": 1,
        "lesson_index": 1,
        "text": "La casa.",
        "translation": "The house.",
        "analysis": {
            "tokens": [{"lemma": "casa", "pos": "NOUN", "surface": "casa", "start": 3, "end": 7}]
        },
    }
    record = {
        "exercise_id": "ex1",
        "unit_index": 1,
        "lesson_index": 1,
        "type": "translate",
        "prompt": "Translate this sentence\nThe house.",
        "accepted_answers": ["La casa."],
        "source_sentence_id": "s1",
        "distractors": [],
    }
    sql = {
        "exercise_id": "ex1",
        "item_id": "i_source",
        "unit_id": "u001",
        "lesson_index": 1,
        "type": "translate",
        "prompt": record["prompt"],
        "accepted_answers_json": '["La casa."]',
        "distractors_json": "[]",
        "audio_id": None,
        "source_sentence_id": "s1",
    }
    f = {
        "source": source,
        "record": record,
        "exercise": sql,
        "unit": {"unit_id": "u001", "unit_index": 1, "grammar_concept": "gc:test"},
        "tags": [{"exercise_id": "ex1", "item_kind": "lexeme", "item_ref": "casa", "is_new": 1}],
        "lexemes": [{"lexeme_id": "lx:casa:NOUN", "lemma": "casa", "pos": "NOUN"}],
    }
    a = {
        "exerciseId": "ex1",
        "shapeId": "typed_translate_forward",
        "instruction": "Translate this sentence",
        "prompt": "The house.",
        "promptLanguage": "en",
        "answers": [{"surface": "La casa.", "rank": 0}],
        "objective": {"kind": "lexeme", "itemRef": "lx:casa:NOUN"},
        "explanation": "Casa is the feminine noun for house; la is its definite article.",
        "notes": [],
        "introduction": "wrong-feedback",
    }
    c = u1.make_candidate(a, f, author="Original author")
    return c, f


def test_review_free_source_join():
    c, f = witness()
    report = u1.check_candidate(c, f)
    assert report["structuralErrors"] == []
    assert report["sourceAmendments"] == []
    assert report["assemblyReady"] is False
    assert "independent-reviews-missing" in report["pending"]
    assert not u1.has_review_or_approval(c)


@pytest.mark.parametrize(
    "mutate",
    [
        lambda c, f: c["draft"].__setitem__("sourceSha256", "0" * 64),
        lambda c, f: f["exercise"].__setitem__("unit_id", "u002"),
        lambda c, f: c["draft"]["presentation"].__setitem__("prompt", "Some other source"),
        lambda c, f: c["draft"]["schedulerObjective"].__setitem__("itemRef", "lx:unknown:NOUN"),
        lambda c, f: f["source"]["analysis"]["tokens"][0].__setitem__("pos", "VERB"),
        lambda c, f: c["draft"]["schedulerSurfaces"][0].__setitem__("surfaceId", "sf_unknown"),
        lambda c, f: c.__setitem__("introduction", "prompt"),
        lambda c, f: c["draft"]["presentation"].__setitem__("bank", [{"id": "x", "text": "casa"}]),
        lambda c, f: c["draft"].__setitem__("approvalId", "fabricated"),
        lambda c, f: c["draft"]["explanation"].__setitem__("review", {"verdict": "accepted"}),
    ],
)
def test_unapproved_candidate_refuses_stale_or_promoted_claims(mutate):
    c, f = witness()
    mutate(c, f)
    assert u1.check_candidate(c, f)["structuralErrors"]


def test_added_legitimate_answer_remains_named_source_amendment():
    c, f = witness()
    c["proposedAnswers"].append({"surface": "La vivienda.", "rank": 1})
    c["draft"]["presentation"]["acceptedAnswers"].append("La vivienda.")
    from coursekit.packbuild.grading import surface_id

    sfid = surface_id("es", "La vivienda.")
    c["draft"]["surfaceIds"].append(sfid)
    c["draft"]["schedulerSurfaces"].append(
        {"itemId": "i_source", "surfaceId": sfid, "canonical": False}
    )
    report = u1.check_candidate(c, f)
    assert report["sourceAmendments"] == ["accepted-answer-set-differs-from-frozen-G7"]
    assert report["assemblyReady"] is False
    assert c["draft"]["record"]["accepted_answers"] == ["La casa."]


def test_full_fact_digest_catches_post_export_tag_change(tmp_path):
    path = tmp_path / "facts.json"
    path.write_text('{"tags":["casa"]}')
    proof = u1.file_proof(path)
    path.write_text('{"tags":["otro"]}')
    with pytest.raises(ValueError, match="source file hash mismatch"):
        u1.verify_file(path, proof)


def test_duplicate_explicit_answer_rank_is_rejected():
    c, f = witness()
    c["proposedAnswers"].append({"surface": "Otra casa.", "rank": 0})
    assert u1.check_candidate(c, f)["structuralErrors"]


def test_actual_production_builder_refuses_absent_language_validator():
    c, f = witness()
    result = u1.production_refusal([c], {"exercises": {"ex1": f}}, [])
    assert result == {
        "assemblyReady": False,
        "error": "approval validator is required",
        "stage": "build_grading_payload",
    }
