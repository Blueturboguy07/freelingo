"""Real first-build register/target counterexamples, tested at producer callers."""

import re
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
from coursekit.stages.g5_gapfill import _axis, _candidate_analysis, ledger_digest


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
            x
            for x in [
                "tú",
                "hacer",
                "pan",
                "en",
                "su",
                "horno",
                "cuchara",
                "disculpar",
                "la",
                "molestia",
                "mi",
                "madre",
            ]
            if x not in new
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
    # Exact spans plus controlled finite morphology, including the measured Disculpa
    # counterexample. Ustedes is still lemmatized tú; its pronoun Person=2 is not tuteo.
    tokens = []
    verbs = {
        "disculpa": ("disculpar", "Mood=Imp|Number=Sing|Person=2|VerbForm=Fin"),
        "disculpe": ("disculpar", "Mood=Imp|Number=Sing|Person=3|VerbForm=Fin"),
        "haces": ("hacer", "Mood=Ind|Number=Sing|Person=2|VerbForm=Fin"),
        "hace": ("hacer", "Mood=Ind|Number=Sing|Person=3|VerbForm=Fin"),
    }
    for match in re.finditer(r"\w+|[^\w\s]", text):
        surface = match.group()
        word = surface.casefold()
        lemma, morph = verbs.get(word, (word, ""))
        pos = "VERB" if word in verbs else "NOUN"
        if word in {"ustedes", "usted", "tú", "vosotros"}:
            lemma, pos, morph = "tú", "PRON", "Person=2|PronType=Prs"
        elif not surface.isalnum():
            pos = "PUNCT"
        tokens.append(
            {
                "surface": surface,
                "lemma": lemma,
                "pos": pos,
                "morph": morph,
                "start": match.start(),
                "end": match.end(),
            }
        )
    return {
        "adapter": {"name": "counterexample", "version": "1", "model": None, "split_mode": None},
        "tokens": tokens,
        "lemmas": list(dict.fromkeys(t["lemma"] for t in tokens if t["pos"] != "PUNCT")),
        "display_tokens": [t["surface"] for t in tokens if t["pos"] != "PUNCT"],
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
        ("formal_informal_address", "Disculpa la molestia, mi madre.", False),
        ("formal_informal_address", "Disculpe la molestia, mi madre.", True),
        ("noun_number_agreement", "Disculpa la molestia, mi madre.", True),
    ],
)
def test_INV_PACK_08_g4_register_is_surface_based_and_unit_derived(concept, text, accepted):
    a = analysis(text)
    c = Candidate(
        "a" * 16, frozenset(a["lemmas"]), tuple(a["tokens"]), len(a["display_tokens"]), text
    )
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
        ("usted", "Disculpa la molestia, mi madre.", (), "register"),
        ("usted", "Pan en horno.", ("Disculpa la molestia, mi madre.",), "register"),
        ("usted", "Disculpe la molestia, mi madre.", (), None),
        ("tu", "Disculpa la molestia, mi madre.", (), None),
    ],
)
def test_INV_PACK_08_g5_checks_preferred_and_every_alternate_register(
    required, text, alternates, expected
):
    g = gap()
    a = authored(text, g, alternates)
    reason, carried = _axis(
        a,
        g,
        Analyser(),
        set(),
        "a" * 16,
        3,
        required_unit=unit(
            concept="formal_informal_address" if required == "usted" else "noun_number_agreement"
        ),
    )
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
        authored(text, g, alternates), g, Analyser(), set(), "a" * 16, 3, required_unit=unit()
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


def g6_candidate(text, alternates):
    return {
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
        "analysis": _candidate_analysis(analysis(text)),
    }


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
        ("formal_informal_address", "Disculpa la molestia, mi madre.", [], False),
        (
            "formal_informal_address",
            "El horno hace pan.",
            ["Disculpa la molestia, mi madre."],
            False,
        ),
        ("formal_informal_address", "Disculpe la molestia, mi madre.", [], True),
        ("noun_number_agreement", "Disculpa la molestia, mi madre.", [], True),
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
    candidate = g6_candidate(text, alternates)
    write_records("candidate", [candidate], lang="es")
    with RunLog("es").stage("g5", tool="test", tool_version="1"):
        pass
    before = deepcopy(candidate)
    monkeypatch.setattr(g6, "adapter_for", lambda _lang: Analyser(), raising=False)
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


@pytest.mark.parametrize("bad_evidence", ["missing", "stale_span", "missing_punctuation"])
def test_INV_PACK_08_g4_and_g5_reject_unbound_morphology(bad_evidence):
    text = "Disculpe la molestia, mi madre."
    a = analysis(text)
    if bad_evidence == "missing":
        a["tokens"] = []
    elif bad_evidence == "stale_span":
        a["tokens"][0]["start"] = 1
    else:
        a["tokens"] = [token for token in a["tokens"] if token["pos"] != "PUNCT"]
    u = unit(concept="formal_informal_address")
    u["target_lemmas"] = a["lemmas"]
    c = Candidate(
        "a" * 16, frozenset(a["lemmas"]), tuple(a["tokens"]), len(a["display_tokens"]), text
    )
    result = select(
        [u],
        [c],
        {
            "formal_informal_address": SimpleNamespace(
                probe=SimpleNamespace(matches_sentence=lambda _: True)
            )
        },
        {},
    )
    assert all(row["sentence_id"] is None for row in result.items)
    g = gap()
    analyser = SimpleNamespace(analyse=lambda **_: a)
    reason, _ = _axis(authored(text, g), g, analyser, set(), "a" * 16, 3, required_unit=u)
    assert reason == "register"


@pytest.mark.parametrize(
    "bad_evidence", ["preferred_missing", "preferred_stale", "alternate_stale"]
)
def test_INV_PACK_08_g6_rejects_missing_or_borrowed_sentence_analysis(
    es_adapter,  # noqa: F811
    monkeypatch,
    bad_evidence,
):
    import coursekit.stages.g6_validate_language as g6
    from coursekit.runlog import RunLog

    text = "El horno hace pan."
    alternates = ["Disculpe la molestia, mi madre."] if bad_evidence == "alternate_stale" else []
    row = g6_candidate(text, alternates)
    if bad_evidence == "preferred_missing":
        row["analysis"] = None
    elif bad_evidence == "preferred_stale":
        row["analysis"]["tokens"][0]["start"] = 1
    write_records("unit_assignment", [unit(concept="formal_informal_address")], lang="es")
    write_records("candidate", [row], lang="es")
    with RunLog("es").stage("g5", tool="test", tool_version="1"):
        pass
    # An alternate cannot reuse the preferred sentence's otherwise valid analysis.
    monkeypatch.setattr(
        g6, "adapter_for", lambda _: SimpleNamespace(analyse=lambda **_: analysis(text))
    )
    checked_by_engines = []

    def checked(candidate, *_args):
        checked_by_engines.append(candidate["text"])
        return None, {}

    monkeypatch.setattr(g6, "_axis", checked)
    run_g6({})
    narrowed = list(read_records("candidate", lang="es"))[0]
    assert not narrowed["accepted"]
    assert narrowed["reject_reason"] == "g6:register"
    assert narrowed["text"] == text and narrowed["accepted_alternates"] == alternates
    assert checked_by_engines == ([text] if bad_evidence == "alternate_stale" else [])
    findings = read_entries("es", stage="g6")[-1]["notes"]["findings"]
    assert findings[0]["answer_kind"] == (
        "alternate" if bad_evidence == "alternate_stale" else "preferred"
    )
    assert findings[0]["analysis_error"]
