"""V5, V6 and the two G7 invariant gates, driven by their committed falsifiers.

Every test here loads `tests/falsifiers/<id>.json` rather than building its subject
inline. That is the plan's rule ("committed falsifier inputs per invariant") and it buys
something specific: the input that *fails* the invariant is reviewable next to the
invariant's text, and a change that quietly stops detecting it shows up as a green test
over a file somebody can read.

Each falsifier file also carries a `repair` block, and every test asserts BOTH
directions. A gate that only ever sees the failing input passes just as well when it
returns a finding for everything.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from coursekit.artifacts import validate_record
from coursekit.config.g7 import (
    ES_AMBIGUOUS_THIRD_PERSON_FORMS,
    ES_REGISTER_MARKERS,
    MIN_FORMS_PER_MISSABLE_ITEM,
    SHAPES,
    V6_IMPLEMENTED_LANGUAGES,
)
from coursekit.exercises.shapes import missable_shapes, mistake_queue_eligible
from coursekit.validators.exercise import (
    check_pack_07,
    check_pack_50,
    check_v5,
    check_v6,
    item_keys,
    register_of,
)

FALSIFIERS = Path(__file__).parent / "falsifiers"


def load(invariant: str, block: str) -> list[dict[str, Any]]:
    """One block of a falsifier file, schema-validated on the way out.

    Validating here is not ceremony: a falsifier that stopped matching the frozen
    `exercise` contract would still be JSON, and the gate under test would fail it for
    the wrong reason while the test still went green.
    """
    payload = json.loads((FALSIFIERS / f"{invariant}.json").read_text(encoding="utf-8"))
    records = payload[block]["exercises"]
    for record in records:
        validate_record("exercise", record, where=f"{invariant}.json/{block}")
    return records


def blocking(findings: list[Any]) -> list[Any]:
    return [finding for finding in findings if finding.severity == "blocking"]


# ---------------------------------------------------------------------------
# INV-PACK-07
# ---------------------------------------------------------------------------


def test_INV_PACK_07_the_falsifier_is_caught() -> None:
    """[INV-PACK-07] a pack with a single-form missable item is blocked."""
    findings = blocking(check_pack_07(load("INV-PACK-07", "falsifier")))
    assert len(findings) == 1, findings
    assert findings[0].validator_id == "INV-PACK-07"
    assert "sentence:aaaaaaaaaaaa0001" in findings[0].detail["item"]


def test_INV_PACK_07_the_repair_passes() -> None:
    """[INV-PACK-07] the same item with a second punitive form is accepted."""
    assert blocking(check_pack_07(load("INV-PACK-07", "repair"))) == []


def test_INV_PACK_07_a_non_punitive_second_form_does_not_count() -> None:
    """[INV-PACK-07] a Speak alongside a word-bank is still one authored form.

    EC-MIS-11: "a non-punitive Trace replay can never clear a mistake". A gate that
    counted any second form would pass this pack and the session would reach the
    mistake drain with nothing it can schedule.
    """
    findings = blocking(check_pack_07(load("INV-PACK-07", "non_punitive_second_form")))
    assert len(findings) == 1, findings
    assert "speak_this_sentence" in findings[0].message


def test_INV_PACK_07_non_punitive_shapes_are_excluded_by_construction() -> None:
    """[INV-PACK-07] mistake-queue eligibility has exactly one source: `punitive`.

    The invariant says "by construction", so the test is about there being no second
    list to drift from the first — not about a sampled behaviour.
    """
    for item in SHAPES:
        assert mistake_queue_eligible(item.id) is item.punitive
    assert set(missable_shapes()) == {item.id for item in SHAPES if item.punitive}
    assert {item.id for item in SHAPES if not item.punitive} & set(missable_shapes()) == set()


def test_INV_PACK_07_a_match_is_a_form_of_each_of_its_five_lexemes() -> None:
    """[INV-PACK-07] EC-MIS-04's hard case: S033 is five items' form, not one item's.

    Filing a match under one composite key would make every match a single-form
    missable item and fail the invariant for a reason that is not true.
    """
    match = {
        "schema_version": 1,
        "lang": "es",
        "exercise_id": "0000000000000733",
        "unit_index": 1,
        "lesson_index": 1,
        "type": "match",
        "prompt": "Tap the matching pairs\nuno\ndos\ntres\ncuatro\ncinco",
        "accepted_answers": [
            "uno = one",
            "dos = two",
            "tres = three",
            "cuatro = four",
            "cinco = five",
        ],
        "distractors": [],
        "alignment": [],
        "item_tags": {
            "lemmas": ["uno", "dos", "tres", "cuatro", "cinco"],
            "grammar_concepts": [],
        },
        "audio_ref": None,
        "register": "tu",
        "source_sentence_id": None,
    }
    validate_record("exercise", match)
    assert len(item_keys(match)) == 5
    # Five items, each with one punitive form so far: five findings, not one.
    assert len(blocking(check_pack_07([match]))) == 5


def test_INV_PACK_07_threshold_is_the_named_constant() -> None:
    """[INV-PACK-07] the gate reads MIN_FORMS_PER_MISSABLE_ITEM and nothing else."""
    assert MIN_FORMS_PER_MISSABLE_ITEM == 2


# ---------------------------------------------------------------------------
# INV-PACK-50
# ---------------------------------------------------------------------------


def test_INV_PACK_50_the_falsifier_is_caught() -> None:
    """[INV-PACK-50] EC-PACK-47's 〜枚 in a picture-select prompt is blocked."""
    findings = blocking(check_pack_50(load("INV-PACK-50", "falsifier")))
    assert len(findings) == 1, findings
    assert findings[0].detail["quoted"] == "〜枚"
    assert "tips interstitial" in findings[0].message


def test_INV_PACK_50_a_quote_outside_the_tag_set_is_caught() -> None:
    """[INV-PACK-50] a lexeme-quoting prompt must quote a lexeme this item teaches."""
    findings = blocking(check_pack_50(load("INV-PACK-50", "orphan_quote")))
    assert len(findings) == 1, findings
    assert findings[0].detail["quoted"] == "perro"


def test_INV_PACK_50_the_repair_passes() -> None:
    """[INV-PACK-50] quoting a taught lexeme is accepted, in both quoting shapes."""
    records = load("INV-PACK-50", "repair")
    assert blocking(check_pack_50(records)) == []
    assert blocking(check_pack_07(records)) == []


def test_INV_PACK_50_the_pill_clause_is_discharged_by_the_subset_relation() -> None:
    """[INV-PACK-50] every NEW WORD-eligible shape quotes a lexeme.

    This is the whole reason a record-level check can speak to a clause the frozen
    contract has no field for. The day somebody makes a non-quoting shape pill-eligible,
    this fails and `check_pack_50` stops being sufficient — which is the point.
    """
    pill = {item.id for item in SHAPES if item.new_word_eligible}
    quoting = {item.id for item in SHAPES if item.quotes_lexeme}
    assert pill, "no shape can introduce a word; the pill would never render"
    assert pill <= quoting


# ---------------------------------------------------------------------------
# V5
# ---------------------------------------------------------------------------


POS = {"perro": "NOUN", "gato": "NOUN", "caballo": "NOUN", "correr": "VERB", "casa": "NOUN"}


def _option_record(distractors: list[str], accepted: list[str]) -> dict[str, Any]:
    record = {
        "schema_version": 1,
        "lang": "es",
        "exercise_id": "0000000000000555",
        "unit_index": 1,
        "lesson_index": 1,
        "type": "match",
        "prompt": "Which one of these is “perro”?\nperro",
        "accepted_answers": accepted,
        "distractors": distractors,
        "alignment": [],
        "item_tags": {"lemmas": ["perro"], "grammar_concepts": []},
        "audio_ref": None,
        "register": "tu",
        "source_sentence_id": None,
    }
    validate_record("exercise", record)
    return record


def test_V5_a_distractor_that_is_an_accepted_answer_is_blocked() -> None:
    findings = blocking(check_v5([_option_record(["perro", "gato"], ["perro"])], pos_of=POS))
    assert any("accepted answers" in finding.message for finding in findings)


def test_V5_a_distractor_of_another_pos_is_blocked() -> None:
    findings = blocking(check_v5([_option_record(["correr", "gato"], ["perro"])], pos_of=POS))
    assert any("VERB" in finding.message for finding in findings)


def test_V5_a_sibling_exercises_accepted_answer_is_a_valid_alternative() -> None:
    """[INV-PACK-07 neighbours] V5's third clause needs the whole item, not one row.

    `can` is an accepted answer of the reverse-direction exercise over the same lexeme,
    so offering it as a distractor marks a right answer wrong.
    """
    primary = _option_record(["gato", "caballo"], ["perro"])
    sibling = {
        **primary,
        "exercise_id": "0000000000000556",
        "prompt": "Select the meaning for “perro”\nperro",
        "accepted_answers": ["dog", "gato"],
        "distractors": [],
    }
    validate_record("exercise", sibling)
    findings = blocking(check_v5([primary, sibling], pos_of=POS))
    assert any("valid alternative translation" in finding.message for finding in findings)


def test_V5_the_pos_clause_reads_every_attested_tag_not_the_first_one() -> None:
    """The oracle is a SET per string, and over real content that is the difference
    between a gate and a wall.

    Measured on the real Spanish course (2026-09-12, `coursekit build es --only g7`):
    **249 blocking POS findings**, every one of them a distractor the rule core had
    already drawn from the answer's own POS bucket. Two causes, one shape:

    * `{row["lemma"]: row["pos"]}` keeps the FIRST row for a lemma with several
      (`prima` is a NOUN and a form of `primar`; `frío` is ADJ and NOUN), and
      `DistractorPool` refuses to decide POS agreement from that map for exactly this
      reason;
    * a `wrong_form` distractor is an attested SURFACE, and looking a surface up in a
      lemma table answers a different question — `viajas` came back PROPN.

    With every attested tag in play the homograph passes and a real cross-POS tile still
    fails, which is what the clause is for.
    """
    from coursekit.validators.exercise import pos_sets

    banded = [
        {"lemma": "prima", "pos": "NOUN", "band": "A1"},
        {"lemma": "prima", "pos": "VERB", "band": "A1"},
        {"lemma": "viajas", "pos": "PROPN", "band": "A1"},
        {"lemma": "perro", "pos": "NOUN", "band": "A1"},
        {"lemma": "correr", "pos": "VERB", "band": "A1"},
    ]
    analysed = [
        {
            "tokens": [
                {"surface": "viajas", "lemma": "viajar", "pos": "VERB"},
                {"surface": "prima", "lemma": "primar", "pos": "VERB"},
                {"surface": "corres", "lemma": "correr", "pos": "VERB"},
            ]
        }
    ]
    attested = pos_sets(banded, analysed)
    assert attested["prima"] == {"NOUN", "VERB"}
    assert attested["viajas"] == {"PROPN", "VERB"}

    # The one-tag map keeps ONE row per lemma and which one is an accident of how it was
    # built: `{row["lemma"]: row["pos"]}` keeps the last, `setdefault` keeps the first.
    # Either way it is a single answer to a question that has two.
    single = {row["lemma"]: row["pos"] for row in banded} | {"corres": "VERB"}
    assert single["prima"] == "VERB" and single["viajas"] == "PROPN"

    verb_answer = {
        **_option_record(["viajas", "prima"], ["corres"]),
        "item_tags": {"lemmas": ["correr"], "grammar_concepts": []},
        "prompt": "Fill in the blank\nTú ____ mucho.",
        "type": "cloze",
    }
    validate_record("exercise", verb_answer)
    # The old oracle blocks `viajas` (PROPN in the ledger, VERB everywhere it is used).
    old = blocking(check_v5([verb_answer], pos_of=single))
    assert [f for f in old if "viajas" in f.message], [f.message for f in old]
    # Every attested tag: the mis-tagged lemma and the homograph both pass.
    assert blocking(check_v5([verb_answer], pos_of=single, attested_pos=attested)) == []

    # And a tile whose tags are disjoint from the answer's is still blocked.
    noun_tile = {**verb_answer, "distractors": ["perro", "prima"]}
    validate_record("exercise", noun_tile)
    findings = blocking(check_v5([noun_tile], pos_of=single, attested_pos=attested))
    assert [f for f in findings if "perro" in f.message], [f.message for f in findings]


def test_V5_the_pos_clause_does_not_apply_to_an_english_option_list() -> None:
    """An English tile has no honest UD tag in a Spanish ledger, and now says so.

    The tiles here are the ones the real course produced — `the`, `not`, `hello` — and
    the Spanish corpus really does contain them: spaCy meets an English word in a
    Spanish sentence and tags it PROPN. Comparing that against a Spanish answer's tag is
    a category error, and it blocked 84 records before the shape table declared which
    option lists are rendered in English.
    """
    from coursekit.validators.exercise import pos_sets

    reverse = {
        **_option_record(["the", "not", "hello"], ["the bread is warm"]),
        "type": "word_bank",
        "prompt": "Write this in English\nEl pan está caliente.",
        "item_tags": {"lemmas": ["pan"], "grammar_concepts": []},
    }
    validate_record("exercise", reverse)
    attested = pos_sets(
        [{"lemma": "pan", "pos": "NOUN", "band": "A1"}],
        [{"tokens": [{"surface": "the", "lemma": "the", "pos": "PROPN"}]}],
    )
    findings = check_v5([reverse], pos_of={"pan": "NOUN"}, attested_pos=attested)
    assert blocking(findings) == [], [f.message for f in findings]
    info = [f for f in findings if f.severity == "info"]
    assert info and info[0].detail["l1_options"] == 3


def test_V5_clean_options_pass() -> None:
    assert blocking(check_v5([_option_record(["gato", "caballo"], ["perro"])], pos_of=POS)) == []


def test_V5_an_uncheckable_pos_is_reported_not_swallowed() -> None:
    """A gloss option list has no entry in the course-language ledger. V5 says so.

    Reported as `info` with a count rather than silently skipped: this project's
    recurring failure is a validator that could not look reporting the same green as
    one that looked and found nothing.

    S034's options are glosses, so they are counted under `l1_options` — the shape
    DECLARES that its options are English (`options_in_l1`) rather than the clause
    inferring it from a failed lookup, which is the distinction the real course forced.
    """
    record = _option_record([], ["perro"])
    record = {
        **record,
        "prompt": "Select the meaning for “perro”\nperro",
        "accepted_answers": ["dog"],
        "distractors": ["cat", "horse"],
    }
    validate_record("exercise", record)
    findings = check_v5([record], pos_of=POS)
    assert blocking(findings) == []
    info = [finding for finding in findings if finding.severity == "info"]
    assert info and info[0].detail["l1_options"] == 2
    assert info[0].detail["unchecked_distractors"] == 0

    # A COURSE-LANGUAGE option list whose strings are in no ledger is the other case,
    # and it is still counted rather than passed: nothing declared these English, the
    # oracle simply has no entry for them.
    unknown = {**_option_record(["xxzz", "yyww"], ["perro"]), "prompt": "Fill in the blank\n____"}
    unknown["type"] = "cloze"
    validate_record("exercise", unknown)
    findings = check_v5([unknown], pos_of=POS)
    info = [finding for finding in findings if finding.severity == "info"]
    assert info and info[0].detail["unchecked_distractors"] == 2
    assert info[0].detail["l1_options"] == 0


# ---------------------------------------------------------------------------
# V6 — INV-PACK-08
# ---------------------------------------------------------------------------


def _record(*, register: str, accepted_answers: list[str]) -> dict[str, Any]:
    """One `translate` record with a chosen register and answer set. V6 reads no more."""
    record = {
        "schema_version": 1,
        "lang": "es",
        "exercise_id": "0000000000000901",
        "unit_index": 1,
        "lesson_index": 1,
        "type": "translate",
        "prompt": "Translate this sentence\nWhat is your name?",
        "accepted_answers": accepted_answers,
        "distractors": [],
        "alignment": [],
        "item_tags": {"lemmas": ["casa"], "grammar_concepts": []},
        "audio_ref": None,
        "register": register,
        "source_sentence_id": None,
    }
    validate_record("exercise", record)
    return record


def test_INV_PACK_08_the_falsifier_is_caught() -> None:
    """[INV-PACK-08] an usted answer in a tú unit is blocked."""
    findings = blocking(check_v6(load("INV-PACK-08", "falsifier"), lang="es"))
    assert len(findings) == 1, findings
    assert findings[0].detail["carried"] == ["usted"]


def test_INV_PACK_08_a_mixed_register_answer_is_caught() -> None:
    """[INV-PACK-08] one answer carrying both registers is blocked too."""
    findings = blocking(check_v6(load("INV-PACK-08", "mixed_register"), lang="es"))
    assert len(findings) == 1, findings
    assert "mixes registers" in findings[0].message


def test_INV_PACK_08_the_repair_passes() -> None:
    """[INV-PACK-08] both tú renderings of the same sentence are accepted."""
    assert blocking(check_v6(load("INV-PACK-08", "repair"), lang="es")) == []


def test_INV_PACK_08_japanese_is_refused_not_passed() -> None:
    """[INV-PACK-08] V6 blocks a language whose script-variant half is not implemented.

    The ja clause — kanji+okurigana, all-kana, katakana and every alternate-okurigana
    headword (EC-GRD-16) — is P7's. Half-implementing it here would report a pass over
    an accepted set that IS the entire tolerance budget (review R24), so V6 refuses.
    """
    records = load("INV-PACK-08", "japanese_half")
    findings = blocking(check_v6(records, lang="ja"))
    assert len(findings) == 1
    assert "docs/owned/p2-g7.json" in findings[0].message
    assert "es" in findings[0].detail["implemented_for"]
    assert "ja" not in V6_IMPLEMENTED_LANGUAGES


def test_register_of_is_lexical_and_accent_insensitive() -> None:
    assert register_of("¿Cómo te llamas?", "es") == {"tu"}
    assert register_of("¿Cómo se llama usted?", "es") == {"usted"}
    assert register_of("La casa es blanca.", "es") == set()
    # `su` is the ordinary third-person possessive and carries NO register; only `tu`
    # here is a marker. This line asserted `{"tu", "usted"}` until a refuter pointed out
    # that `check_v6` then reports a BLOCKING "mixes registers" finding for it.
    assert register_of("Tu casa es su casa.", "es") == {"tu"}


def test_INV_PACK_08_ordinary_third_person_spanish_carries_no_register() -> None:
    """[INV-PACK-08] the V6 false positive that would block every real A1 pack.

    `le`, `les`, `su` and `sus` were in `ES_REGISTER_MARKERS['usted']`. They are the
    third-person clitic and possessive, they appear in ordinary tuteo Spanish, and with
    them listed V6 read `A él le gusta su casa.` as `usted` inside a `tu` unit and
    returned a blocking finding. Any A1 Spanish pack containing `su casa` or `le gusta`
    was unshippable for a reason that is not true.
    """
    assert register_of("A él le gusta su casa.", "es") == set()
    assert register_of("Les doy sus libros.", "es") == set()
    for form in ES_AMBIGUOUS_THIRD_PERSON_FORMS:
        assert register_of(f"Yo {form} veo.", "es") == set(), form
        assert form not in ES_REGISTER_MARKERS["usted"], form
    # And the case the invariant IS about still fails: an explicit usted in a tu unit.
    findings = check_v6(
        [_record(register="tu", accepted_answers=["¿Usted tiene hambre?"])],
        lang="es",
    )
    assert [f for f in findings if f.severity == "blocking"]


def test_INV_PACK_08_a_third_person_answer_passes_v6_in_a_tu_unit() -> None:
    """[INV-PACK-08] the same regression, through the validator rather than the table."""
    findings = check_v6(
        [
            _record(register="tu", accepted_answers=["A él le gusta su casa."]),
            _record(register="tu", accepted_answers=["Tu casa es su casa."]),
        ],
        lang="es",
    )
    assert findings == []


def test_register_of_refuses_a_language_it_has_no_table_for() -> None:
    with pytest.raises(ValueError, match="ja"):
        register_of("引っ越しました", "ja")
