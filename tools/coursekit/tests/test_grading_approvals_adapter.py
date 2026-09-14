"""Actual disk/runlog boundaries; fixture G6 engine checks are explicitly synthetic."""

import copy
import importlib.util
import json
import os
from pathlib import Path

import pytest

from coursekit.artifacts import write_records
from coursekit.runlog import RunLog, StageEntry

spec = importlib.util.spec_from_file_location(
    "grading_approvals_adapter",
    Path(
        os.environ.get(
            "COURSEKIT_GRADING_APPROVAL_MODULE",
            Path(__file__).parents[1] / "src/coursekit_grading_approvals.py",
        )
    ),
)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
ROOT = Path(__file__).parents[3] / "content/es/grading"


def rows(path):
    return [json.loads(line) for line in path.read_text().splitlines() if line]


def stage(name, *, status="ok", notes=None):
    entry = StageEntry(
        "es",
        name,
        str(int(name[1:]) + 1) * 32,
        "2026-09-14",
        "test-fixture",
        "1",
        "test-fixture",
        status=status,
        notes=notes or {},
    )
    RunLog("es").append(entry)
    return entry


@pytest.fixture
def lexical(tmp_path, monkeypatch):
    content = tmp_path / "content"
    monkeypatch.setenv("COURSEKIT_CONTENT_ROOT", str(content))
    p = content / "es/authoring/lexeme-glosses.jsonl"
    p.parent.mkdir(parents=True)
    prior = ROOT / "first-unit-20260913-revision-2/inputs"
    glosses = rows(prior / "glosses.jsonl") + rows(
        ROOT / "first-unit-20260913-revision-3/inputs/glosses.jsonl"
    )
    unique = {(x["lemma"], x["pos"]): x for x in glosses}
    p.write_text("".join(json.dumps(x, ensure_ascii=False) + "\n" for x in unique.values()))
    for name, file in [
        ("selected_item", "selected-u1.jsonl"),
        ("unit_assignment", "units-u1.jsonl"),
        ("banded_lemma", "banded-u1.jsonl"),
    ]:
        write_records(name, rows(prior / file), lang="es")
    for i in range(5):
        stage(f"g{i}")
    all_sources = json.loads(
        (ROOT / "first-unit-20260913-revision-3/bundle/sources.json").read_text()
    )
    source = all_sources["a9d5732aaaddb58c"]

    class RecordedAnalyser:
        def analyse(self, *, sentence_id, text):
            assert sentence_id == source["analysis"]["sentence_id"] and text == source["text"]
            return copy.deepcopy(source["analysis"])

    monkeypatch.setattr(module, "adapter_for", lambda lang: RecordedAnalyser())
    return source, p


@pytest.mark.parametrize("invariant", ["INV-PACK-08"])
def test_glossary_proof_is_current_exact_and_not_a_g6_claim(invariant, lexical):
    source, _ = lexical
    adapter = module.GradingApprovalAdapter("es")
    proof = adapter.project_lexical(source)
    assert proof["kind"] == "reviewed-glossary"
    assert proof["spanish"] == ["bueno"] and proof["english"] == ["good"]
    assert adapter(source, proof) is True
    assert proof["sourceSha256"] == module.evidence_digest(source)
    assert "G6Approval" not in proof


@pytest.mark.parametrize(
    "field",
    ["text", "translation", "lemma", "pos", "g2", "selectedSlot", "analysis", "reviewedGlossary"],
)
@pytest.mark.parametrize("invariant", ["INV-PACK-08"])
def test_INV_PACK_08_exact_lexical_join_rejects_mutated_source(invariant, lexical, field):
    source, _ = lexical
    adapter = module.GradingApprovalAdapter("es")
    proof = adapter.project_lexical(source)
    altered = copy.deepcopy(source)
    if field in {"text", "translation", "lemma", "pos"}:
        altered[field] = "otro"
    elif field == "g2":
        altered[field]["rank"] += 1
    elif field == "selectedSlot":
        altered[field]["known_lemmas"].append("otro")
    elif field == "analysis":
        altered[field]["tokens"][0]["morph"] = "Number=Plur"
    else:
        altered[field]["citation_gloss"] = "bad"
    assert adapter(altered, {**proof, "sourceSha256": module.evidence_digest(altered)}) is False


@pytest.mark.parametrize(
    "defect",
    [
        "pending",
        "self_review",
        "new_review",
        "g2_later",
        "g4_failed",
        "partial_grid",
        "missing_target",
        "extra_english",
        "extra_spanish",
        "forged_run",
        "extra_pairs",
    ],
)
@pytest.mark.parametrize("invariant", ["INV-PACK-41"])
def test_INV_PACK_41_current_evidence_cannot_be_replaced_by_old_projection(
    invariant, lexical, defect
):
    source, path = lexical
    adapter = module.GradingApprovalAdapter("es")
    proof = adapter.project_lexical(source)
    if defect in {"pending", "self_review", "new_review"}:
        data = rows(path)
        row = next(x for x in data if x["lemma"] == "bueno")
        if defect == "pending":
            row["review"] = None
        elif defect == "self_review":
            row["review"]["reviewer"] = row["author"]
        else:
            row["review"]["note"] += " changed"
        path.write_text("".join(json.dumps(x) + "\n" for x in data))
    elif defect == "g2_later":
        stage("g2")
    elif defect == "g4_failed":
        stage("g4", status="failed")
    elif defect in {"partial_grid", "missing_target"}:
        from coursekit.artifacts import read_records

        data = list(read_records("selected_item", lang="es"))
        if defect == "partial_grid":
            data.pop()
        else:
            data[1]["new_lemmas"] = []
        write_records("selected_item", data, lang="es")
    elif defect == "extra_english":
        proof["english"].append("bad")
    elif defect == "extra_spanish":
        proof["spanish"].append("malo")
    elif defect == "forged_run":
        proof["runId"] = "ok"
    else:
        proof["pairs"] = [{"left": "bueno", "right": "bad"}]
    assert adapter(source, proof) is False


@pytest.mark.parametrize("invariant", ["INV-PACK-08"])
def test_whole_sentence_author_review_cannot_replace_selected_source_and_g6(invariant, lexical):
    source, _ = lexical
    source = copy.deepcopy(source)
    source["sourceKind"] = "whole-sentence-authoring-revision"
    adapter = module.GradingApprovalAdapter("es")
    assert (
        adapter(
            source,
            {
                "sourceSha256": module.evidence_digest(source),
                "runId": "review-accepted",
                "spanish": [source["text"]],
                "english": [source["translation"]],
            },
        )
        is False
    )
    with pytest.raises(module.ApprovalAdapterError):
        adapter.selected_sources()


@pytest.fixture
def selected_population(lexical):
    from coursekit.answer_evidence import (
        answer_content_hash,
        build_answer_approval,
        load_answer_evidence,
        write_answer_approval,
    )
    from coursekit.selected_sources import resolve_selected_sources

    from coursekit.artifacts import read_records
    from coursekit.config.g5 import MAX_TOKENS
    from coursekit.ledger import count_units

    _, glossary_path = lexical
    old_units = list(read_records("unit_assignment", lang="es"))
    unit = {**old_units[0], "level_count": 1}
    banded = list(read_records("banded_lemma", lang="es"))
    words = [r["lemma"] for r in banded[:18]]
    selected, candidates = [], []
    for i, word in enumerate(words):
        sid = f"{i + 1:016x}"
        slot = {
            "schema_version": 1,
            "lang": "es",
            "unit_index": 1,
            "lesson_index": i // 9 + 1,
            "slot_index": i % 9,
            "sentence_id": None,
            "provenance": "llm",
            "gap": True,
            "new_lemmas": [],
            "known_lemmas": words,
            "grammar_concept": unit["grammar_concept"],
            "accepted_alternates": [],
        }
        selected.append(slot)
        text = word.capitalize()
        analysis = {
            "analyser": {"name": "fixture", "version": "1", "model": "fixture", "split_mode": None},
            "tokens": [
                {
                    "surface": text,
                    "lemma": word,
                    "pos": banded[i]["pos"],
                    "morph": "",
                    "start": 0,
                    "end": len(text),
                }
            ],
            "lemmas": [word],
            "display_tokens": [text],
        }
        candidates.append(
            {
                "schema_version": 1,
                "lang": "es",
                "candidate_id": sid,
                "unit_index": 1,
                "lesson_index": slot["lesson_index"],
                "slot_index": slot["slot_index"],
                "text": text,
                "translation": f"Fixture {i}",
                "accepted_alternates": [],
                "author": "test author",
                "generated_at": "2026-09-14",
                "accepted": True,
                "reject_reason": None,
                "provenance": "llm",
                "analysis": analysis,
            }
        )
    # Nominal fixture length policy: explicit G2 fixture POS removes verbs from the
    # permitted window. These are transport tests, never actual Spanish approvals.
    banded = [{**r, "pos": "NOUN"} for r in banded]
    for kind, data in [
        ("selected_item", selected),
        ("candidate", candidates),
        ("unit_assignment", [unit]),
        ("banded_lemma", banded),
        ("ingested_sentence", []),
        ("analysed_sentence", []),
    ]:
        write_records(kind, data, lang="es")
    stage("g5")
    sources = resolve_selected_sources("es", selected, candidates, [], [], [unit], banded)
    authored = []
    for s in sources:
        row = {
            "schema_version": 1,
            "source": s.snapshot(),
            "author": "test author",
            "licence": "CC-BY-NC-SA-4.0",
            "authored_on": "2026-09-14",
            "rationale": "Explicit test-only transport fixture.",
            "canonical_pair": {
                "score": 4,
                "register": "neutral",
                "judgement": "Test fixture only.",
            },
            "spanish": [],
            "english_reverse_only": [],
            "review": None,
        }
        row["review"] = {
            "reviewer": "separate test reviewer",
            "verdict": "accepted",
            "note": "Test fixture only.",
            "content_hash": answer_content_hash(row),
        }
        authored.append(row)
    evidence_path = glossary_path.with_name("answers.jsonl")
    evidence_path.write_text("".join(json.dumps(r) + "\n" for r in authored))
    evidence = load_answer_evidence("es", sources)

    def check(lang):
        return {
            "engine": "fixture",
            "language": lang,
            "requested": True,
            "available": True,
            "passed": True,
            "detail": {"reason": "explicit test-only transport fixture"},
        }

    proofs = {}
    for s in sources:
        h = evidence.rows[s.slot]["review"]["content_hash"]
        pair = {**check("es"), "detail": {"score": 4, "review_hash": h}}
        checks = {
            axis: check("es") for axis in ("ledger", "length", "duplicate", "register", "grammar")
        }
        checks["pair"] = pair
        checks["perplexity"] = {
            "engine": "none",
            "language": "es",
            "requested": False,
            "available": False,
            "passed": None,
            "detail": {"reason": "fixture"},
        }
        checks["length"]["detail"] = {
            "minimum": s.minimum_tokens,
            "maximum": MAX_TOKENS,
            "count": count_units(
                {"lang": "es", "tokens": s.analysis["tokens"], "adapter": s.analysis["analyser"]}
            ),
            "window_pos_digest": s.window_pos_digest,
        }
        proofs[s.slot] = [
            {"use": "forward", "text": s.text, "analysis": s.analysis, "checks": checks},
            {
                "use": "reverse_only",
                "text": s.translation,
                "analysis": None,
                "checks": {"pair": {**pair, "language": "en"}, "grammar": check("en")},
            },
        ]
    approval = build_answer_approval("es", sources, evidence, proofs, run_id="7" * 32)
    stage("g6", notes=write_answer_approval("es", approval))
    return sources


@pytest.mark.parametrize("invariant", ["INV-PACK-08"])
def test_actual_full_population_g6_loader_provides_exact_selected_projection(
    invariant, selected_population
):
    adapter = module.GradingApprovalAdapter("es")
    current = adapter.selected_sources()
    assert len(current) == 18
    entry = current[(1, 1, 0)]
    assert entry["sourceId"] == selected_population[0].source_id
    assert entry["approval"]["spanish"] == [selected_population[0].text]
    assert entry["approval"]["english"] == [selected_population[0].translation]
    assert adapter(entry["source"], entry["approval"])


@pytest.mark.parametrize(
    "defect",
    [
        "late_failed_g6",
        "late_g5",
        "partial_grid",
        "canonical_text",
        "analysis",
        "reserve_promoted",
        "extra_english",
        "run_id",
        "file_tamper",
        "source_author",
        "cross_slot",
    ],
)
@pytest.mark.parametrize("invariant", ["INV-PACK-41"])
def test_INV_PACK_41_whole_source_approval_fails_actual_disk_mutations(
    invariant, selected_population, defect
):
    from coursekit.config.answer_evidence import ANSWER_APPROVAL_PATH

    from coursekit.artifacts import read_records, run_dir

    adapter = module.GradingApprovalAdapter("es")
    entry = adapter.selected_sources()[(1, 1, 0)]
    if defect == "late_failed_g6":
        stage("g6", status="failed")
    elif defect == "late_g5":
        stage("g5")
    elif defect == "partial_grid":
        write_records(
            "selected_item", list(read_records("selected_item", lang="es"))[:-1], lang="es"
        )
    elif defect in {"canonical_text", "analysis", "reserve_promoted", "source_author"}:
        data = list(read_records("candidate", lang="es"))
        if defect == "canonical_text":
            data[0]["text"] += "!"
        elif defect == "analysis":
            data[0]["analysis"]["tokens"][0]["pos"] = "VERB"
        elif defect == "reserve_promoted":
            data[0]["candidate_id"] = "f" * 16
        else:
            data[0]["author"] = "different author"
        write_records("candidate", data, lang="es")
    elif defect == "extra_english":
        entry["approval"]["english"].append("unapproved")
    elif defect == "run_id":
        entry["approval"]["runId"] = "new-approved"
    elif defect == "cross_slot":
        entry["source"]["selectedSlot"]["slot_index"] = 1
    else:
        p = run_dir("es") / ANSWER_APPROVAL_PATH
        p.write_text(p.read_text() + " ")
    assert adapter(entry["source"], entry["approval"]) is False


@pytest.mark.parametrize("invariant", ["INV-GRD-03"])
def test_glossary_contextual_decoy_exclusions_are_not_accepted_answers(invariant, lexical):
    source, _ = lexical
    source.clear()
    source.update(
        json.loads((ROOT / "first-unit-20260913-revision-3/bundle/sources.json").read_text())[
            "3b526ef2dcd5d2ca"
        ]
    )
    proof = module.GradingApprovalAdapter("es").project_lexical(source)
    assert source["reviewedGlossary"]["valid_alternates"] == ["evening"]
    assert proof["english"] == ["night"]


@pytest.mark.parametrize("invariant", ["INV-PACK-41"])
def test_source_change_during_native_analysis_invalidates_projection(
    invariant, lexical, monkeypatch
):
    source, path = lexical

    class MutatingAnalyser:
        def analyse(self, **kwargs):
            data = rows(path)
            row = next(r for r in data if r["lemma"] == "bueno")
            row["review"]["note"] += " changed during actual analysis"
            path.write_text("".join(json.dumps(r) + "\n" for r in data))
            return copy.deepcopy(source["analysis"])

    monkeypatch.setattr(module, "adapter_for", lambda lang: MutatingAnalyser())
    with pytest.raises(module.ApprovalAdapterError, match="changed"):
        module.GradingApprovalAdapter("es").project_lexical(source)
