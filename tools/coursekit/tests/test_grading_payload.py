"""Original producer fixtures: evidence joins, never production language approval."""

from __future__ import annotations

import copy
import hashlib
import json

import pytest


def digest(value):
    return hashlib.sha256(
        json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()


def reviewed(row):
    row = {**row, "author": "Fixture author"}
    return {
        **row,
        "review": {
            "reviewer": "Independent fixture reviewer",
            "verdict": "accepted",
            "sha256": digest(row),
        },
    }


def fixture_policy_hash(profile, lessons):
    # Independent JSON fixture construction of the documented normalization contract.
    config = profile["configuration"]
    return digest(
        {
            "normalizationId": "core-grading-lookup-v1",
            "responseLanguage": profile["responseLanguage"],
            "profile": {
                "orthographicEquivalences": config["orthographicEquivalences"],
                "spaceless": config["spaceless"],
                "japaneseNormalisation": config["japaneseNormalisation"],
                "diacriticsContrastive": config["diacriticsContrastive"],
                "contrastiveDiacritics": config["contrastiveDiacritics"],
            },
            "lessons": [
                {
                    "unitId": row["unitId"],
                    "lessonIndex": row["lessonIndex"],
                    "punctuationEquivalenceClass": row["punctuationEquivalenceClass"],
                    "gradedPunctuation": row["gradedPunctuation"],
                }
                for row in lessons
                if row["profileId"] == profile["profileId"]
            ],
        }
    )


def fixture():
    from coursekit.packbuild.grading import DictionaryInput, GradingBuildInputs, surface_id

    words = ("cantar", "contar", "quiero")
    raw = "".join(word + "\n" for word in words).encode()
    provenance = {
        "sourceId": "original-fixture",
        "sourceSha256": hashlib.sha256(raw).hexdigest(),
        "sourceUrl": "https://example.test/original",
        "license": "CC0-1.0",
        "notice": "Original test vocabulary; not a production lexicon.",
        "normalizationId": "core-grading-lookup-v1",
        "normalizationSha256": "2" * 64,
        "policySha256": "3" * 64,
    }
    source = {
        "source_id": "s1",
        "lang": "es",
        "text": "Quiero cantar.",
        "translation": "I want to sing.",
        "unit_index": 1,
        "lesson_index": 1,
        "analysis": {
            "tokens": [
                {"surface": "Quiero", "lemma": "querer", "pos": "VERB", "start": 0, "end": 6},
                {"surface": "cantar", "lemma": "cantar", "pos": "VERB", "start": 7, "end": 13},
            ]
        },
    }
    proof = {
        "sourceSha256": digest(source),
        "runId": "original-fixture-g6",
        "spanish": ["Quiero cantar."],
        "english": ["I want to sing."],
    }
    record = {
        "exercise_id": "ex1",
        "unit_index": 1,
        "lesson_index": 1,
        "type": "translate",
        "prompt": "Translate this sentence\nI want to sing.",
        "accepted_answers": ["Quiero cantar."],
        "source_sentence_id": "s1",
    }
    intro = {"exerciseId": "ex1", "unitId": "u1", "lessonIndex": 1, "when": "wrong-feedback"}
    catalog = [
        reviewed(
            {
                "surfaceId": surface_id("es", "Quiero cantar."),
                "language": "es",
                "surface": "Quiero cantar.",
                "rank": 4,
                "introduction": intro,
                "sourceIds": ["s1"],
            }
        )
    ]
    explanation = reviewed(
        {
            "exerciseId": "ex1",
            "text": "Quiero means I want; cantar is the infinitive to sing.",
            "sourceId": "s1",
        }
    )
    config = {
        "orthographicEquivalences": [],
        "spaceless": False,
        "noWordBoundaries": False,
        "noWordDelimiter": False,
        "readingsBySurface": [],
        "japaneseNormalisation": False,
        "diacriticsContrastive": False,
        "contrastiveDiacritics": ["̃"],
        "typoGuards": {
            "rejectRealTargetWord": True,
            "rejectEditOnTargetLexeme": True,
            "minimumLength": 5,
            "lengthUnit": "characters",
            "preserveMoraCount": False,
        },
        "targetLanguageWords": None,
        "functionClassTokens": ["el"],
        "targetScriptRanges": [[65, 90], [97, 122], [192, 383]],
        "scriptOnlyAnswers": False,
        "wordBankJoinDelimiter": " ",
        "openResponseLengthUnit": "tokens",
        "registerSlot": None,
    }
    lesson = {
        "unitId": "u1",
        "lessonIndex": 1,
        "profileId": "spanish",
        "register": None,
        "punctuationEquivalenceClass": [".", "!", "?"],
        "gradedPunctuation": [],
        "taughtInflections": [{"lexemeId": "lx:cantar:VERB", "surfaces": ["cantar"]}],
        "openResponseMinimumLength": 4,
    }
    draft = {
        "schedulerObjective": reviewed(
            {
                "exerciseId": "ex1",
                "sourceId": "s1",
                "sourceSha256": digest(source),
                "kind": "lexeme",
                "itemRef": "lx:cantar:VERB",
            }
        ),
        "shapeEvidence": {"kind": "simple"},
        "record": record,
        "shapeId": "typed_translate_forward",
        "sourceId": "s1",
        "sourceSha256": digest(source),
        "approvalId": "a1",
        "approvalSha256": digest(proof),
        "profileId": "spanish",
        "responseLanguage": "es",
        "surfaceIds": [catalog[0]["surfaceId"]],
        "schedulerSurfaces": [
            {"itemId": "i_existing", "surfaceId": catalog[0]["surfaceId"], "canonical": True}
        ],
        "gradable": {
            "family": "typed-translate",
            "targetLexemeId": "lx:cantar:VERB",
            "targetLexemeSurface": "cantar",
            "schedulerFacet": "meaning",
        },
        "presentation": {
            "itemId": "i_existing",
            "type": "typedTranslate",
            "instruction": "Translate this sentence",
            "prompt": "I want to sing.",
            "language": "es",
            "promptLanguage": "en",
            "acceptedAnswers": ["Quiero cantar."],
        },
        "explanation": explanation,
    }
    teaching = [
        {
            "exerciseId": "ex1",
            "lexemeId": "lx:cantar:VERB",
            "surface": "cantar",
            "sourceId": "s1",
            "tokenIndex": 1,
            "unitId": "u1",
            "lessonIndex": 1,
        }
    ]
    provenance["policySha256"] = fixture_policy_hash(
        {"profileId": "spanish", "responseLanguage": "es", "configuration": config}, [lesson]
    )
    return GradingBuildInputs(
        identity={"packId": "original", "courseId": "en-es", "version": "1.0.0", "lang": "es"},
        units=[{"unit_id": "u1", "unit_index": 1, "grammar_concept": "g1"}],
        lexemes=[{"lexeme_id": "lx:cantar:VERB", "lemma": "cantar", "pos": "VERB"}],
        exercise_tags=[
            {"exercise_id": "ex1", "item_kind": "lexeme", "item_ref": "cantar", "is_new": 1}
        ],
        exercises=[
            {
                "exercise_id": "ex1",
                "item_id": "i_existing",
                "type": "translate",
                "unit_id": "u1",
                "lesson_index": 1,
                "prompt": record["prompt"],
                "accepted_answers_json": json.dumps(record["accepted_answers"]),
                "slot_index": 1,
                "preferred_surface": "Quiero cantar.",
                "register": "neutral",
                "distractors_json": "[]",
                "alignment_json": "[]",
                "ruby_json": None,
                "illustration_ref": None,
                "audio_id": None,
                "source_sentence_id": None,
            }
        ],
        profiles=[{"profileId": "spanish", "responseLanguage": "es", "configuration": config}],
        lessons=[lesson],
        drafts=[draft],
        sources={"s1": source},
        approvals={"a1": proof},
        surface_catalog=catalog,
        teaching=teaching,
        dictionaries=[
            DictionaryInput(
                "spanish",
                provenance,
                len(words),
                hashlib.sha256(raw).hexdigest(),
                lambda: iter(words),
                lambda: iter([raw]),
            )
        ],
        approval_check=lambda source, proof: (
            proof
            == {
                "sourceSha256": digest(source),
                "runId": "original-fixture-g6",
                "spanish": ["Quiero cantar."],
                "english": ["I want to sing."],
            }
        ),
    )


def test_INV_GRD_22_producer_preserves_real_ids_catalog_rank_and_exact_taught_forms():
    from coursekit.packbuild.grading import build_grading_payload

    inputs = fixture()
    payload = build_grading_payload(inputs)
    item = payload.runtime_items[0]
    assert item["itemId"] == "i_existing"
    assert item["gradable"]["accepted"][0]["rank"] == 4
    assert item["introductions"] == [
        {
            "surfaceId": inputs.surface_catalog[0]["surfaceId"],
            "surface": "Quiero cantar.",
            "language": "es",
            "when": "wrong-feedback",
        }
    ]
    assert item["presentation"]["prompt"] == "I want to sing."
    assert item["explanation"] == inputs.drafts[0]["explanation"]["text"]
    declaration = payload.metadata["profiles"][0]["configuration"]["targetLanguageWords"]
    assert declaration["kind"] == "table" and declaration["count"] == 3
    assert list(payload.word_rows()) == [("spanish", w) for w in ("cantar", "contar", "quiero")]


@pytest.mark.parametrize(
    "fault",
    [
        "source",
        "source-hash",
        "approval",
        "approval-hash",
        "approval-denied",
        "rank",
        "introduction",
        "explanation",
        "unreviewed",
        "future-form",
        "target-id",
        "wrong-accepted",
        "wrong-profile",
        "extra-exercise",
        "draft-shape",
    ],
)
def test_INV_PACK_12_missing_or_stale_production_evidence_fails_by_name(fault):
    from coursekit.packbuild.grading import GradingBuildError, build_grading_payload

    inputs = fixture()
    if fault == "source":
        inputs.sources.clear()
    if fault == "source-hash":
        inputs.sources["s1"]["text"] = "Otra frase."
    if fault == "approval":
        inputs.approvals.clear()
    if fault == "approval-hash":
        inputs.approvals["a1"]["runId"] = "stale"
    if fault == "approval-denied":
        inputs.approval_check = lambda source, proof: False
    if fault == "rank":
        del inputs.surface_catalog[0]["rank"]
    if fault == "introduction":
        inputs.surface_catalog[0]["introduction"]["exerciseId"] = "absent"
    if fault == "explanation":
        del inputs.drafts[0]["explanation"]
    if fault == "unreviewed":
        inputs.surface_catalog[0]["review"]["reviewer"] = "Fixture author"
    if fault == "future-form":
        inputs.teaching[0]["lessonIndex"] = 2
    if fault == "target-id":
        inputs.drafts[0]["gradable"]["targetLexemeId"] = "cantar"
    if fault == "wrong-accepted":
        inputs.drafts[0]["record"]["accepted_answers"] = ["Wrong."]
    if fault == "wrong-profile":
        inputs.drafts[0]["responseLanguage"] = "en"
    if fault == "extra-exercise":
        inputs.exercises.append({**inputs.exercises[0], "exercise_id": "unbound"})
    if fault == "draft-shape":
        inputs.drafts[0]["shapeId"] = "invented"
    with pytest.raises(GradingBuildError):
        build_grading_payload(inputs)


@pytest.mark.parametrize(
    "fault",
    [
        "raw-hash",
        "normalized-hash",
        "count",
        "unsorted",
        "duplicate",
        "empty",
        "normalizer-missing",
    ],
)
def test_INV_GRD_02_real_dictionary_integrity_is_not_a_fixture_fallback(fault):
    from coursekit.packbuild.grading import GradingBuildError, build_grading_payload

    inputs = fixture()
    dictionary = inputs.dictionaries[0]
    if fault == "raw-hash":
        dictionary.source_chunks = lambda: iter([b"changed"])
    if fault == "normalized-hash":
        dictionary.sha256 = "f" * 64
    if fault == "count":
        dictionary.count = 1
    if fault == "unsorted":
        dictionary.surfaces = lambda: iter(["quiero", "cantar", "contar"])
    if fault == "duplicate":
        dictionary.surfaces = lambda: iter(["cantar", "cantar", "contar"])
    if fault == "empty":
        dictionary.surfaces = lambda: iter([])
    if fault == "normalizer-missing":
        del dictionary.provenance["normalizationSha256"]
    with pytest.raises(GradingBuildError, match="dictionary"):
        build_grading_payload(inputs)


def test_INV_GRD_22_future_catalog_surface_is_not_preintroduced():
    from coursekit.packbuild.grading import build_grading_payload

    inputs = fixture()
    inputs.surface_catalog[0] = reviewed(
        {
            k: v
            for k, v in inputs.surface_catalog[0].items()
            if k not in {"review", "author", "introduction"}
        }
        | {"introduction": None}
    )
    assert build_grading_payload(inputs).runtime_items[0]["introductions"] == []


@pytest.mark.parametrize(
    "shape,expected",
    [
        ("tap_what_you_hear", "listenTapWhatYouHear"),
        ("type_what_you_hear", "listenTypeWhatYouHear"),
        ("type_the_word_ending", "typeWordEnding"),
        ("read_and_respond", "readAndRespond"),
        ("listen_and_respond", "listenAndRespond"),
    ],
)
def test_INV_SESS_09_producer_emits_actual_registered_presentation_types(shape, expected):
    from coursekit.packbuild.grading import SHAPES

    assert SHAPES[shape][1] == expected


def test_INV_GRD_22_reserve_analysis_cannot_create_a_taught_inflection():
    from coursekit.packbuild.grading import GradingBuildError, build_grading_payload

    inputs = fixture()
    inputs.sources["reserve"] = copy.deepcopy(inputs.sources["s1"])
    inputs.sources["reserve"]["source_id"] = "reserve"
    inputs.teaching[0]["sourceId"] = "reserve"
    with pytest.raises(GradingBuildError, match="teaching.*selected|teaching.*presented"):
        build_grading_payload(inputs)


@pytest.mark.parametrize(
    "fault", ["empty-surface", "wrong-facet", "word-bank", "gap", "match", "select"]
)
def test_INV_PACK_12_nested_runtime_fields_cannot_bypass_evidence(fault):
    from coursekit.packbuild.grading import GradingBuildError, build_grading_payload

    inputs = fixture()
    draft = inputs.drafts[0]
    if fault == "empty-surface":
        draft["gradable"]["targetLexemeSurface"] = ""
    if fault == "wrong-facet":
        draft["gradable"]["schedulerFacet"] = "invented"
    if fault == "word-bank":
        draft["shapeId"] = "word_bank_forward"
        draft["gradable"] = {
            "family": "word-bank",
            "tiles": [{"tileId": "t1", "text": "Quiero cantar."}],
        }
        draft["presentation"].update(
            type="wordBankTranslate", bank=[{"id": "t1", "text": "Something else"}]
        )
    if fault == "gap":
        draft["shapeId"] = "fill_in_the_blank"
        draft["gradable"] = {
            "family": "gap-fill",
            "gaps": [
                {
                    "gapId": "g1",
                    "accepted": [{"surface": "injected", "surfaceId": "unknown", "rank": 1}],
                }
            ],
        }
        draft["presentation"]["type"] = "gapFillSelect"
    if fault == "match":
        draft["shapeId"] = "match_pairs"
        draft["gradable"] = {
            "family": "match",
            "pairs": [
                {
                    "leftLexemeId": "unknown",
                    "rightLexemeId": "unknown",
                    "left": "x",
                    "right": "y",
                    "facet": "meaning",
                }
            ],
        }
        draft["presentation"].update(
            type="matchPairs",
            pairs=[
                {"leftItemId": "unknown", "leftId": "x", "rightId": "y", "left": "x", "right": "y"}
            ],
        )
    if fault == "select":
        draft["shapeId"] = "meaning_select"
        draft["gradable"] = {"family": "select"}
        draft["presentation"].update(
            type="meaningSelect", options=[{"id": "x", "text": "not accepted"}]
        )
    with pytest.raises(GradingBuildError):
        build_grading_payload(inputs)


def rewrite_answers(inputs, answers, body, *, source=None):
    """Author a new original fixture; no production strings or cached reviews."""
    from coursekit.packbuild.grading import surface_id

    draft = inputs.drafts[0]
    if source is not None:
        inputs.sources["s1"] = source
        proof = {
            "sourceSha256": digest(source),
            "runId": "new-original-fixture",
            "spanish": [source["text"]],
            "english": [source["translation"]],
        }
        inputs.approvals["a1"] = proof
        draft.update(sourceSha256=digest(source), approvalSha256=digest(proof))
        expected = copy.deepcopy(proof)
        inputs.approval_check = lambda actual, approved: actual == source and approved == expected
    inputs.surface_catalog[:] = [
        reviewed(
            {
                "surfaceId": surface_id("es", answer),
                "language": "es",
                "surface": answer,
                "rank": 3,
                "introduction": None,
                "sourceIds": ["s1"],
            }
        )
        for answer in answers
    ]
    draft["surfaceIds"] = [row["surfaceId"] for row in inputs.surface_catalog]
    draft["schedulerSurfaces"] = [
        {"itemId": "i_existing", "surfaceId": row["surfaceId"], "canonical": i == 0}
        for i, row in enumerate(inputs.surface_catalog)
    ]
    draft["record"].update(accepted_answers=answers, prompt="Original exercise\n" + body)
    draft["presentation"].update(
        acceptedAnswers=answers, instruction="Original exercise", prompt=body
    )
    inputs.exercises[0].update(
        accepted_answers_json=json.dumps(answers), prompt=draft["record"]["prompt"]
    )
    inputs.teaching.clear()
    inputs.lessons[0]["taughtInflections"] = []


def word_bank_fixture():
    inputs = fixture()
    draft = inputs.drafts[0]
    draft["shapeId"] = "word_bank_forward"
    draft["record"]["type"] = inputs.exercises[0]["type"] = "word_bank"
    draft["gradable"] = {
        "family": "word-bank",
        "tiles": [
            {"tileId": "t1", "text": "Quiero"},
            {"tileId": "t2", "text": "cantar."},
            {"tileId": "t3", "text": "Quiero"},
        ],
    }
    draft["presentation"].update(
        type="wordBankTranslate",
        bank=[{"id": t["tileId"], "text": t["text"]} for t in draft["gradable"]["tiles"]],
    )
    draft["shapeEvidence"] = {
        "kind": "word-bank",
        "solutions": [{"surfaceId": draft["surfaceIds"][0], "tileIds": ["t1", "t2"]}],
    }
    return inputs


def test_INV_GRD_04_word_bank_preserves_duplicate_occurrences_and_exact_solution_ids():
    from coursekit.packbuild.grading import build_grading_payload

    payload = build_grading_payload(word_bank_fixture())
    assert payload.runtime_items[0]["gradable"]["tiles"] == [
        {"tileId": "t1", "text": "Quiero"},
        {"tileId": "t2", "text": "cantar."},
        {"tileId": "t3", "text": "Quiero"},
    ]


@pytest.mark.parametrize(
    "fault",
    ["unknown-tile", "duplicate-occurrence", "wrong-order", "missing-solution", "wrong-visible-id"],
)
def test_INV_GRD_04_word_bank_cannot_accept_unconstructible_or_reused_tile_solution(fault):
    from coursekit.packbuild.grading import GradingBuildError, build_grading_payload

    inputs = word_bank_fixture()
    draft = inputs.drafts[0]
    solution = draft["shapeEvidence"]["solutions"][0]
    if fault == "unknown-tile":
        solution["tileIds"] = ["unknown", "t2"]
    if fault == "duplicate-occurrence":
        solution["tileIds"] = ["t1", "t1", "t2"]
    if fault == "wrong-order":
        solution["tileIds"] = ["t2", "t1"]
    if fault == "missing-solution":
        draft["shapeEvidence"]["solutions"] = []
    if fault == "wrong-visible-id":
        draft["presentation"]["bank"][0]["id"] = "x"
    with pytest.raises(GradingBuildError, match="word bank"):
        build_grading_payload(inputs)


def gap_fixture():
    inputs = fixture()
    rewrite_answers(inputs, ["cantar"], "Quiero ____.")
    draft = inputs.drafts[0]
    draft.update(
        shapeId="fill_in_the_blank",
        shapeEvidence={
            "kind": "gap-fill",
            "template": "Quiero ____.",
            "gapIds": ["g1"],
            "sourceSpan": {"start": 7, "end": 13},
        },
    )
    draft["record"]["type"] = inputs.exercises[0]["type"] = "cloze"
    form = inputs.surface_catalog[0]
    draft["gradable"] = {
        "family": "gap-fill",
        "gaps": [
            {"gapId": "g1", "accepted": [{k: form[k] for k in ("surfaceId", "surface", "rank")}]}
        ],
    }
    draft["presentation"].update(
        type="gapFillSelect",
        options=[{"id": "o1", "text": "cantar"}, {"id": "o2", "text": "contar"}],
    )
    draft["record"]["distractors"] = ["contar"]
    inputs.exercises[0]["distractors_json"] = json.dumps(["contar"])
    return inputs


def test_INV_GRD_05_gap_reconstructs_the_exact_approved_source_and_keeps_rank():
    from coursekit.packbuild.grading import build_grading_payload

    row = build_grading_payload(gap_fixture()).runtime_items[0]
    assert row["gradable"]["gaps"][0]["accepted"][0]["surface"] == "cantar"
    assert row["gradable"]["gaps"][0]["accepted"][0]["rank"] == 3


@pytest.mark.parametrize(
    "fault",
    ["source-span", "template", "gap-order", "rank", "second-valid-option", "unknown-distractor"],
)
def test_INV_GRD_05_gap_proof_is_bound_to_source_span_and_visible_options(fault):
    from coursekit.packbuild.grading import GradingBuildError, build_grading_payload

    inputs = gap_fixture()
    draft = inputs.drafts[0]
    if fault == "source-span":
        draft["shapeEvidence"]["sourceSpan"]["start"] = 8
    if fault == "template":
        draft["shapeEvidence"]["template"] = "No quiero ____."
    if fault == "gap-order":
        draft["shapeEvidence"]["gapIds"] = ["other"]
    if fault == "rank":
        draft["gradable"]["gaps"][0]["accepted"][0]["rank"] = 99
    if fault == "second-valid-option":
        draft["presentation"]["options"].append({"id": "o3", "text": "cantar"})
    if fault == "unknown-distractor":
        draft["presentation"]["options"][1]["text"] = "new"
    with pytest.raises(GradingBuildError):
        build_grading_payload(inputs)


def test_INV_PACK_12_dictionary_changed_after_assembly_rejects_before_transaction_commit():
    from coursekit.packbuild.grading import GradingBuildError, build_grading_payload

    inputs = fixture()
    source = [b"cantar\ncontar\nquiero\n"]
    inputs.dictionaries[0].source_chunks = lambda: iter(source)
    payload = build_grading_payload(inputs)
    source[0] = b"changed source"
    with pytest.raises(GradingBuildError, match="raw source"):
        list(payload.word_rows())


@pytest.mark.parametrize(
    "fault",
    [
        "register-missing-detector",
        "register-malformed",
        "punctuation-overlap",
        "non-character-mark",
    ],
)
def test_INV_GRD_15_producer_policy_must_round_trip_the_closed_runtime_contract(fault):
    from coursekit.packbuild.grading import GradingBuildError, build_grading_payload

    inputs = fixture()
    config = inputs.profiles[0]["configuration"]
    if fault == "register-missing-detector":
        inputs.lessons[0]["register"] = "tu"
    if fault == "register-malformed":
        config["registerSlot"] = {"invented": True}
    if fault == "punctuation-overlap":
        inputs.lessons[0]["gradedPunctuation"] = ["."]
    if fault == "non-character-mark":
        config["contrastiveDiacritics"] = ["abc"]
    with pytest.raises(GradingBuildError):
        build_grading_payload(inputs)


def english_reverse_fixture():
    from coursekit.packbuild.grading import DictionaryInput, surface_id

    inputs = fixture()
    rewrite_answers(inputs, ["I want to sing."], "Quiero cantar.")
    draft = inputs.drafts[0]
    draft.update(shapeId="typed_translate_reverse", responseLanguage="en", profileId="english")
    draft["record"]["type"] = inputs.exercises[0]["type"] = "reverse_translate"
    draft["gradable"] = {"family": "typed-translate"}
    draft["presentation"].update(language="en", promptLanguage="es")
    surface = reviewed(
        {
            "surfaceId": surface_id("en", "I want to sing."),
            "language": "en",
            "surface": "I want to sing.",
            "rank": 2,
            "introduction": None,
            "sourceIds": ["s1"],
        }
    )
    canonical = reviewed(
        {
            "surfaceId": surface_id("es", "Quiero cantar."),
            "language": "es",
            "surface": "Quiero cantar.",
            "rank": 4,
            "introduction": None,
            "sourceIds": ["s1"],
        }
    )
    inputs.surface_catalog[:] = [surface, canonical]
    draft["surfaceIds"] = [surface["surfaceId"]]
    draft["schedulerSurfaces"] = [
        {"itemId": "i_existing", "surfaceId": canonical["surfaceId"], "canonical": True}
    ]
    inputs.profiles[0].update(profileId="english", responseLanguage="en")
    inputs.profiles[0]["configuration"]["contrastiveDiacritics"] = []
    inputs.lessons[0]["profileId"] = "english"
    raw = b"sing\nwant\n"
    provenance = {
        **inputs.dictionaries[0].provenance,
        "sourceId": "original-english-fixture",
        "sourceSha256": hashlib.sha256(raw).hexdigest(),
    }
    provenance["policySha256"] = fixture_policy_hash(inputs.profiles[0], inputs.lessons)
    inputs.dictionaries[:] = [
        DictionaryInput(
            "english",
            provenance,
            2,
            hashlib.sha256(raw).hexdigest(),
            lambda: iter(["sing", "want"]),
            lambda: iter([raw]),
        )
    ]
    return inputs


def test_INV_GRD_15_english_reverse_profile_uses_its_own_answer_and_word_evidence():
    from coursekit.packbuild.grading import build_grading_payload, surface_id

    inputs = english_reverse_fixture()
    payload = build_grading_payload(inputs)
    assert payload.runtime_items[0]["schedulerSurfaces"] == [
        {
            "itemId": "i_existing",
            "kind": "lexeme",
            "itemRef": "lx:cantar:VERB",
            "surfaceId": surface_id("es", "Quiero cantar."),
            "surface": "Quiero cantar.",
            "language": "es",
            "canonical": True,
        }
    ]
    assert payload.runtime_items[0]["responseLanguage"] == "en"
    assert payload.runtime_items[0]["gradable"]["accepted"][0]["surface"] == "I want to sing."
    assert list(payload.word_rows()) == [("english", "sing"), ("english", "want")]


def test_INV_GRD_22_open_response_requires_exact_taught_keyword_identity():
    from coursekit.packbuild.grading import GradingBuildError, build_grading_payload

    inputs = fixture()
    draft = inputs.drafts[0]
    draft["shapeId"] = "read_and_respond"
    draft["record"]["type"] = inputs.exercises[0]["type"] = "speak"
    draft["gradable"] = {
        "family": "read-and-respond",
        "prompt": "I want to sing.",
        "requiredLexemeIds": ["lx:cantar:VERB"],
    }
    draft["presentation"]["type"] = "readAndRespond"
    assert build_grading_payload(inputs).runtime_items[0]["gradable"]["requiredLexemeIds"] == [
        "lx:cantar:VERB"
    ]
    inputs.teaching.clear()
    inputs.lessons[0]["taughtInflections"] = []
    with pytest.raises(GradingBuildError, match="open response"):
        build_grading_payload(inputs)


@pytest.mark.parametrize("missing", ["introduction", "rank", "sourceIds"])
def test_INV_GRD_27_absence_is_not_an_implicit_catalog_default(missing):
    from coursekit.packbuild.grading import GradingBuildError, build_grading_payload

    inputs = fixture()
    del inputs.surface_catalog[0][missing]
    with pytest.raises(GradingBuildError, match="surface rank/introduction"):
        build_grading_payload(inputs)


def test_INV_PACK_12_malformed_nested_inputs_fail_as_named_evidence_error():
    from coursekit.packbuild.grading import GradingBuildError, build_grading_payload

    inputs = fixture()
    inputs.drafts[0]["record"] = None
    with pytest.raises(GradingBuildError, match="malformed grading input"):
        build_grading_payload(inputs)


def match_fixture():
    inputs = fixture()
    names = [
        ("gato", "cat"),
        ("perro", "dog"),
        ("casa", "house"),
        ("libro", "book"),
        ("mesa", "table"),
    ]
    inputs.drafts[0].pop("schedulerObjective")
    inputs.exercise_tags[:] = [
        {"exercise_id": "ex1", "item_kind": "lexeme", "item_ref": left, "is_new": 1}
        for left, _ in names
    ]
    inputs.lexemes[:] = [
        {"lexeme_id": "lx:" + left + ":NOUN", "lemma": left, "pos": "NOUN"} for left, _ in names
    ]
    pairs = [
        {
            "leftLexemeId": row["lexeme_id"],
            "rightLexemeId": row["lexeme_id"],
            "left": left,
            "right": right,
            "facet": "meaning",
        }
        for row, (left, right) in zip(inputs.lexemes, names, strict=True)
    ]
    source = {
        "source_id": "s1",
        "lang": "es",
        "text": ", ".join(left for left, _ in names),
        "translation": ", ".join(right for _, right in names),
        "unit_index": 1,
        "lesson_index": 1,
        "analysis": {"tokens": []},
        "reviewedGlossPairs": pairs,
    }
    rewrite_answers(
        inputs,
        [left + " = " + right for left, right in names],
        ", ".join(left for left, _ in names),
        source=source,
    )
    draft = inputs.drafts[0]
    proof = {**inputs.approvals["a1"], "pairs": copy.deepcopy(pairs)}
    inputs.approvals["a1"] = proof
    draft["approvalSha256"] = digest(proof)
    expected = copy.deepcopy(proof)
    inputs.approval_check = lambda actual, approved: actual == source and approved == expected
    draft.update(
        shapeId="match_pairs",
        shapeEvidence={"kind": "match"},
        gradable={"family": "match", "pairs": pairs},
    )
    draft["record"]["type"] = inputs.exercises[0]["type"] = "match"
    draft["presentation"].update(
        type="matchPairs",
        pairs=[
            {
                "leftItemId": row["leftLexemeId"],
                "leftId": "ui-left-" + str(i),
                "rightId": "ui-right-" + str(i),
                "left": row["left"],
                "right": row["right"],
            }
            for i, row in enumerate(pairs)
        ],
    )
    draft["explanation"] = reviewed(
        {
            "exerciseId": "ex1",
            "text": (
                "Each Spanish noun is paired with its English meaning: gato means cat, "
                "perro dog, casa house, libro book and mesa table."
            ),
            "sourceId": "s1",
        }
    )
    from coursekit.packbuild.grading import surface_id

    target_rows = [
        reviewed(
            {
                "surfaceId": surface_id("es", pair["left"]),
                "language": "es",
                "surface": pair["left"],
                "rank": 3,
                "introduction": None,
                "sourceIds": ["s1"],
            }
        )
        for pair in pairs
    ]
    inputs.surface_catalog.extend(target_rows)
    draft["schedulerSurfaces"] = [
        {"itemId": pair["leftLexemeId"], "surfaceId": row["surfaceId"], "canonical": True}
        for pair, row in zip(pairs, target_rows, strict=True)
    ]
    return inputs


def test_INV_GRD_07_match_keeps_semantic_ids_separate_from_visible_occurrence_ids():
    from coursekit.packbuild.grading import build_grading_payload

    row = build_grading_payload(match_fixture()).runtime_items[0]
    assert len(row["gradable"]["pairs"]) == 5
    assert row["gradable"]["pairs"][0]["leftLexemeId"] == "lx:gato:NOUN"
    assert row["presentation"]["pairs"][0]["leftId"] == "ui-left-0"


def test_INV_PACK_12_match_requires_each_pair_in_current_meaning_approval():
    from coursekit.packbuild.grading import GradingBuildError, build_grading_payload

    inputs = match_fixture()
    proof = inputs.approvals["a1"]
    proof["pairs"] = []
    inputs.drafts[0]["approvalSha256"] = digest(proof)
    expected = copy.deepcopy(proof)
    inputs.approval_check = lambda source, approval: approval == expected
    with pytest.raises(GradingBuildError, match="match.*approval"):
        build_grading_payload(inputs)


@pytest.mark.parametrize("words", [("quiero", "cantar", "contar"), ("cantar", "cantar", "contar")])
def test_INV_PACK_12_self_consistent_dictionary_digest_does_not_prove_sorted_unique_rows(words):
    from coursekit.packbuild.grading import GradingBuildError, build_grading_payload

    inputs = fixture()
    dictionary = inputs.dictionaries[0]
    dictionary.surfaces = lambda: iter(words)
    dictionary.count = len(words)
    dictionary.sha256 = hashlib.sha256("".join(word + "\n" for word in words).encode()).hexdigest()
    with pytest.raises(GradingBuildError, match="duplicate or unsorted"):
        build_grading_payload(inputs)


@pytest.mark.parametrize("fault", ["orthography", "lesson-punctuation"])
def test_INV_GRD_15_normalized_dictionary_proof_is_bound_to_actual_response_policy(fault):
    from coursekit.packbuild.grading import GradingBuildError, build_grading_payload

    inputs = fixture()
    if fault == "orthography":
        inputs.profiles[0]["configuration"]["orthographicEquivalences"] = [["c", "k"]]
    else:
        inputs.lessons[0]["punctuationEquivalenceClass"] = []
    with pytest.raises(GradingBuildError, match="dictionary.*policy"):
        build_grading_payload(inputs)


@pytest.mark.parametrize("field", ["sql", "record"])
def test_INV_PACK_12_runtime_shape_cannot_disagree_with_actual_stored_exercise_type(field):
    from coursekit.packbuild.grading import GradingBuildError, build_grading_payload

    inputs = fixture()
    if field == "sql":
        inputs.exercises[0]["type"] = "match"
    else:
        inputs.drafts[0]["record"]["type"] = "match"
    with pytest.raises(GradingBuildError, match="type"):
        build_grading_payload(inputs)


def set_intro(row, when):
    return reviewed(
        {key: value for key, value in row.items() if key not in {"author", "review"}}
        | {"introduction": {"exerciseId": "ex1", "unitId": "u1", "lessonIndex": 1, "when": when}}
    )


def test_INV_GRD_22_prompt_exposure_may_be_outside_the_response_accepted_forms():
    from coursekit.packbuild.grading import build_grading_payload, surface_id

    inputs = fixture()
    prompt = inputs.drafts[0]["presentation"]["prompt"]
    row = {
        "surfaceId": surface_id("en", prompt),
        "language": "en",
        "surface": prompt,
        "rank": 0,
        "sourceIds": ["s1"],
    }
    inputs.surface_catalog.append(set_intro(row, "prompt"))
    payload = build_grading_payload(inputs)
    assert payload.runtime_items[0]["introductions"][-1] == {
        "surfaceId": surface_id("en", prompt),
        "surface": prompt,
        "language": "en",
        "when": "prompt",
    }


@pytest.mark.parametrize(
    "fault",
    [
        "false-prompt",
        "hidden-alternate",
        "missing-when",
        "unknown-event",
        "missing-prompt-language",
        "wrong-source",
    ],
)
def test_INV_GRD_22_reviewed_catalog_cannot_claim_hidden_or_wrong_context_exposure(fault):
    from coursekit.packbuild.grading import GradingBuildError, build_grading_payload, surface_id

    inputs = fixture()
    row = inputs.surface_catalog[0]
    if fault == "false-prompt":
        row = set_intro(row, "prompt")
    if fault == "hidden-alternate":
        alt = "Yo quiero cantar."
        rewrite_answers(inputs, ["Quiero cantar.", alt], "I want to sing.")
        proof = inputs.approvals["a1"]
        proof["spanish"].append(alt)
        inputs.drafts[0]["approvalSha256"] = digest(proof)
        expected = copy.deepcopy(proof)
        inputs.approval_check = lambda source, actual: actual == expected
        row = set_intro(inputs.surface_catalog[1], "wrong-feedback")
        inputs.surface_catalog[1] = row
    if fault == "missing-when":
        del row["introduction"]["when"]
    if fault == "unknown-event":
        row["introduction"]["when"] = "load"
    if fault == "missing-prompt-language":
        prompt = inputs.drafts[0]["presentation"]["prompt"]
        row = set_intro(
            {
                "surfaceId": surface_id("en", prompt),
                "language": "en",
                "surface": prompt,
                "rank": 0,
                "sourceIds": ["s1"],
            },
            "prompt",
        )
        del inputs.drafts[0]["presentation"]["promptLanguage"]
        inputs.surface_catalog.append(row)
    if fault == "wrong-source":
        inputs.sources["reserve"] = copy.deepcopy(inputs.sources["s1"])
        prompt = inputs.drafts[0]["presentation"]["prompt"]
        row = set_intro(
            {
                "surfaceId": surface_id("en", prompt),
                "language": "en",
                "surface": prompt,
                "rank": 0,
                "sourceIds": ["reserve"],
            },
            "prompt",
        )
        inputs.surface_catalog.append(row)
    if fault not in {"hidden-alternate", "missing-prompt-language", "wrong-source"}:
        inputs.surface_catalog[0] = reviewed(
            {k: v for k, v in row.items() if k not in {"author", "review"}}
        )
    with pytest.raises(GradingBuildError, match="introduction"):
        build_grading_payload(inputs)


@pytest.mark.parametrize("fault", ["distractors", "audio", "source"])
def test_INV_PACK_12_actual_SQL_fields_cannot_diverge_from_approved_runtime_draft(fault):
    from coursekit.packbuild.grading import GradingBuildError, build_grading_payload

    inputs = gap_fixture()
    if fault == "distractors":
        inputs.exercises[0]["distractors_json"] = "[]"
    if fault == "audio":
        inputs.exercises[0]["audio_id"] = "unexpected-clip"
    if fault == "source":
        inputs.exercises[0]["source_sentence_id"] = "different-source"
    with pytest.raises(GradingBuildError, match="actual exercise"):
        build_grading_payload(inputs)


@pytest.mark.parametrize(
    "fault",
    [
        "missing",
        "no-canonical",
        "wrong-item",
        "unknown-surface",
        "wrong-language",
        "wrong-source",
        "unapproved-canonical",
    ],
)
def test_INV_SCH_11_producer_requires_explicit_reviewed_target_surface_mapping(fault):
    from coursekit.packbuild.grading import GradingBuildError, build_grading_payload, surface_id

    inputs = fixture()
    if fault == "missing":
        del inputs.drafts[0]["schedulerSurfaces"]
    if fault == "no-canonical":
        inputs.drafts[0]["schedulerSurfaces"][0]["canonical"] = False
    if fault == "wrong-item":
        inputs.drafts[0]["schedulerSurfaces"][0]["itemId"] = "unknown"
    if fault == "unknown-surface":
        inputs.drafts[0]["schedulerSurfaces"][0]["surfaceId"] = "sf_unknown"
    if fault in {"wrong-language", "wrong-source", "unapproved-canonical"}:
        row = {
            "surfaceId": surface_id(
                "en" if fault == "wrong-language" else "es", "Unapproved text."
            ),
            "language": "en" if fault == "wrong-language" else "es",
            "surface": "Unapproved text.",
            "rank": 4,
            "introduction": None,
            "sourceIds": ["s1"],
        }
        if fault == "wrong-source":
            inputs.sources["reserve"] = copy.deepcopy(inputs.sources["s1"])
            row["sourceIds"] = ["reserve"]
        inputs.surface_catalog.append(reviewed(row))
        inputs.drafts[0]["schedulerSurfaces"][0].update(surfaceId=row["surfaceId"])
    with pytest.raises(GradingBuildError, match="scheduler|runtime draft"):
        build_grading_payload(inputs)


def test_INV_SCH_11_producer_keeps_match_semantic_surface_mappings():
    from coursekit.packbuild.grading import build_grading_payload

    row = build_grading_payload(match_fixture()).runtime_items[0]
    assert [
        (r["itemId"], r["surface"], r["language"], r["canonical"]) for r in row["schedulerSurfaces"]
    ] == [
        ("lx:" + word + ":NOUN", word, "es", True)
        for word in ["gato", "perro", "casa", "libro", "mesa"]
    ]


def test_INV_SCH_11_reverse_canonical_must_have_current_target_language_approval():
    from coursekit.packbuild.grading import GradingBuildError, build_grading_payload, surface_id

    inputs = english_reverse_fixture()
    row = reviewed(
        {
            "surfaceId": surface_id("es", "Texto no aprobado."),
            "surface": "Texto no aprobado.",
            "language": "es",
            "rank": 4,
            "introduction": None,
            "sourceIds": ["s1"],
        }
    )
    inputs.surface_catalog.append(row)
    inputs.drafts[0]["schedulerSurfaces"][0]["surfaceId"] = row["surfaceId"]
    with pytest.raises(GradingBuildError, match="canonical lacks current target-language approval"):
        build_grading_payload(inputs)


@pytest.mark.parametrize("fault", ["language", "source"])
def test_INV_SCH_11_reverse_canonical_keeps_its_exact_target_language_and_source(fault):
    from coursekit.packbuild.grading import GradingBuildError, build_grading_payload, surface_id

    inputs = english_reverse_fixture()
    language = "en" if fault == "language" else "es"
    source = "s1"
    if fault == "source":
        inputs.sources["reserve"] = copy.deepcopy(inputs.sources["s1"])
        source = "reserve"
    row = reviewed(
        {
            "surfaceId": surface_id(language, "Quiero cantar."),
            "surface": "Quiero cantar.",
            "language": language,
            "rank": 4,
            "introduction": None,
            "sourceIds": [source],
        }
    )
    inputs.surface_catalog[:] = [
        r for r in inputs.surface_catalog if r["surfaceId"] != row["surfaceId"]
    ] + [row]
    inputs.drafts[0]["schedulerSurfaces"][0]["surfaceId"] = row["surfaceId"]
    with pytest.raises(
        GradingBuildError, match="scheduler surface: missing/wrong source, target, or language"
    ):
        build_grading_payload(inputs)


def speaking_fixture():
    inputs = fixture()
    draft = inputs.drafts[0]
    draft["shapeId"] = "speak_this_sentence"
    draft["gradable"] = {"family": "speaking"}
    draft["presentation"].update(type="speakSentence", audioRef="a-spoken")
    draft["record"].update(type="speak", audio_ref="a-spoken")
    inputs.exercises[0].update(type="speak", audio_id="a-spoken")
    return inputs


def test_INV_MOD_13_speaking_without_current_approved_analysis_is_unavailable():
    from coursekit.packbuild.grading import GradingBuildError, build_grading_payload

    with pytest.raises(GradingBuildError, match="speech"):
        build_grading_payload(speaking_fixture())


def test_INV_SCH_11_sentence_without_reviewed_primary_objective_cannot_guess_kind():
    from coursekit.packbuild.grading import GradingBuildError, build_grading_payload

    inputs = fixture()
    inputs.drafts[0].pop("schedulerObjective", None)
    with pytest.raises(GradingBuildError, match="objective"):
        build_grading_payload(inputs)


@pytest.mark.parametrize(
    "fault",
    [
        "no-review",
        "self-review",
        "stale-review",
        "wrong-source",
        "stale-source",
        "wrong-exercise",
        "unknown-kind",
        "unknown-ref",
        "wrong-pos",
        "untagged",
        "wrong-tag-kind",
        "not-in-source",
        "no-tags",
    ],
)
def test_INV_SCH_11_scheduler_objective_requires_current_review_and_exact_declarations(fault):
    from coursekit.packbuild.grading import GradingBuildError, build_grading_payload

    inputs = fixture()
    objective = inputs.drafts[0]["schedulerObjective"]
    if fault == "no-review":
        objective.pop("review")
    if fault == "self-review":
        objective["review"]["reviewer"] = objective["author"]
    if fault == "stale-review":
        objective["review"]["sha256"] = "0" * 64
    if fault == "wrong-source":
        objective["sourceId"] = "other"
    if fault == "stale-source":
        objective["sourceSha256"] = "0" * 64
    if fault == "wrong-exercise":
        objective["exerciseId"] = "other"
    if fault == "unknown-kind":
        objective["kind"] = "sentence"
    if fault == "unknown-ref":
        objective["itemRef"] = "unknown"
    if fault == "wrong-pos":
        objective["itemRef"] = "lx:cantar:NOUN"
    if fault == "untagged":
        inputs.exercise_tags[0]["item_ref"] = "querer"
    if fault == "wrong-tag-kind":
        inputs.exercise_tags[0]["item_kind"] = "grammar_concept"
    if fault == "not-in-source":
        inputs.lexemes.append({"lexeme_id": "lx:otro:ADJ", "lemma": "otro", "pos": "ADJ"})
        objective["itemRef"] = "lx:otro:ADJ"
        inputs.exercise_tags[0]["item_ref"] = "otro"
    if fault == "no-tags":
        inputs.exercise_tags = []
    if fault not in {"no-review", "self-review", "stale-review"}:
        inputs.drafts[0]["schedulerObjective"] = reviewed(
            {k: v for k, v in objective.items() if k not in {"author", "review"}}
        )
    with pytest.raises(GradingBuildError, match="objective"):
        build_grading_payload(inputs)


def test_INV_SCH_11_reviewed_grammar_objective_preserves_aggregate_identity():
    from coursekit.packbuild.grading import build_grading_payload

    inputs = fixture()
    inputs.units[0]["grammar_concept"] = "gc:original_concept"
    inputs.exercise_tags.append(
        {
            "exercise_id": "ex1",
            "item_kind": "grammar_concept",
            "item_ref": "gc:original_concept",
            "is_new": 1,
        }
    )
    inputs.drafts[0]["schedulerObjective"] = reviewed(
        {
            "exerciseId": "ex1",
            "sourceId": "s1",
            "sourceSha256": digest(inputs.sources["s1"]),
            "kind": "grammarConcept",
            "itemRef": "gc:original_concept",
        }
    )
    result = build_grading_payload(inputs)
    assert result.runtime_items[0]["schedulerSurfaces"][0] | {} == {
        "itemId": "i_existing",
        "surfaceId": inputs.surface_catalog[0]["surfaceId"],
        "surface": "Quiero cantar.",
        "language": "es",
        "canonical": True,
        "kind": "grammarConcept",
        "itemRef": "gc:original_concept",
    }
    assert result.provenance["exerciseTagsSha256"] == digest(
        sorted(
            inputs.exercise_tags, key=lambda r: (r["exercise_id"], r["item_kind"], r["item_ref"])
        )
    )
    inputs.units[0]["grammar_concept"] = "gc:other"
    from coursekit.packbuild.grading import GradingBuildError

    with pytest.raises(GradingBuildError, match="objective"):
        build_grading_payload(inputs)


def approved_speaking_fixture():
    from test_speech_payload import fixture as source_fixture

    inputs = speaking_fixture()
    data = source_fixture()
    inputs.sources["s1"]["analysis"] = data["source"]["analysis"]
    inputs.approvals["a1"].update(
        sourceSha256=digest(inputs.sources["s1"]), speech=data["approval"]["speech"]
    )
    draft = inputs.drafts[0]
    draft.update(
        sourceSha256=digest(inputs.sources["s1"]), approvalSha256=digest(inputs.approvals["a1"])
    )
    objective = {
        k: v for k, v in draft["schedulerObjective"].items() if k not in {"author", "review"}
    }
    objective["sourceSha256"] = draft["sourceSha256"]
    draft["schedulerObjective"] = reviewed(objective)
    expected = copy.deepcopy(inputs.approvals["a1"])
    inputs.approval_check = lambda source, approval: approval == expected
    return inputs


def test_INV_MOD_13_current_speech_projection_is_consumed_by_real_producer_and_validator():
    from coursekit.packbuild.grading import GradingBuildError, build_grading_payload

    inputs = approved_speaking_fixture()
    payload = build_grading_payload(inputs)
    assert payload.runtime_items[0]["speech"]["references"][0]["tokens"][0]["unit"] == "querer"
    assert (
        payload.runtime_items[0]["speech"]["references"][0]["sourceSha256"]
        == inputs.drafts[0]["sourceSha256"]
    )
    inputs.approval_check = lambda source, approval: False
    with pytest.raises(GradingBuildError, match="current language approval"):
        build_grading_payload(inputs)


def picture_introduction_fixture():
    inputs = fixture()
    source = copy.deepcopy(inputs.sources["s1"])
    source.update(
        text="cantar",
        translation="to sing",
        analysis={
            "tokens": [
                {"surface": "cantar", "lemma": "cantar", "pos": "VERB", "start": 0, "end": 6}
            ]
        },
    )
    rewrite_answers(inputs, ["cantar"], "to sing", source=source)
    draft = inputs.drafts[0]
    draft.update(shapeId="picture_select", gradable={"family": "select"})
    draft["schedulerObjective"] = reviewed(
        {
            "exerciseId": "ex1",
            "sourceId": "s1",
            "sourceSha256": digest(source),
            "kind": "lexeme",
            "itemRef": "lx:cantar:VERB",
        }
    )
    draft["record"].update(type="match", distractors=["contar", "bailar"])
    inputs.exercises[0].update(
        type="match", preferred_surface="cantar", distractors_json=json.dumps(["contar", "bailar"])
    )
    draft["presentation"].update(
        type="pictureSelect",
        introduction="word",
        promptLanguage="en",
        options=[
            {
                "id": id,
                "text": word,
                "imageUri": "original/" + id + ".png",
                "imageDescription": "Original fixture for " + word,
            }
            for id, word in [("correct", "cantar"), ("other1", "contar"), ("other2", "bailar")]
        ],
    )
    row = {k: v for k, v in inputs.surface_catalog[0].items() if k not in {"author", "review"}}
    row["introduction"] = {
        "exerciseId": "ex1",
        "unitId": "u1",
        "lessonIndex": 1,
        "when": "prompt",
        "location": "option",
        "optionId": "correct",
    }
    inputs.surface_catalog[0] = reviewed(row)
    return inputs


def test_INV_SCH_11_picture_new_word_introduces_exact_visible_correct_target_option():
    from coursekit.packbuild.grading import build_grading_payload

    inputs = picture_introduction_fixture()
    row = build_grading_payload(inputs).runtime_items[0]
    assert row["introductions"] == [
        {
            "surfaceId": inputs.surface_catalog[0]["surfaceId"],
            "surface": "cantar",
            "language": "es",
            "when": "prompt",
            "location": "option",
            "optionId": "correct",
        }
    ]
    assert row["presentation"]["prompt"] == "to sing"
    assert row["presentation"]["promptLanguage"] == "en"


@pytest.mark.parametrize(
    "fault",
    [
        "missing-id",
        "wrong-id",
        "distractor-id",
        "missing-marker",
        "grammar-marker",
        "wrong-shape",
        "feedback",
        "unknown-location",
        "grammar-objective",
        "foreign-language",
    ],
)
def test_INV_SCH_11_option_introduction_is_an_exact_declared_new_word_beat(fault):
    from coursekit.packbuild.grading import GradingBuildError, build_grading_payload, surface_id

    inputs = picture_introduction_fixture()
    draft = inputs.drafts[0]
    row = {k: v for k, v in inputs.surface_catalog[0].items() if k not in {"author", "review"}}
    intro = row["introduction"]
    if fault == "missing-id":
        del intro["optionId"]
    if fault == "wrong-id":
        intro["optionId"] = "missing"
    if fault == "distractor-id":
        intro["optionId"] = "other1"
    if fault == "missing-marker":
        del draft["presentation"]["introduction"]
    if fault == "grammar-marker":
        draft["presentation"]["introduction"] = "grammar"
    if fault == "wrong-shape":
        draft["shapeId"] = "meaning_select"
        draft["presentation"]["type"] = "meaningSelect"
    if fault == "feedback":
        intro["when"] = "wrong-feedback"
    if fault == "unknown-location":
        intro["location"] = "answer-cache"
    if fault == "grammar-objective":
        inputs.exercise_tags.append(
            {"exercise_id": "ex1", "item_kind": "grammar_concept", "item_ref": "g1", "is_new": 1}
        )
        draft["schedulerObjective"] = reviewed(
            {
                "exerciseId": "ex1",
                "sourceId": "s1",
                "sourceSha256": draft["sourceSha256"],
                "kind": "grammarConcept",
                "itemRef": "g1",
            }
        )
    if fault == "foreign-language":
        original = {**row, "introduction": None}
        inputs.surface_catalog[0] = reviewed(original)
        row.update(language="en", surfaceId=surface_id("en", "cantar"))
        inputs.surface_catalog.append(reviewed(row))
    else:
        inputs.surface_catalog[0] = reviewed(row)
    with pytest.raises(GradingBuildError, match="introduction"):
        build_grading_payload(inputs)


def test_INV_SCH_11_orphan_option_id_does_not_turn_a_legacy_prompt_into_an_option_witness():
    from coursekit.packbuild.grading import GradingBuildError, build_grading_payload, surface_id

    inputs = fixture()
    prompt = inputs.drafts[0]["presentation"]["prompt"]
    row = {
        "surfaceId": surface_id("en", prompt),
        "language": "en",
        "surface": prompt,
        "rank": 0,
        "sourceIds": ["s1"],
        "introduction": {
            "exerciseId": "ex1",
            "unitId": "u1",
            "lessonIndex": 1,
            "when": "prompt",
            "optionId": "unbound",
        },
    }
    inputs.surface_catalog.append(reviewed(row))
    with pytest.raises(GradingBuildError, match="introduction"):
        build_grading_payload(inputs)
