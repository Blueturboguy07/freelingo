"""Bounded source checks; fake engines are named and are never production evidence."""

import copy

import pytest
from test_radio_compiler import prepare, source_fixture
from test_radio_draft import inputs

from coursekit.narratives.compiler import NarrativeError


def units(prepared):
    words = sorted(
        {t["lemma"] for a in prepared.analyses.values() for t in a["tokens"] if t["pos"] != "PUNCT"}
    )
    return [
        {
            "schema_version": 1,
            "lang": "es",
            "unit_index": 1,
            "unit_title": "Original fixture",
            "function": "test",
            "grammar_concept": "subject_pronouns",
            "register_slot": "binary_t_v",
            "section_index": 1,
            "section_cefr": "A1",
            "level_count": 3,
            "target_lemmas": words,
            "recycled_lemmas": [],
        },
        {
            "schema_version": 1,
            "lang": "es",
            "unit_index": 2,
            "unit_title": "Original fixture two",
            "function": "test",
            "grammar_concept": "subject_pronouns",
            "register_slot": "binary_t_v",
            "section_index": 1,
            "section_cefr": "A1",
            "level_count": 3,
            "target_lemmas": ["único"],
            "recycled_lemmas": [],
        },
    ]


class Grammar:
    def __init__(self):
        self.calls = []

    def probe(self, lang):
        return {
            "available": True,
            "grammar_engine": "original-fixture-grammar",
            "spellcheck_engine": "none",
            "reason": "original test stub",
        }

    def check(self, lang, text):
        self.calls.append((lang, text))
        return []


def test_INV_PACK_14_preflight_names_actual_engines_and_checks_every_source_surface():
    from coursekit.narratives.preflight import inspect_radio_source

    source = source_fixture()
    source["segments"][1]["text"] = "Café y pan."
    prepared = prepare(source)
    grammar = Grammar()
    report = inspect_radio_source(prepared, units(prepared), grammar=grammar)
    assert not report["blocking"]
    assert report["engines"]["degraded_to"] == "grammar_only"
    assert report["engines"]["grammar"]["grammar_engine"] == "original-fixture-grammar"
    assert len(grammar.calls) == len(prepared.analyses)
    assert report["remaining"] == [
        "exact-pack-targets",
        "independent-review",
        "combined-pack-validation",
        "measured-audio",
    ]


@pytest.mark.parametrize(
    "fault",
    [
        "both-unavailable",
        "grammar-exception",
        "future-word",
        "missing-unit",
        "duplicate-unit",
        "wrong-language",
        "wrong-register",
        "register-surface",
        "heard-distractor",
        "perplexity-outlier",
        "nonfinite-perplexity",
        "unknown-token",
        "stale-preparation",
    ],
)
def test_INV_PACK_10_preflight_produces_explicit_discard_reasons(fault):
    from coursekit.narratives.preflight import inspect_radio_source

    source = source_fixture()
    source["segments"][1]["text"] = "Café y pan."
    if fault == "heard-distractor":
        source["segments"][1]["text"] = "Café y pan con queso."
    if fault == "wrong-register":
        source["register"] = "usted"
    if fault == "register-surface":
        source["segments"][1]["text"] = "Usted tiene café."
    prepared = prepare(source)
    declarations = units(prepared)
    grammar = Grammar()
    perplexity = None
    if fault == "both-unavailable":
        grammar = None
    if fault == "grammar-exception":

        def bad(lang, text):
            raise RuntimeError("actual call failed")

        grammar.check = bad
    if fault in {"future-word", "unknown-token"}:
        declarations[0]["target_lemmas"].remove("café")
    if fault == "future-word":
        declarations.append({**declarations[-1], "unit_index": 3, "target_lemmas": ["café"]})
    if fault == "missing-unit":
        declarations.pop()
    if fault == "duplicate-unit":
        declarations.append(declarations[-1])
    if fault == "wrong-language":
        declarations[0]["lang"] = "fr"
    if fault in {"perplexity-outlier", "nonfinite-perplexity"}:

        class Perplexity:
            band = (1.0, 10.0)

            def probe(self, lang):
                return {"available": True, "perplexity_engine": "original-fixture-lm"}

            def in_band(self, text):
                return (False, 11.0) if fault == "perplexity-outlier" else (True, float("nan"))

        perplexity = Perplexity()
    if fault == "stale-preparation":
        prepared.source["title"] = "Changed"
    report = inspect_radio_source(prepared, declarations, grammar=grammar, perplexity=perplexity)
    assert report["blocking"], fault
    assert report["eligible_for_draft"] is False


def test_INV_PACK_10_radio_selection_requires_exact_independent_source_and_plan_review():
    from coursekit.narratives.preflight import radio_review_hash, select_radio_draft
    from coursekit.narratives.radio_draft import compile_radio_draft

    prepared, plan, targets = inputs()
    draft = compile_radio_draft(prepared, plan, targets)
    from coursekit.narratives.preflight import inspect_radio_source

    result = inspect_radio_source(prepared, units(prepared), grammar=Grammar())
    candidate = {"draft": draft, "source_check": result}
    review = {
        "candidateSha256": radio_review_hash(draft, result),
        "reviewer": "Independent original reviewer",
        "verdict": "accept",
        "date": "2026-09-13",
        "note": "Original fixture only; exact pairs, surfaces, options and tags inspected.",
    }
    chosen, discarded = select_radio_draft([candidate], [review])
    assert chosen is draft and discarded == []
    for fault in [
        "self-source",
        "self-plan",
        "stale",
        "missing",
        "duplicate",
        "reject",
        "failed-check",
    ]:
        altered = copy.deepcopy(review)
        checks = copy.deepcopy(result)
        if fault == "self-source":
            altered["reviewer"] = prepared.author
        if fault == "self-plan":
            altered["reviewer"] = plan["author"]
        if fault == "stale":
            altered["candidateSha256"] = "0" * 64
        if fault == "reject":
            altered["verdict"] = "reject"
        if fault == "failed-check":
            checks["blocking"] = [{"code": "unallocated"}]
            checks["eligible_for_draft"] = False
        reviews = (
            [] if fault == "missing" else [altered, altered] if fault == "duplicate" else [altered]
        )
        with pytest.raises(NarrativeError):
            select_radio_draft([{"draft": draft, "source_check": checks}], reviews)
    assert draft.evidence["source"] == prepared.source
