"""[INV-GRD-03] accepted paraphrases do not become new canonical teaching sources."""

import json
from copy import deepcopy
from dataclasses import replace

import pytest
from test_answer_evidence import check
from test_conversation_evidence import corpus
from test_selected_sources import source_fixture

from coursekit.answer_evidence import (
    AnswerEvidenceError,
    SurfacePolicy,
    answer_content_hash,
    build_answer_approval,
    load_answer_evidence,
    noncanonical_answer_policy,
    validate_surface_proof,
)
from coursekit.ledger import count_units
from coursekit.selected_sources import resolve_selected_sources

pytestmark = pytest.mark.parametrize("invariant", ["INV-GRD-03", "INV-PACK-08", "INV-PACK-41"])

CASES = [
    (
        "Yo soy español.",
        "Soy español.",
        "I am Spanish.",
        [],
        [("Yo", "yo", "PRON"), ("soy", "ser", "AUX"), ("español", "español", "ADJ")],
        [("Soy", "ser", "AUX"), ("español", "español", "ADJ")],
    ),
    (
        "Ella es buena.",
        "Es buena.",
        "She is good.",
        ["él"],
        [("Ella", "él", "PRON"), ("es", "ser", "AUX"), ("buena", "bueno", "ADJ")],
        [("Es", "ser", "AUX"), ("buena", "bueno", "ADJ")],
    ),
    (
        "No quiero tomar té frío.",
        "No quiero beber té frío.",
        "I do not want to drink cold tea.",
        ["tomar"],
        [
            ("No", "no", "ADV"),
            ("quiero", "querer", "VERB"),
            ("tomar", "tomar", "VERB"),
            ("té", "té", "NOUN"),
            ("frío", "frío", "ADJ"),
        ],
        [
            ("No", "no", "ADV"),
            ("quiero", "querer", "VERB"),
            ("beber", "beber", "VERB"),
            ("té", "té", "NOUN"),
            ("frío", "frío", "ADJ"),
        ],
    ),
]


def reviewed_case(tmp_path, case=CASES[1]):
    canonical, alternate, english, targets, specs, alt_specs = case
    source, analysis = corpus(canonical, english, [*specs, (".", ".", "PUNCT")])
    _, alt_analysis = corpus(alternate, english, [*alt_specs, (".", ".", "PUNCT")])
    data = source_fixture()
    data.update(ingested=[source], analysed=[analysis])
    data["selected"][0].update(
        sentence_id=source["sentence_id"],
        new_lemmas=targets,
        known_lemmas=sorted({lemma for _, lemma, _ in [*specs, *alt_specs]} - set(targets)),
    )
    sources = resolve_selected_sources("es", **data)
    pair = dict(score=4, register="neutral", judgement="Same ordinary sentence meaning.")
    row = dict(
        schema_version=1,
        source=sources[0].snapshot(),
        author="author A",
        licence="CC-BY-NC-SA-4.0",
        authored_on="2026-09-13",
        rationale="Reviewed natural paraphrase.",
        canonical_pair=pair,
        spanish=[dict(text=alternate, pair=deepcopy(pair))],
        english_reverse_only=[],
        review=None,
    )
    row["review"] = dict(
        reviewer="reviewer B",
        verdict="accepted",
        note="Meaning and register checked.",
        content_hash=answer_content_hash(row),
    )
    path = tmp_path / "answers.jsonl"
    path.write_text(json.dumps(row) + "\n")
    evidence = load_answer_evidence("es", sources, path=path)
    return sources, row, evidence, alt_analysis


def surface_proof(source, row, text, analysis, *, canonical):
    spanish = analysis is not None
    lang = source.lang if spanish else "en"
    checks = {
        name: check(lang)
        for name in (
            ["ledger", "register", "length", "duplicate", "pair", "grammar", "perplexity"]
            if spanish
            else ["pair", "grammar"]
        )
    }
    if spanish:
        checks["length"]["detail"] = dict(
            minimum=source.minimum_tokens if canonical else 1,
            maximum=12 if canonical else None,
            count=count_units(
                dict(lang=lang, tokens=analysis["tokens"], adapter=analysis["adapter"])
            ),
            window_pos_digest=source.window_pos_digest,
        )
    checks["pair"]["detail"] = dict(score=4, review_hash=row["review"]["content_hash"])
    return dict(
        use="forward" if spanish else "reverse_only", text=text, analysis=analysis, checks=checks
    )


def checked_case(sources, row, alternate_analysis):
    source = sources[0]
    return {
        source.slot: [
            surface_proof(source, row, source.text, source.analysis, canonical=True),
            surface_proof(
                source, row, row["spanish"][0]["text"], alternate_analysis, canonical=False
            ),
            surface_proof(source, row, source.translation, None, canonical=False),
        ]
    }


@pytest.mark.parametrize(
    "case", CASES, ids=["subject_drop", "omitted_reserved_pronoun", "known_synonym"]
)
def test_reviewed_paraphrase_preserves_canonical_source_and_target_credit(
    invariant, tmp_path, case
):
    sources, row, evidence, alternate_analysis = reviewed_case(tmp_path, case)
    before = deepcopy(sources[0].snapshot())
    approval = build_answer_approval(
        "es", sources, evidence, checked_case(sources, row, alternate_analysis), run_id="r1"
    )
    occurrence = approval["occurrences"][0]
    assert occurrence["source_id"] == sources[0].source_id
    assert [p["text"] for p in occurrence["surfaces"]][:2] == [case[0], case[1]]
    assert sources[0].snapshot() == before
    assert sources[0].new_lemmas <= sources[0].lemmas


@pytest.mark.parametrize(
    "defect", ["unknown", "register", "pair_hash", "stale_span", "unavailable", "old_length_policy"]
)
def test_noncanonical_answer_retains_its_own_destination_and_language_guards(
    invariant, tmp_path, defect
):
    sources, row, evidence, alternate_analysis = reviewed_case(tmp_path)
    checked = checked_case(sources, row, deepcopy(alternate_analysis))
    proof = checked[sources[0].slot][1]
    if defect == "unknown":
        proof["analysis"]["tokens"][1]["lemma"] = "unknown"
    elif defect == "register":
        changed = deepcopy(row)
        changed["spanish"][0]["pair"]["register"] = "usted"
        changed["review"]["content_hash"] = answer_content_hash(changed)
        path = tmp_path / "bad-register.jsonl"
        path.write_text(json.dumps(changed) + "\n")
        with pytest.raises(AnswerEvidenceError, match="register"):
            load_answer_evidence("es", sources, path=path)
        return
    elif defect == "pair_hash":
        proof["checks"]["pair"]["detail"]["review_hash"] = "old"
    elif defect == "stale_span":
        proof["analysis"]["tokens"][0]["surface"] = "Era"
    elif defect == "unavailable":
        proof["checks"]["grammar"] = check("es", available=False)
    else:
        proof["checks"]["length"]["detail"].update(minimum=3, maximum=12)
    if defect == "unavailable":
        proof["checks"]["perplexity"] = check("es", available=False)
    with pytest.raises(AnswerEvidenceError):
        build_answer_approval("es", sources, evidence, checked, run_id="r1")


def test_noncanonical_policy_cannot_add_allowance_or_a_second_new_item(invariant, tmp_path):
    sources, row, evidence, alt = reviewed_case(tmp_path)
    original = SurfacePolicy.from_source(sources[0])
    policy = noncanonical_answer_policy(original)
    assert policy == replace(original, minimum_tokens=1, maximum_tokens=None)
    assert original.minimum_tokens == 3 and original.maximum_tokens == 12
    policy = replace(policy, known_lemmas=frozenset(), new_lemmas=frozenset({"ser", "bueno"}))
    proof = checked_case(sources, row, alt)[sources[0].slot][1]
    with pytest.raises(AnswerEvidenceError, match="new-lemma budget"):
        validate_surface_proof(
            policy,
            proof,
            use="forward",
            text=row["spanish"][0]["text"],
            pair=row["spanish"][0]["pair"],
            review_hash=row["review"]["content_hash"],
            required_target_lemmas=frozenset(),
        )


def test_accepted_answer_overlap_does_not_duplicate_canonical_source_slots(invariant, tmp_path):
    texts = ["Yo tomo leche.", "Yo bebo leche."]
    pairs = [
        corpus(
            text,
            "I drink milk.",
            [
                ("Yo", "yo", "PRON"),
                (verb, lemma, "VERB"),
                ("leche", "leche", "NOUN"),
                (".", ".", "PUNCT"),
            ],
        )
        for text, verb, lemma in [(texts[0], "tomo", "tomar"), (texts[1], "bebo", "beber")]
    ]
    data = source_fixture()
    data.update(ingested=[pair[0] for pair in pairs], analysed=[pair[1] for pair in pairs])
    data["selected"] = [
        dict(
            data["selected"][0],
            slot_index=i,
            sentence_id=pair[0]["sentence_id"],
            new_lemmas=[],
            known_lemmas=["yo", "tomar", "beber", "leche"],
        )
        for i, pair in enumerate(pairs)
    ]
    sources = resolve_selected_sources("es", **data)
    template = reviewed_case(tmp_path)[1]
    rows = []
    checks = {}
    for i, source in enumerate(sources):
        row = deepcopy(template)
        row["source"] = source.snapshot()
        row["spanish"][0]["text"] = texts[1 - i]
        row["review"]["content_hash"] = answer_content_hash(row)
        rows.append(row)
        checks.update(checked_case((source,), row, pairs[1 - i][1]))
    path = tmp_path / "overlap.jsonl"
    path.write_text("".join(json.dumps(row) + "\n" for row in rows))
    evidence = load_answer_evidence("es", sources, path=path)
    approval = build_answer_approval("es", sources, evidence, checks, run_id="r1")
    assert len(approval["occurrences"]) == 2
    assert [row["surfaces"][0]["text"] for row in approval["occurrences"]] == texts
