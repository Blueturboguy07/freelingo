"""Actual author revision falsifiers; no approved production fixtures."""

import copy
import importlib.util
import json
from pathlib import Path

import pytest

pytest.importorskip(
    "coursekit.packbuild.grading", reason="requires frozen real production compiler"
)
MODULE = Path(__file__).parents[1] / "src/coursekit_es_u1_revision.py"
spec = importlib.util.spec_from_file_location("es_u1_revision", MODULE)
r = importlib.util.module_from_spec(spec)
spec.loader.exec_module(r)
ROOT = Path(__file__).parents[3] / "content/es/grading/first-unit-20260913-revision-2"
BASE = ROOT.parent / "first-unit-20260913"


def authored():
    return json.loads((ROOT / "authoring.json").read_text())


def original():
    return [json.loads(x) for x in (BASE / "bundle/candidates.jsonl").read_text().splitlines()]


def test_INV_PACK_41_revision_keeps_frozen_parent_and_binds_all_eight_replacements():
    a = authored()
    b = original()
    out = r.validate_authoring(a, b)
    assert len(out) == 8
    assert set(out) == {x["originalExerciseId"] for x in a["revisions"]}
    assert a["baseCandidatesSha256"] == r.file_hash(BASE / "bundle/candidates.jsonl")
    assert b[0]["draft"]["presentation"]["prompt"] == "Hello, good night."
    assert a["revisions"][0]["translation"] == "Hello, good evening."


@pytest.mark.parametrize(
    "change",
    [
        lambda a: a["revisions"][0].__setitem__("originalCandidateSha256", "0" * 64),
        lambda a: a["revisions"][0].__setitem__("review", {"verdict": "accepted"}),
        lambda a: a["revisions"][0]["answers"].append(
            {"surface": a["revisions"][0]["answers"][0]["surface"], "rank": 1}
        ),
        lambda a: a["revisions"][0]["answers"][0].__setitem__("rank", 3),
        lambda a: a["revisions"].append(copy.deepcopy(a["revisions"][0])),
        lambda a: a["firstSession"].__setitem__("productionAllowed", True),
        lambda a: a["introductions"][0].__setitem__("shapeId", "typed_translate_forward"),
    ],
)
def test_INV_PACK_41_INV_SCH_10_stale_selfapproved_or_production_intro_rejected(change):
    a = authored()
    change(a)
    with pytest.raises(ValueError):
        r.validate_authoring(a, original())


def test_INV_SCH_11_recognition_is_exact_correct_visible_option_not_wrong_feedback():
    intro = authored()["pictureAlternatives"][0]
    payload = r.picture_presentation(
        intro,
        "i_test",
        {
            "hola": {"uri": "images/hello.png", "description": "Person waving hello"},
            "día": {"uri": "images/day.png", "description": "Daylight"},
            "noche": {"uri": "images/night.png", "description": "Night sky"},
        },
    )
    assert payload["type"] == "pictureSelect" and payload["introduction"] == "word"
    assert payload["promptLanguage"] == "en" and payload["language"] == "es"
    assert payload["acceptedAnswers"] == ["hola"]
    assert len(payload["options"]) == 3
    assert (
        next(x for x in payload["options"] if x["id"] == intro["correctOptionId"])["text"] == "hola"
    )
    assert all(x["imageUri"] and x["imageDescription"] for x in payload["options"])


@pytest.mark.parametrize(
    "change",
    [
        lambda a: a["introductions"][0].__setitem__("correctOptionId", "option-night"),
        lambda a: a["introductions"][0].__setitem__("optionOrder", ["hello", "hello", "night"]),
        lambda a: a["introductions"][0].__setitem__("accepted", "adiós"),
        lambda a: a["firstSession"].__setitem__("orderedLexemeIds", ["lx:noche:NOUN"]),
    ],
)
def test_INV_SCH_11_wrong_missing_or_duplicate_target_option_refuses(change):
    a = authored()
    change(a)
    with pytest.raises(ValueError):
        r.validate_authoring(a, original())


def test_INV_PACK_07_picture_uses_real_shape_predicate_and_requires_all_image_assets():
    intro = authored()["pictureAlternatives"][0]
    with pytest.raises(ValueError, match="image"):
        r.picture_presentation(
            intro, "i_test", {"hola": {"uri": "images/hello.png", "description": "Hello"}}
        )


def test_INV_SCH_10_first_session_contains_no_typed_production():
    a = authored()
    assert [x["lemma"] for x in a["introductions"]] == ["hola", "día", "noche"]
    assert all(x["shapeId"] == "meaning_select" for x in a["introductions"])
    # Intended typing fixes retain the unit allowance by changing the actual task,
    # never silently accepting an unvalidated outside-ledger Spanish form.
    byid = {x["originalExerciseId"]: x for x in a["revisions"]}
    assert byid["8844061cfdcc221d"]["shapeId"] == "typed_translate_reverse"
    assert byid["464154843186dcc4"]["shapeId"] == "typed_translate_reverse"
    assert "Good. And you?" in [x["surface"] for x in byid["27adb987c8bb5e3d"]["answers"]]


def test_INV_SCH_11_active_first_session_introduces_full_visible_spanish_prompt_without_assets():
    intro = authored()["introductions"][0]
    p = r.meaning_presentation(intro, "i_meaning")
    assert p["type"] == "meaningSelect" and p["introduction"] == "word"
    assert p["prompt"] == "hola" and p["promptLanguage"] == "es"
    assert p["language"] == "en" and p["acceptedAnswers"] == ["hello", "hi"]
    assert [x["text"] for x in p["options"]] == ["hello", "day", "night"]
    assert all("imageUri" not in x for x in p["options"])
    assert next(x for x in p["options"] if x["id"] == intro["correctOptionId"])["text"] == "hello"


def test_INV_PACK_41_new_source_objective_changes_need_explicit_bound_rationale():
    a = authored()
    row = a["revisions"][1]
    row["objective"] = {"kind": "lexeme", "itemRef": "lx:noche:NOUN"}
    row["objectiveChange"] = {
        "from": {"kind": "lexeme", "itemRef": "lx:sí:INTJ"},
        "reason": "New farewell has no sí; noche is present in actual G1 and G2.",
    }
    assert (
        r.validate_authoring(a, original())[row["originalExerciseId"]]["objective"]["itemRef"]
        == "lx:noche:NOUN"
    )
    row["objectiveChange"]["from"]["itemRef"] = "lx:favor:NOUN"
    with pytest.raises(ValueError, match="objective"):
        r.validate_authoring(a, original())


def test_INV_PACK_07_local_analysis_requires_complete_current_population():
    a = authored()
    _, _, facts, selected, _, _, _ = r.source_inputs(ROOT)
    proof = json.loads((ROOT / "inputs/local-analysis.json").read_text())
    proof["authoringSha256"] = r.file_hash(ROOT / "authoring.json")
    proof["driverSha256"] = r.file_hash(MODULE)
    # Empty all() cannot stand in for any actual current source checks.
    proof["checks"] = []
    with pytest.raises(ValueError, match="population"):
        r.validate_local_analysis(a, proof, facts, selected, ROOT)


@pytest.mark.parametrize("failure", ["identity", "span", "slot", "reject", "driver"])
def test_INV_PACK_08_local_source_proofs_cannot_drift(failure):
    a, _, facts, selected, _, _, _ = r.source_inputs(ROOT)
    proof = json.loads((ROOT / "inputs/local-analysis.json").read_text())
    check = proof["checks"][0]
    analysis = proof["analyses"][check["text"]]["analysis"]
    if failure == "identity":
        analysis["sentence_id"] = "0" * 16
        check["analysisSha256"] = r.digest(analysis)
    elif failure == "span":
        analysis["tokens"][0]["surface"] = "invented"
        check["analysisSha256"] = r.digest(analysis)
    elif failure == "slot":
        check["slot"]["slot_index"] += 1
    elif failure == "reject":
        check["axisReject"] = "known_lemma_violation"
    else:
        proof["driverSha256"] = "0" * 64
    with pytest.raises(ValueError):
        r.validate_local_analysis(a, proof, facts, selected, ROOT)


def test_INV_PACK_41_INV_SCH_11_actual_export_replays_exact_first_exposures(tmp_path):
    out = tmp_path / "replay"
    checks = r.export(ROOT, out)
    assert checks["candidateCount"] == checks["realProductionShapeChecks"] == 11
    assert checks["actualLocalAxisChecks"] == 13
    assert checks["G6Approval"] is checks["assemblyReady"] is False
    for path in out.iterdir():
        assert path.read_bytes() == (ROOT / "bundle" / path.name).read_bytes()
    candidates = r.rows(out / "candidates.jsonl")
    by_id = {c["draft"]["record"]["exercise_id"]: c for c in candidates}
    surfaces = {s["surfaceId"]: s for s in r.rows(out / "surface-catalog.jsonl")}
    sources = r.load(out / "sources.json")
    first = r.load(out / "first-session.json")
    assert len(first["exerciseIds"]) == 3
    for index, eid in enumerate(first["exerciseIds"]):
        d = by_id[eid]["draft"]
        p = d["presentation"]
        assert p["type"] == "meaningSelect" and p["introduction"] == "word"
        assert p["promptLanguage"] == "es" and p["language"] == "en"
        assert not any("imageUri" in o for o in p["options"])
        assert by_id[eid]["proposedExercise"]["slot_index"] == index
        assert d["profileId"] == "en-recognition-v1"
        assert len(d["schedulerSurfaces"]) == len(d["lexicalBindings"]) == 1
        target = d["schedulerSurfaces"][0]
        display = surfaces[target["surfaceId"]]
        assert display["language"] == "es" and display["surface"] == p["prompt"]
        assert display["introduction"] == {
            "exerciseId": eid,
            "unitId": "u001",
            "lessonIndex": 1,
            "when": "prompt",
        }
        assert d["sourceSha256"] == r.digest(sources[d["sourceId"]])
        assert target["canonical"] is True
        assert d["lexicalBindings"][0]["surfaceId"] == target["surfaceId"]
        assert "approvalId" not in d and "review" not in d["schedulerObjective"]
    old = r.load(BASE / "bundle/source-facts.json")["exercises"]
    for c in candidates[3:]:
        original = old[c["originalExerciseId"]]
        assert c["proposedExercise"]["slot_index"] == original["exercise"]["slot_index"]
        assert c["draft"]["record"]["source_sentence_id"] != original["sourceId"]
        assert c["draft"]["record"]["item_tags"]["grammar_concepts"] == []
    assert r.check(ROOT, out)["assemblyReady"] is False
