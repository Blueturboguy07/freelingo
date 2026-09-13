"""Bounded independent-review corrections and real source-bound starter assembly."""

import importlib.util
from pathlib import Path

import pytest

pytest.importorskip("coursekit.packbuild.grading")
MODULE = Path(__file__).parents[1] / "src/coursekit_es_u1_revision3.py"
spec = importlib.util.spec_from_file_location("es_u1_revision3", MODULE)
r = importlib.util.module_from_spec(spec)
spec.loader.exec_module(r)
ROOT = Path(__file__).parents[3] / "content/es/grading/first-unit-20260913-revision-3"
BASE = ROOT.parent / "first-unit-20260913-revision-2"


def test_INV_PACK_41_english_omissions_keep_source_and_canonical_identity():
    a = r.load(ROOT / "authoring.json")
    original = r.rows(BASE / "bundle/candidates.jsonl")
    r.validate_authoring(a, original)
    by = {x["exerciseId"]: x for x in a["englishRevisions"]}
    assert "I'm good. And you?" in [x["surface"] for x in by["16f59b19698b62a0"]["answers"]]
    assert "Well, thanks. And you?" in [x["surface"] for x in by["b03de7ed176e07a1"]["answers"]]
    assert "I'm fine, thanks. And you?" in [x["surface"] for x in by["b03de7ed176e07a1"]["answers"]]


@pytest.mark.parametrize(
    "mutation",
    [
        lambda a: a["englishRevisions"][0].__setitem__("candidateSha256", "0" * 64),
        lambda a: a["englishRevisions"][0]["answers"][0].__setitem__(
            "surface", "invented canonical"
        ),
        lambda a: a["recognitionAdditions"][0].__setitem__("review", {"verdict": "accepted"}),
        lambda a: a["firstSession"].__setitem__("productionAllowed", True),
        lambda a: a["firstSession"]["keepExerciseIds"].pop(),
        lambda a: a["recognitionAdditions"].pop(),
    ],
)
def test_INV_PACK_41_INV_SESS_26_stale_or_underfloor_authoring_rejected(mutation):
    a = r.load(ROOT / "authoring.json")
    mutation(a)
    with pytest.raises(ValueError):
        r.validate_authoring(a, r.rows(BASE / "bundle/candidates.jsonl"))


def test_INV_PACK_41_reused_source_requires_exact_frozen_source_hash():
    a = r.load(ROOT / "authoring.json")
    a["recognitionAdditions"][2]["existingSourceSha256"] = "0" * 64
    with pytest.raises(ValueError, match="reused source"):
        r.validate_authoring(a, r.rows(BASE / "bundle/candidates.jsonl"))


def test_INV_PACK_41_exact_export_preserves_nine_rows_and_both_canonical_identities(tmp_path):
    output = tmp_path / "replay"
    result = r.export(ROOT, output)
    assert result["realProductionShapeChecks"] == 14
    assert result["axisRejects"] == 0
    assert result["assemblyReady"] is False
    original = {
        x["draft"]["record"]["exercise_id"]: x for x in r.rows(BASE / "bundle/candidates.jsonl")
    }
    revised = {x["draft"]["record"]["exercise_id"]: x for x in r.rows(output / "candidates.jsonl")}
    for key, before in original.items():
        after = revised[key]
        if key not in r.CHANGED:
            assert after == before
        else:
            for field in ["sourceId", "sourceSha256", "schedulerSurfaces", "lexicalBindings"]:
                assert after["draft"][field] == before["draft"][field]
            assert (
                after["draft"]["presentation"]["itemId"]
                == before["draft"]["presentation"]["itemId"]
            )
            assert (
                after["draft"]["presentation"]["acceptedAnswers"][0]
                == before["draft"]["presentation"]["acceptedAnswers"][0]
            )
    old_sources = r.load(BASE / "bundle/sources.json")
    new_sources = r.load(output / "sources.json")
    assert len(new_sources) == len(old_sources) + 2
    assert {key: new_sources[key] for key in old_sources} == old_sources
    assert r.load(output / "manifest.json") == r.load(ROOT / "bundle/manifest.json")


def test_INV_SCH_11_real_prompt_introductions_bind_six_surfaces_and_five_words():
    first = r.load(ROOT / "bundle/first-session.json")
    candidates = {
        x["draft"]["record"]["exercise_id"]: x["draft"]
        for x in r.rows(ROOT / "bundle/candidates.jsonl")
    }
    surfaces = {x["surfaceId"]: x for x in r.rows(ROOT / "bundle/surface-catalog.jsonl")}
    assert len(first["exerciseIds"]) == 6
    words = set()
    for key in first["exerciseIds"]:
        d = candidates[key]
        assert d["shapeId"] == "meaning_select"
        assert d["presentation"]["promptLanguage"] == "es"
        assert d["presentation"]["introduction"] in {"word", "phrase"}
        target = surfaces[d["schedulerSurfaces"][0]["surfaceId"]]
        assert target["surface"] == d["presentation"]["prompt"]
        assert target["introduction"] == {
            "exerciseId": key,
            "unitId": "u001",
            "lessonIndex": 1,
            "when": "prompt",
        }
        assert d["sourceId"] in target["sourceIds"]
        words.add(d["lexicalBindings"][0]["wordItemId"])
    assert len(words) == first["distinctLexicalIdentities"] == 5


@pytest.mark.parametrize(
    "mutation",
    [
        lambda p: p.__setitem__("G6Approval", {"accepted": True}),
        lambda p: p["checks"].pop(),
        lambda p: p["checks"][0].__setitem__("axisReject", "outside current ledger"),
        lambda p: p["checks"][0].__setitem__("selectedSlotSha256", "0" * 64),
        lambda p: p["checks"][0]["analysis"]["tokens"][0].__setitem__("surface", "fake"),
    ],
)
def test_INV_PACK_41_source_proof_rejects_missing_stale_or_self_approved_analysis(mutation):
    author, _, selected, *_ = r.inputs(ROOT)
    proof = r.load(ROOT / "inputs/local-analysis.json")
    mutation(proof)
    with pytest.raises(ValueError):
        r.validate_analysis(author, proof, selected, ROOT)


def test_INV_PACK_41_actual_parser_refutation_is_preserved_and_source_reuse_is_exact():
    failed = r.load(ROOT / "verification/rejected-first-draft/local-analysis.json")
    phrase = failed["checks"][2]
    assert phrase["text"] == "Buenas noches."
    assert next(t["pos"] for t in phrase["analysis"]["tokens"] if t["lemma"] == "noche") == "PROPN"
    current = r.load(ROOT / "inputs/local-analysis.json")["checks"][2]
    assert current["sourceId"] == "34a30591894d99bc"
    assert next(t["pos"] for t in current["analysis"]["tokens"] if t["lemma"] == "noche") == "NOUN"
