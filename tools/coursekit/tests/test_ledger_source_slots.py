"""[INV-PACK-06] exact G5 joins and V9's selected-sentence denominator."""

from __future__ import annotations

from copy import deepcopy

import pytest

from coursekit.artifacts import ARTIFACT_SCHEMA_VERSION, validate_record
from coursekit.validators.ledger import build_ledger, check_v4, check_v9

pytestmark = pytest.mark.parametrize("invariant", ["INV-PACK-06"])


def unit(index=1, targets=("gato",)):
    return {"unit_index": index, "target_lemmas": list(targets), "grammar_concept": "being"}


def selected(index=1, lesson=1, slot=0, sid=None):
    return {
        "unit_index": index,
        "lesson_index": lesson,
        "slot_index": slot,
        "sentence_id": sid,
        "gap": sid is None,
    }


def exercise(sid, index=1, lesson=1, eid="a" * 16, tags=("gato",)):
    return {
        "unit_index": index,
        "lesson_index": lesson,
        "exercise_id": eid,
        "source_sentence_id": sid,
        "item_tags": {"lemmas": list(tags), "grammar_concepts": ["being"]},
    }


def candidate(cid="1" * 16, index=1, lesson=1, slot=0, text="Gato", lemma="gato"):
    row = {
        "schema_version": ARTIFACT_SCHEMA_VERSION,
        "lang": "es",
        "candidate_id": cid,
        "unit_index": index,
        "lesson_index": lesson,
        "slot_index": slot,
        "text": text,
        "translation": "Cat",
        "accepted_alternates": [],
        "author": "test",
        "generated_at": "2026-09-13",
        "accepted": True,
        "reject_reason": None,
        "provenance": "llm",
        "analysis": {
            "analyser": {
                "name": "spacy",
                "version": "3.8.7",
                "model": "es_core_news_md-3.8.0",
                "split_mode": None,
            },
            "tokens": [
                {
                    "surface": text,
                    "lemma": lemma,
                    "pos": "NOUN",
                    "morph": "Number=Sing",
                    "start": 0,
                    "end": len(text),
                }
            ],
            "lemmas": [lemma],
            "display_tokens": [text],
        },
    }
    validate_record("candidate", row)
    return row


def joined(candidates, *, exercises=None, selected_rows=None, targets=("gato",)):
    return build_ledger(
        "es",
        [unit(targets=targets)],
        exercises if exercises is not None else [exercise("1" * 16)],
        selected=selected_rows if selected_rows is not None else [selected()],
        candidates=candidates,
    )


def test_chosen_authored_analysis_is_independent_and_resolves_gap(invariant):
    ledger = joined([candidate()])
    assert ledger.gaps == {1: 0}
    assert ledger.content_forms(exercise("1" * 16)) == frozenset({("gato", "Number=Sing")})
    assert check_v4(ledger) == []
    corrupted = joined([candidate()], exercises=[exercise("1" * 16, tags=("perro",))])
    assert any(
        "tagged with perro" in f.message and f.severity == "blocking" for f in check_v4(corrupted)
    )


def test_resolving_gap_exposes_missing_promised_target(invariant):
    unresolved = joined([], targets=("gato", "perro"))
    resolved = joined([candidate()], targets=("gato", "perro"))
    assert any(
        f.severity == "warning" and f.detail.get("missing") == ["perro"]
        for f in check_v4(unresolved)
    )
    assert any(
        f.severity == "blocking" and f.detail.get("missing") == ["perro"]
        for f in check_v4(resolved)
    )


@pytest.mark.parametrize(
    "defect",
    [
        "reserve",
        "rejected",
        "unselected",
        "other_lesson",
        "other_unit",
        "no_analysis",
        "wrong_analysis",
    ],
)
def test_only_exact_selected_survivor_can_supply_authored_evidence(invariant, defect):
    first = candidate()
    rows = [first]
    if defect == "reserve":
        rows = [candidate(cid="2" * 16), first]
    elif defect == "rejected":
        first.update(accepted=False, reject_reason="stale_ledger")
    elif defect == "unselected":
        first["slot_index"] = 8
    elif defect == "other_lesson":
        first["lesson_index"] = 2
    elif defect == "other_unit":
        first["unit_index"] = 2
    elif defect == "no_analysis":
        first["analysis"] = None
    elif defect == "wrong_analysis":
        first["text"] = "Perro"
    ledger = joined(rows)
    assert any(f.severity == "blocking" and f.subject == "a" * 16 for f in check_v4(ledger))


def test_authored_evidence_cannot_be_reused_in_another_lesson(invariant):
    ledger = joined([candidate()], exercises=[exercise("1" * 16, lesson=2)])
    assert any(f.severity == "blocking" and f.subject == "a" * 16 for f in check_v4(ledger))


def test_v9_counts_selected_slots_not_format_siblings(invariant):
    ledger = joined(
        [candidate()], exercises=[exercise("1" * 16, eid=f"{i:016x}") for i in range(12)]
    )
    assert check_v9(ledger) == []


def test_v9_separate_slots_same_text_remain_duplicate_with_different_ids(invariant):
    ledger = joined(
        [candidate(), candidate(cid="2" * 16, lesson=2)],
        selected_rows=[selected(), selected(lesson=2)],
        exercises=[exercise("1" * 16), exercise("2" * 16, lesson=2, eid="b" * 16)],
    )
    assert any(f.severity == "blocking" and "inside unit 1" in f.message for f in check_v9(ledger))


def repeat_course(*, extra_formats=0, unresolved=0):
    rows = [candidate(cid=f"{i:016x}", slot=i, text=f"Gato {i}") for i in range(20)]
    slots = [selected(slot=i) for i in range(20)]
    exs = [exercise(r["candidate_id"], eid=f"{i:016x}") for i, r in enumerate(rows)]
    # Two reuses among 22 actual selected sentence uses, beyond the existing 5% ceiling.
    for i in range(2):
        row = candidate(cid=f"{100 + i:016x}", index=2, lesson=2, slot=i, text=f"Gato {i}")
        rows.append(row)
        slots.append(selected(index=2, lesson=2, slot=i))
        exs.append(exercise(row["candidate_id"], index=2, lesson=2, eid=f"{100 + i:016x}"))
    exs += [dict(exs[0], exercise_id=f"{200 + i:016x}") for i in range(extra_formats)]
    slots += [selected(slot=100 + i) for i in range(unresolved)]
    return build_ledger("es", [unit(), unit(2)], exs, selected=slots, candidates=rows)


def test_v9_cross_unit_hashes_all_origins_and_keeps_denominator(invariant):
    base = check_v9(repeat_course())
    extra = check_v9(repeat_course(extra_formats=100, unresolved=100))
    assert len(base) == len(extra) == 1
    assert base[0].detail == extra[0].detail == {"repeats": 2, "sourced": 22}
    assert base[0].severity == "blocking"


def test_corpus_and_authored_same_text_share_repeat_identity(invariant):
    authored = candidate(index=2, lesson=2)
    analysis = deepcopy(authored["analysis"])
    analysis["sentence_id"] = "c" * 16
    analysis["adapter"] = analysis.pop("analyser")
    ledger = build_ledger(
        "es",
        [unit(), unit(2)],
        [exercise("c" * 16), exercise("1" * 16, index=2, lesson=2)],
        analysed=[analysis],
        ingested=[{"sentence_id": "c" * 16, "text": "Gato"}],
        selected=[selected(sid="c" * 16), selected(index=2, lesson=2)],
        candidates=[authored],
    )
    assert any(f.detail == {"repeats": 1, "sourced": 2} for f in check_v9(ledger))


def test_redundant_lemma_list_cannot_invent_coverage(invariant):
    row = candidate()
    row["analysis"]["lemmas"].append("perro")
    ledger = joined(
        [row], targets=("gato", "perro"), exercises=[exercise("1" * 16, tags=("gato", "perro"))]
    )
    assert any(f.severity == "blocking" and "perro" in f.message for f in check_v4(ledger))


def test_corpus_source_requires_a_selected_unit_lesson_context(invariant):
    analysis = deepcopy(candidate()["analysis"])
    analysis["sentence_id"] = "c" * 16
    analysis["adapter"] = analysis.pop("analyser")
    ledger = build_ledger(
        "es",
        [unit()],
        [exercise("c" * 16, lesson=2)],
        analysed=[analysis],
        selected=[selected(sid="c" * 16)],
    )
    assert any(f.severity == "blocking" and f.subject == "a" * 16 for f in check_v4(ledger))


def test_explicit_empty_selection_cannot_claim_sourced_exercises(invariant):
    analysis = deepcopy(candidate()["analysis"])
    analysis["sentence_id"] = "c" * 16
    analysis["adapter"] = analysis.pop("analyser")
    ledger = build_ledger("es", [unit()], [exercise("c" * 16)], analysed=[analysis], selected=[])
    assert any(f.severity == "blocking" and f.subject == "a" * 16 for f in check_v4(ledger))
