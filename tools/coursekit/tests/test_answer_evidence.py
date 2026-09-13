"""Review and G6 approval are distinct; neither can survive edited input facts."""

import json
from copy import deepcopy

import pytest
from test_selected_sources import source_fixture

from coursekit.answer_evidence import (
    AnswerEvidenceError,
    answer_content_hash,
    build_answer_approval,
    load_answer_evidence,
    load_validated_answer_evidence,
    write_answer_approval,
)
from coursekit.config.g5 import MAX_TOKENS
from coursekit.ledger import count_units
from coursekit.selected_sources import resolve_selected_sources

pytestmark = pytest.mark.parametrize("invariant", ["INV-GRD-03", "INV-PACK-08"])


def answer_sources(data=None):
    data = deepcopy(data if data is not None else source_fixture())
    corpus, analysis = data["ingested"][0], data["analysed"][0]
    item = data["selected"][0]
    item.update(sentence_id=None, gap=True, provenance="llm")
    data["candidates"] = [
        {
            "schema_version": corpus["schema_version"],
            "lang": "es",
            "candidate_id": "a" * 16,
            "unit_index": item["unit_index"],
            "lesson_index": item["lesson_index"],
            "slot_index": item["slot_index"],
            "text": corpus["text"],
            "translation": corpus["translation"],
            "accepted_alternates": item["accepted_alternates"],
            "author": "original author",
            "generated_at": "2026-09-13",
            "accepted": True,
            "reject_reason": None,
            "provenance": "llm",
            "analysis": {
                "analyser": analysis["adapter"],
                "tokens": analysis["tokens"],
                "lemmas": analysis["lemmas"],
                "display_tokens": analysis["display_tokens"],
            },
        }
    ]
    data["banded"] = [
        {"lemma": "gato", "pos": "NOUN"},
        {"lemma": "el", "pos": "DET"},
        {"lemma": "perro", "pos": "NOUN"},
    ]
    return resolve_selected_sources("es", **data)


def install_run(monkeypatch, entry):
    import coursekit.answer_evidence as module

    entries = [{"stage": f"g{i}", "status": "ok"} for i in range(6)] + [deepcopy(entry)]
    monkeypatch.setattr(module, "read_entries", lambda lang: iter(entries))


def reviewed_fixture(tmp_path):
    sources = answer_sources()
    row = {
        "schema_version": 1,
        "source": sources[0].snapshot(),
        "author": "author A",
        "licence": "CC-BY-NC-SA-4.0",
        "authored_on": "2026-09-13",
        "rationale": "Animal noun; canonical sentence pair and all listed variants reviewed.",
        "canonical_pair": {"score": 4, "register": "neutral", "judgement": "Same animal noun."},
        "spanish": [],
        "english_reverse_only": [
            {
                "text": "A cat",
                "pair": {
                    "score": 4,
                    "register": "neutral",
                    "judgement": "Natural nominal reading.",
                },
            }
        ],
        "review": None,
    }
    row["review"] = {
        "reviewer": "reviewer B",
        "verdict": "accepted",
        "note": "Independent pair and answer-set review.",
        "content_hash": answer_content_hash(row),
    }
    path = tmp_path / "answers.jsonl"
    path.write_text(json.dumps(row) + "\n")
    return sources, row, path


def rewrite(path, row, *, review_again=False):
    if review_again:
        row["review"]["content_hash"] = answer_content_hash(row)
    path.write_text(json.dumps(row) + "\n")


def check(lang, *, available=True):
    return {
        "engine": "fixture" if available else "none",
        "language": lang,
        "requested": available,
        "available": available,
        "passed": True if available else None,
        "detail": {"reason": "fixture"},
    }


def proofs(sources, evidence):
    row = evidence.rows[sources[0].slot]
    pair = check("es")
    pair["detail"] = {"score": 4, "review_hash": row["review"]["content_hash"]}
    spanish = {
        "use": "forward",
        "text": "Gato",
        "analysis": sources[0].analysis,
        "checks": {
            "ledger": check("es"),
            "length": {
                **check("es"),
                "detail": {
                    "minimum": sources[0].minimum_tokens,
                    "maximum": MAX_TOKENS,
                    "count": count_units(
                        {
                            "lang": "es",
                            "tokens": sources[0].analysis["tokens"],
                            "adapter": sources[0].analysis["analyser"],
                        }
                    ),
                    "window_pos_digest": sources[0].window_pos_digest,
                },
            },
            "duplicate": check("es"),
            "register": check("es"),
            "pair": pair,
            "grammar": check("es"),
            "perplexity": check("es", available=False),
        },
    }
    english = []
    for text in ("Cat", "A cat"):
        checked_pair = deepcopy(pair)
        checked_pair["language"] = "en"
        english.append(
            {
                "use": "reverse_only",
                "text": text,
                "analysis": None,
                "checks": {"pair": checked_pair, "grammar": check("en")},
            }
        )
    return {sources[0].slot: [spanish, *english]}


def test_reviewed_sets_include_explicit_empty_forward_answers(invariant, tmp_path, monkeypatch):
    sources, row, path = reviewed_fixture(tmp_path)
    evidence = load_answer_evidence("es", sources, path=path)
    assert evidence.rows[sources[0].slot]["spanish"] == []
    approved = build_answer_approval(
        "es", sources, evidence, proofs(sources, evidence), run_id="r1"
    )
    assert len(approved["occurrences"]) == 1
    notes = write_answer_approval("es", approved)
    entry = {"lang": "es", "stage": "g6", "status": "ok", "run_id": "r1", "notes": notes}
    install_run(monkeypatch, entry)
    loaded = load_validated_answer_evidence("es", sources, evidence=evidence, g6_entry=entry)
    answer = loaded[sources[0].slot]
    assert answer.spanish == ("Gato",)
    assert answer.english_reverse_only == ("Cat", "A cat")


@pytest.mark.parametrize(
    "defect",
    [
        "absent",
        "stale_pair",
        "stale_ledger",
        "self_review",
        "pending",
        "rejected",
        "modified_answer",
        "duplicate",
        "extra",
        "bad_score",
        "unknown_field",
        "missing_empty_set",
    ],
)
def test_author_evidence_must_join_every_selected_occurrence(invariant, tmp_path, defect):
    sources, row, path = reviewed_fixture(tmp_path)
    if defect == "absent":
        path.unlink()
    elif defect == "duplicate":
        path.write_text((json.dumps(row) + "\n") * 2)
    else:
        if defect == "stale_pair":
            row["source"]["translation"] = "Kitten"
        elif defect == "stale_ledger":
            row["source"]["known_lemmas"] = ["perro"]
        elif defect == "self_review":
            row["review"]["reviewer"] = "AUTHOR A"
        elif defect == "pending":
            row["review"] = None
        elif defect == "rejected":
            row["review"]["verdict"] = "rejected"
        elif defect == "modified_answer":
            row["english_reverse_only"][0]["text"] = "Dog"
        elif defect == "extra":
            row["source"]["slot_index"] = 1
        elif defect == "bad_score":
            row["canonical_pair"]["score"] = 2
        elif defect == "unknown_field":
            row["override"] = True
        else:
            del row["spanish"]
        rewrite(path, row)
    with pytest.raises(AnswerEvidenceError):
        load_answer_evidence("es", sources, path=path)


@pytest.mark.parametrize(
    "defect",
    [
        "failed_grammar",
        "missing_surface",
        "english_es_engine",
        "no_spanish_engine",
        "fake_pair",
        "stale_analysis",
        "requested_unavailable",
        "foreign_extra",
        "unseen_lemma",
    ],
)
def test_g6_cannot_approve_unchecked_or_wrong_language_surfaces(invariant, tmp_path, defect):
    sources, row, path = reviewed_fixture(tmp_path)
    evidence = load_answer_evidence("es", sources, path=path)
    checked = proofs(sources, evidence)
    values = checked[sources[0].slot]
    if defect == "failed_grammar":
        values[0]["checks"]["grammar"]["passed"] = False
    elif defect == "missing_surface":
        values.pop()
    elif defect == "english_es_engine":
        values[1]["checks"]["grammar"]["language"] = "es"
    elif defect == "no_spanish_engine":
        values[0]["checks"]["grammar"] = check("es", available=False)
    elif defect == "fake_pair":
        values[0]["checks"]["pair"]["detail"]["review_hash"] = "0" * 64
    elif defect == "stale_analysis":
        values[0]["analysis"] = deepcopy(values[0]["analysis"])
        values[0]["analysis"]["tokens"][0]["surface"] = "Perro"
    elif defect == "requested_unavailable":
        values[0]["checks"]["perplexity"]["requested"] = True
    elif defect == "foreign_extra":
        values.append({"use": "forward", "text": "A cat", "analysis": None, "checks": {}})
    else:
        values[0]["analysis"] = deepcopy(values[0]["analysis"])
        values[0]["analysis"]["tokens"][0]["lemma"] = "perro"
    with pytest.raises(AnswerEvidenceError):
        build_answer_approval("es", sources, evidence, checked, run_id="r1")


@pytest.mark.parametrize(
    "defect",
    [
        "failed_run",
        "wrong_run",
        "changed_output",
        "changed_review",
        "changed_population",
        "missing_note",
    ],
)
def test_successful_g6_proof_cannot_survive_changed_inputs(
    invariant, tmp_path, defect, monkeypatch
):
    sources, row, path = reviewed_fixture(tmp_path)
    evidence = load_answer_evidence("es", sources, path=path)
    approved = build_answer_approval(
        "es", sources, evidence, proofs(sources, evidence), run_id="r1"
    )
    notes = write_answer_approval("es", approved)
    entry = {"lang": "es", "stage": "g6", "status": "ok", "run_id": "r1", "notes": notes}
    install_run(monkeypatch, entry)
    if defect == "failed_run":
        entry["status"] = "failed"
    elif defect == "wrong_run":
        entry["run_id"] = "r2"
    elif defect == "changed_output":
        approved["run_id"] = "tampered"
        write_answer_approval("es", approved)
    elif defect == "changed_review":
        row["rationale"] += " Changed."
        rewrite(path, row, review_again=True)
        evidence = load_answer_evidence("es", sources, path=path)
    elif defect == "changed_population":
        data = source_fixture()
        data["selected"][0]["known_lemmas"] = ["perro"]
        sources = answer_sources(data)
    else:
        entry["notes"] = {}
    with pytest.raises(AnswerEvidenceError):
        load_validated_answer_evidence("es", sources, evidence=evidence, g6_entry=entry)


def test_legacy_alternates_cannot_bypass_independent_review(invariant, tmp_path):
    sources, row, path = reviewed_fixture(tmp_path)
    data = source_fixture()
    data["selected"][0]["accepted_alternates"] = ["El gato"]
    sources = answer_sources(data)
    row["source"] = sources[0].snapshot()
    rewrite(path, row, review_again=True)
    with pytest.raises(AnswerEvidenceError, match="legacy"):
        load_answer_evidence("es", sources, path=path)


def test_latest_failed_or_reordered_stage_cannot_hide_behind_old_success(
    invariant, tmp_path, monkeypatch
):
    import coursekit.answer_evidence as module

    sources, row, path = reviewed_fixture(tmp_path)
    evidence = load_answer_evidence("es", sources, path=path)
    approval = build_answer_approval(
        "es", sources, evidence, proofs(sources, evidence), run_id="r1"
    )
    notes = write_answer_approval("es", approval)
    entries = [{"stage": f"g{i}", "status": "ok"} for i in range(6)]
    g6 = {"lang": "es", "stage": "g6", "status": "ok", "run_id": "r1", "notes": notes}
    entries.append(g6)
    monkeypatch.setattr(module, "read_entries", lambda lang: iter(entries))
    assert load_validated_answer_evidence("es", sources, evidence=evidence)
    entries.append({**g6, "status": "failed", "run_id": "r2"})
    with pytest.raises(AnswerEvidenceError, match="did not succeed"):
        load_validated_answer_evidence("es", sources, evidence=evidence)
    entries.pop()
    entries.append({"stage": "g4", "status": "ok"})
    with pytest.raises(AnswerEvidenceError, match="stale after g4"):
        load_validated_answer_evidence("es", sources, evidence=evidence)


def test_full_alternate_is_preserved_with_its_own_analysis(invariant, tmp_path):
    sources, row, path = reviewed_fixture(tmp_path)
    row["spanish"] = [
        {"text": "GATO", "pair": {"score": 4, "register": "neutral", "judgement": "Same word."}}
    ]
    rewrite(path, row, review_again=True)
    # Case-only forms are already handled by the grader and cannot pad a reviewed set.
    with pytest.raises(AnswerEvidenceError, match="duplicate"):
        load_answer_evidence("es", sources, path=path)

    data = source_fixture()
    data["selected"][0]["known_lemmas"] = ["el"]
    sources = answer_sources(data)
    row["source"] = sources[0].snapshot()
    row["spanish"] = [
        {
            "text": "El gato",
            "pair": {"score": 4, "register": "neutral", "judgement": "Natural noun phrase."},
        }
    ]
    rewrite(path, row, review_again=True)
    evidence = load_answer_evidence("es", sources, path=path)
    checked = proofs(sources, evidence)
    alternative = deepcopy(checked[sources[0].slot][0])
    alternative["text"] = "El gato"
    alternative["analysis"] = {
        "analyser": sources[0].analysis["analyser"],
        "tokens": [
            {"surface": "El", "lemma": "el", "pos": "DET", "morph": "", "start": 0, "end": 2},
            {
                "surface": "gato",
                "lemma": "gato",
                "pos": "NOUN",
                "morph": "Number=Sing",
                "start": 3,
                "end": 7,
            },
        ],
    }
    alternative["checks"]["length"]["detail"].update(count=2, minimum=1, maximum=None)
    checked[sources[0].slot].insert(1, alternative)
    approved = build_answer_approval("es", sources, evidence, checked, run_id="r1")
    assert approved["occurrences"][0]["surfaces"][1]["text"] == "El gato"
    alternative["analysis"] = deepcopy(sources[0].analysis)
    with pytest.raises(AnswerEvidenceError):
        build_answer_approval("es", sources, evidence, checked, run_id="r1")


def test_contextual_formal_address_cannot_be_approved_for_tuteo(invariant, tmp_path):
    sources, row, path = reviewed_fixture(tmp_path)
    row["canonical_pair"]["register"] = "usted"
    rewrite(path, row, review_again=True)
    with pytest.raises(AnswerEvidenceError, match="register"):
        load_answer_evidence("es", sources, path=path)


def test_real_duplicate_occurrences_cannot_be_hidden_as_format_siblings(invariant, tmp_path):
    first_sources, template, path = reviewed_fixture(tmp_path)
    first = first_sources[0]
    data = source_fixture()
    item = data["selected"][0]
    item.update(gap=True, sentence_id=None, provenance="llm")
    second_item = deepcopy(item)
    second_item["slot_index"] = 1
    data["selected"].append(second_item)
    second_candidate = deepcopy(first.source)
    second_candidate.update(candidate_id="b" * 16, slot_index=1)
    data["candidates"] = [deepcopy(first.source), second_candidate]
    data["banded"] = [{"lemma": "gato", "pos": "NOUN"}]
    sources = resolve_selected_sources("es", **data)
    rows = []
    for source in sources:
        row = deepcopy(template)
        row["source"] = source.snapshot()
        row["review"]["content_hash"] = answer_content_hash(row)
        rows.append(row)
    path.write_text("".join(json.dumps(row) + "\n" for row in rows))
    evidence = load_answer_evidence("es", sources, path=path)
    checks = {}
    for source in sources:
        checks.update(proofs((source,), evidence))
    with pytest.raises(AnswerEvidenceError, match="duplicate Spanish answer"):
        build_answer_approval("es", sources, evidence, checks, run_id="r1")
