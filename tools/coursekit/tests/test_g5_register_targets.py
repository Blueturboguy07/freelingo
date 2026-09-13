"""Real first-build register/target counterexamples, tested at producer callers."""

from copy import deepcopy
from types import SimpleNamespace

import pytest
from test_g3_solve import minimal, write
from test_g5_gapfill import _write_authored, es_adapter, run_g5, stage_g4  # noqa: F401
from test_g6_validate_language import run_g6

from coursekit.artifacts import read_records, write_records
from coursekit.inputs import MissingInput
from coursekit.runlog import read_entries
from coursekit.stages.g3_solve import CurriculumError, load_curriculum
from coursekit.stages.g4_select import Candidate, select
from coursekit.stages.g5_gapfill import _axis, ledger_digest


def unit(index=18, concept="noun_number_agreement"):
    return {
        "schema_version": 1,
        "lang": "es",
        "section_index": 1,
        "section_cefr": "A1",
        "unit_index": index,
        "unit_title": "Fixture",
        "function": "fixture",
        "grammar_concept": concept,
        "register_slot": "binary_t_v",
        "target_lemmas": ["horno"],
        "recycled_lemmas": [],
        "level_count": 1,
    }


def gap(index=18, new=()):
    return {
        "schema_version": 1,
        "lang": "es",
        "unit_index": index,
        "lesson_index": 107,
        "slot_index": 0,
        "sentence_id": None,
        "provenance": "llm",
        "gap": True,
        "new_lemmas": list(new),
        "known_lemmas": [
            x for x in ["tú", "hacer", "pan", "en", "su", "horno", "cuchara"] if x not in new
        ],
        "grammar_concept": "noun_number_agreement",
        "accepted_alternates": [],
    }


def authored(text, g, alternates=()):
    return {
        "slot": {k: g[k] for k in ["unit_index", "lesson_index", "slot_index"]},
        "text": text,
        "translation": "You bake bread in your ovens.",
        "ledger_digest": ledger_digest(g["known_lemmas"], g["new_lemmas"]),
        "new_lemmas": list(g["new_lemmas"]),
        "author": "test",
        "generated_at": "2026-09-13",
        "provenance": "llm",
        "accepted_alternates": [{"text": t, "backtranslation": {"score": 4}} for t in alternates],
        "backtranslation": {"score": 4},
    }


def analysis(text):
    # The actual CI failure: Ustedes becomes lemma tú, so lemmas alone cannot guard V6.
    pairs = [
        (s, "tú" if s.casefold() in {"ustedes", "usted", "tú", "vosotros"} else s.casefold())
        for s in text.strip().removesuffix(".").split()
    ]
    return {
        "adapter": {"name": "counterexample", "version": "1", "model": None, "split_mode": None},
        "tokens": [
            {
                "surface": s,
                "lemma": lemma,
                "pos": "NOUN",
                "morph": "",
                "start": i * 10,
                "end": i * 10 + len(s),
            }
            for i, (s, lemma) in enumerate(pairs)
        ],
        "lemmas": [lemma for _, lemma in pairs],
        "display_tokens": [s for s, _ in pairs],
    }


class Analyser:
    def analyse(self, *, sentence_id, text):
        return analysis(text)


@pytest.mark.parametrize("slot", ["n/a", "graded_honorific"])
def test_INV_PACK_08_g3_refuses_formal_unit_without_binary_declaration(tmp_path, slot):
    doc = minimal()
    doc["grammar_concepts"][0]["id"] = "formal_informal_address"
    doc["sections"][0]["units"][0]["grammar_concept"] = "formal_informal_address"
    doc["sections"][0]["units"][0]["register_slot"] = slot
    with pytest.raises(CurriculumError, match="register|binary_t_v"):
        load_curriculum("es", path=write(tmp_path, doc))


@pytest.mark.parametrize(
    ("concept", "text", "accepted"),
    [
        ("noun_number_agreement", "Ustedes hacen pan en sus hornos.", False),
        ("noun_number_agreement", "Vosotros hacéis pan en vuestros hornos.", True),
        ("formal_informal_address", "Ustedes hacen pan en sus hornos.", True),
        ("formal_informal_address", "Tú haces pan en tu horno.", False),
        ("formal_informal_address", "Usted y tú hacen pan.", False),
        ("formal_informal_address", "El horno hace pan.", True),
    ],
)
def test_INV_PACK_08_g4_register_is_surface_based_and_unit_derived(concept, text, accepted):
    a = analysis(text)
    c = Candidate("a" * 16, frozenset(a["lemmas"]), tuple(a["tokens"]), len(a["display_tokens"]))
    u = unit(concept=concept)
    u["target_lemmas"] = list(dict.fromkeys(a["lemmas"]))
    result = select(
        [u],
        [c],
        {concept: SimpleNamespace(probe=SimpleNamespace(matches_sentence=lambda _: True))},
        {},
    )
    assert any(r["sentence_id"] == c.sentence_id for r in result.items) is accepted


@pytest.mark.parametrize(
    ("required", "text", "alternates", "expected"),
    [
        ("tu", "Ustedes pan en horno.", (), "register"),
        ("tu", "Pan en horno.", ("Ustedes pan en horno.",), "register"),
        ("usted", "Tú pan en horno.", (), "register"),
        ("usted", "Pan en horno.", ("Tú pan en horno.",), "register"),
        ("usted", "Usted y tú pan.", (), "register"),
        ("usted", "Ustedes pan en horno.", (), None),
        ("tu", "Pan en horno.", (), None),
    ],
)
def test_INV_PACK_08_g5_checks_preferred_and_every_alternate_register(
    required, text, alternates, expected
):
    g = gap()
    a = authored(text, g, alternates)
    reason, carried = _axis(a, g, Analyser(), set(), "a" * 16, 3, required_register=required)
    assert reason == expected
    assert carried is not None
    assert a["text"] == text


@pytest.mark.parametrize(
    ("text", "alternates", "expected"),
    [
        ("Pan en horno.", (), "missing_target"),
        ("Cuchara en horno.", ("Pan en horno.",), "missing_target"),
        ("Cuchara en horno.", (), None),
    ],
)
def test_INV_PACK_06_gap_fill_must_carry_its_reserved_target_in_every_surface(
    text, alternates, expected
):
    g = gap(new=["cuchara"])
    reason, _ = _axis(
        authored(text, g, alternates), g, Analyser(), set(), "a" * 16, 3, required_register="tu"
    )
    assert reason == expected


@pytest.mark.parametrize(
    ("concept", "bad", "good"),
    [
        ("noun_number_agreement", "Ustedes pan en horno.", "Pan en horno."),
        ("formal_informal_address", "Tú pan en horno.", "Ustedes pan en horno."),
    ],
)
def test_INV_PACK_08_actual_g5_caller_uses_unit_policy(
    es_adapter,  # noqa: F811
    tmp_path,
    monkeypatch,
    concept,
    bad,
    good,
):
    import coursekit.stages.g5_gapfill as g5

    g = gap()
    rows = [authored(bad, g), *[authored(good + " " * i, g) for i in range(20)]]
    _write_authored(tmp_path, monkeypatch, rows)
    stage_g4("es", [g])
    write_records("unit_assignment", [unit(concept=concept)], lang="es")
    monkeypatch.setattr(g5, "_analyse", lambda _a, _id, text: analysis(text))
    assert run_g5().ok
    emitted = list(read_records("candidate", lang="es"))
    assert emitted[0]["accepted"] is False
    assert emitted[0]["reject_reason"] == "register"
    assert any(r["accepted"] and r["text"] == good for r in emitted)


def test_INV_PACK_06_actual_g5_caller_cannot_fill_a_target_with_unrelated_text(
    es_adapter,  # noqa: F811
    tmp_path,
    monkeypatch,
):
    import coursekit.stages.g5_gapfill as g5

    g = gap(new=["cuchara"])
    rows = [authored("Pan en horno." + " " * i, g) for i in range(20)]
    _write_authored(tmp_path, monkeypatch, rows)
    stage_g4("es", [g])
    write_records("unit_assignment", [unit()], lang="es")
    monkeypatch.setattr(g5, "_analyse", lambda _a, _id, text: analysis(text))
    assert not run_g5().ok
    assert {r["reject_reason"] for r in read_records("candidate", lang="es")} == {"missing_target"}


@pytest.mark.parametrize(
    ("concept", "text", "alternates", "accepted"),
    [
        ("noun_number_agreement", "Ustedes hacen pan en sus hornos.", [], False),
        (
            "noun_number_agreement",
            "El horno hace pan.",
            ["Ustedes hacen pan en sus hornos."],
            False,
        ),
        ("formal_informal_address", "Tú haces pan.", [], False),
        ("formal_informal_address", "El horno hace pan.", ["Tú haces pan."], False),
        ("formal_informal_address", "Ustedes hacen pan en sus hornos.", [], True),
        ("formal_informal_address", "Usted y tú hacen pan.", [], False),
    ],
)
def test_INV_PACK_08_actual_g6_rechecks_unit_register_without_rewriting(
    es_adapter,  # noqa: F811
    monkeypatch,
    concept,
    text,
    alternates,
    accepted,
):
    import coursekit.stages.g6_validate_language as g6
    from coursekit.runlog import RunLog

    u = unit(concept=concept)
    write_records("unit_assignment", [u], lang="es")
    candidate = {
        "schema_version": 1,
        "lang": "es",
        "candidate_id": "a" * 16,
        "unit_index": 18,
        "lesson_index": 107,
        "slot_index": 0,
        "text": text,
        "translation": "You bake bread in your ovens.",
        "accepted_alternates": alternates,
        "author": "test",
        "generated_at": "2026-09-13",
        "accepted": True,
        "reject_reason": None,
        "provenance": "llm",
        "analysis": None,
    }
    write_records("candidate", [candidate], lang="es")
    with RunLog("es").stage("g5", tool="test", tool_version="1"):
        pass
    before = deepcopy(candidate)
    monkeypatch.setattr(g6, "_axis", lambda *_args, **_kwargs: (None, {}))
    run_g6({})
    after = list(read_records("candidate", lang="es"))[0]
    assert after["accepted"] is accepted
    assert (
        after["text"] == before["text"]
        and after["accepted_alternates"] == before["accepted_alternates"]
    )
    if not accepted:
        assert after["reject_reason"] == "g6:register"
        assert read_entries("es", stage="g6")[-1]["notes"]["rejected_by_axis"]["register"] == 1


def test_INV_PACK_08_g5_missing_unit_declaration_fails_closed(
    es_adapter,  # noqa: F811
    tmp_path,
    monkeypatch,
):
    g = gap()
    rows = [authored("Pan en horno." + " " * i, g) for i in range(20)]
    _write_authored(tmp_path, monkeypatch, rows)
    stage_g4("es", [g])
    write_records("unit_assignment", [unit(index=19)], lang="es")
    with pytest.raises(MissingInput, match="unit|register"):
        run_g5()
