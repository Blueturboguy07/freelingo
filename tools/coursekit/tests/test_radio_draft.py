"""Explicit original token/pack plans, not approvals of authored Spanish episodes."""

import pytest
from test_radio_compiler import prepare, source_fixture
from test_radio_targets import digest

from coursekit.narratives.compiler import NarrativeError
from coursekit.packbuild.itemid import item_id


def inputs():
    from coursekit.narratives.radio import radio_preparation_hash
    from coursekit.narratives.targets import RadioPackTargets

    source = source_fixture()
    source["segments"][1]["text"] = "café pan."
    prepared = prepare(source)
    values = {}
    refs = []
    for i, word in enumerate(["café", "pan", "agua", "queso"]):
        sid = "sf_" + digest(["es", word])[:32]
        iid = "i_original" + str(i)
        eid = "ex" + str(i)
        ref = {"exerciseId": eid, "schedulerItemId": iid, "surfaceId": sid}
        refs.append(ref)
        semantic = {
            "prompt": word + " original test meaning",
            "preferredSurface": word,
            "register": "neutral",
            "lexemes": [word],
            "grammarConcepts": [],
            "graphemes": [],
        }
        lexical = {
            "schedulerItemId": iid,
            "surfaceId": sid,
            "surface": word,
            "language": "es",
            "lexemeId": "lx:" + word + ":NOUN",
            "lemma": word,
            "pos": "NOUN",
            "wordItemId": item_id(semantic),
            "semantic": semantic,
            "countable": True,
            "classification": "word",
            "proof": {
                "sourceId": "original",
                "sourceSha256": "1" * 64,
                "declarationSha256": "2" * 64,
                "bindingSha256": "3" * 64,
            },
        }
        values[(eid, iid, sid)] = {
            "exerciseId": eid,
            "runtimeSha256": "4" * 64,
            "sourceProof": {
                "sourceId": "original",
                "sourceSha256": "1" * 64,
                "approvalId": "approved-original",
                "approvalSha256": "5" * 64,
                "draftSha256": "6" * 64,
            },
            "unitIndex": 1,
            "lexical": lexical,
            "scheduler": {
                "itemId": iid,
                "kind": "lexeme",
                "itemRef": lexical["lexemeId"],
                "surfaceId": sid,
                "surface": word,
                "language": "es",
                "canonical": True,
            },
        }
    targets = RadioPackTargets("a" * 64, "es", values)
    tiles = []
    for i, word in enumerate(["café", "pan", "agua", "queso"]):
        occurrence = {"segmentId": "s2", "tokenIndex": i} if i < 2 else None
        tiles.append({"lemma": word, "target": refs[i], "occurrence": occurrence})
    plan = {
        "schemaVersion": 1,
        "sourceSha256": prepared.source_hash,
        "preparationSha256": radio_preparation_hash(prepared),
        "packSha256": "a" * 64,
        "author": "Original plan author",
        "introEndSegment": "s1",
        "questions": [{"id": "q1", "listenFromSegment": "s2", "tiles": tiles}],
    }
    return prepared, plan, targets


def test_INV_STO_10_draft_preserves_declared_word_identity_and_exact_occurrence():
    from coursekit.narratives.radio_draft import compile_radio_draft

    prepared, plan, targets = inputs()
    draft = compile_radio_draft(prepared, plan, targets)
    q = draft.content["questions"][0]
    assert q["afterSegment"] == "s2" and q["count"] == 2 and len(q["correctTileIds"]) == 2
    assert [t["text"] for t in q["tiles"]] == ["café", "pan", "agua", "queso"]
    assert q["tiles"][0]["itemIds"] == ["i_original0"]
    assert q["tiles"][0]["tokenId"] == "s2:0"
    assert draft.evidence["targets"][0]["lexical"]["wordItemId"] != q["tiles"][0]["itemIds"][0]
    assert "audio" not in draft.content and "atMs" not in q
    assert draft.requires == ("review", "curriculum-validation", "audio")


@pytest.mark.parametrize(
    "fault",
    [
        "source-hash",
        "analysis-hash",
        "pack-hash",
        "wrong-intro",
        "intro-crosses-question",
        "missing-question",
        "extra-question",
        "unknown-question",
        "wrong-window",
        "future-window",
        "missing-occurrence",
        "future-occurrence",
        "wrong-occurrence",
        "wrong-surface",
        "wrong-lemma",
        "wrong-pos",
        "future-target",
        "excluded-target",
        "countable-forgery",
        "heard-distractor",
        "wrong-reference",
        "extra-plan-field",
        "mutated-source",
    ],
)
def test_INV_STO_06_draft_refuses_unproved_target_window_or_source_plan(fault):
    from coursekit.narratives.radio import radio_preparation_hash
    from coursekit.narratives.radio_draft import compile_radio_draft

    prepared, plan, targets = inputs()
    q = plan["questions"][0]
    if fault == "source-hash":
        plan["sourceSha256"] = "0" * 64
    if fault == "analysis-hash":
        plan["preparationSha256"] = "0" * 64
    if fault == "pack-hash":
        plan["packSha256"] = "0" * 64
    if fault == "wrong-intro":
        plan["introEndSegment"] = "missing"
    if fault == "intro-crosses-question":
        plan["introEndSegment"] = "s3"
    if fault == "missing-question":
        plan["questions"] = []
    if fault == "extra-question":
        plan["questions"] *= 2
    if fault == "unknown-question":
        q["id"] = "unknown"
    if fault == "wrong-window":
        q["listenFromSegment"] = "missing"
    if fault == "future-window":
        q["listenFromSegment"] = "s3"
    if fault == "missing-occurrence":
        q["tiles"][0]["occurrence"] = None
    if fault == "future-occurrence":
        q["tiles"][0]["occurrence"] = {"segmentId": "s3", "tokenIndex": 0}
    if fault == "wrong-occurrence":
        q["tiles"][0]["occurrence"]["tokenIndex"] = 1
    if fault == "wrong-surface":
        next(iter(targets._targets.values()))["lexical"]["surface"] = "cafés"
    if fault == "wrong-lemma":
        q["tiles"][0]["lemma"] = "wrong"
    if fault == "wrong-pos":
        next(iter(targets._targets.values()))["lexical"]["pos"] = "VERB"
    if fault == "future-target":
        next(iter(targets._targets.values()))["unitIndex"] = 3
    if fault == "excluded-target":
        next(iter(targets._targets.values()))["lexical"]["classification"] = "particle"
    if fault == "countable-forgery":
        next(iter(targets._targets.values()))["lexical"]["countable"] = 1
    if fault == "heard-distractor":
        source = source_fixture()
        source["segments"][1]["text"] = "café pan agua."
        prepared = prepare(source)
        plan["sourceSha256"] = prepared.source_hash
        plan["preparationSha256"] = radio_preparation_hash(prepared)
    if fault == "wrong-reference":
        q["tiles"][0]["target"]["schedulerItemId"] = "unknown"
    if fault == "extra-plan-field":
        plan["inferTargets"] = True
    if fault == "mutated-source":
        prepared.source["segments"][1]["text"] = "changed"
    with pytest.raises(NarrativeError):
        compile_radio_draft(prepared, plan, targets)


def test_INV_STO_06_draft_compiles_all_three_authored_shapes_without_inventing_audio():
    from coursekit.narratives.radio import radio_preparation_hash
    from coursekit.narratives.radio_draft import compile_radio_draft

    prepared, plan, targets = inputs()
    source = source_fixture()
    source["segments"][1]["text"] = "café pan agua queso."
    source["segments"][2]["text"] = "Gracias."
    source["segments"] += [
        {"id": "s4", "character_id": "adult_male", "text": "Gracias.", "translation": "Thank you."},
        {"id": "s5", "character_id": "adult_female", "text": "Adiós.", "translation": "Goodbye."},
    ]
    source["questions"] = [
        {
            "id": "c",
            "kind": "comprehension",
            "after_segment": "s2",
            "prompt": "¿Qué hay?",
            "accepted": "café",
            "distractors": ["té", "jugo"],
            "target_lemmas": ["café"],
        },
        {
            "id": "m",
            "kind": "matching",
            "after_segment": "s3",
            "pairs": [
                {"lemma": "pan", "translation": "bread"},
                {"lemma": "agua", "translation": "water"},
            ],
        },
        {
            "id": "q1",
            "kind": "listenSelect",
            "after_segment": "s4",
            "count": 2,
            "correct_lemmas": ["café", "pan"],
            "tile_lemmas": ["café", "pan", "agua", "queso"],
        },
    ]
    source["segments"][3]["text"] = "café pan."
    refs = [t["target"] for t in plan["questions"][0]["tiles"]]
    plan["questions"] = [
        {
            "id": "c",
            "targets": [
                {
                    "lemma": "café",
                    "target": refs[0],
                    "occurrence": {"segmentId": "s2", "tokenIndex": 0},
                }
            ],
        },
        {
            "id": "m",
            "pairs": [
                {
                    "lemma": "pan",
                    "target": refs[1],
                    "occurrence": {"segmentId": "s2", "tokenIndex": 1},
                },
                {
                    "lemma": "agua",
                    "target": refs[2],
                    "occurrence": {"segmentId": "s2", "tokenIndex": 2},
                },
            ],
        },
        {
            "id": "q1",
            "listenFromSegment": "s4",
            "tiles": [
                {
                    "lemma": w,
                    "target": refs[i],
                    "occurrence": {"segmentId": "s4", "tokenIndex": i} if i < 2 else None,
                }
                for i, w in enumerate(["café", "pan", "agua", "queso"])
            ],
        },
    ]
    prepared = prepare(source)
    plan["sourceSha256"] = prepared.source_hash
    plan["preparationSha256"] = radio_preparation_hash(prepared)
    draft = compile_radio_draft(prepared, plan, targets)
    assert [q["kind"] for q in draft.content["questions"]] == [
        "comprehension",
        "matching",
        "listenSelect",
    ]
    assert draft.content["questions"][0]["options"][0]["text"] == "café"
    assert draft.content["questions"][1]["pairs"][0]["right"] == "bread"
    assert "audioUri" not in draft.content["questions"][1]["pairs"][0]


def test_INV_AUD_04_rehashed_analysis_cannot_replace_the_canonical_segment_text():
    from test_radio_compiler import analyse

    from coursekit.narratives.radio import radio_preparation_hash

    prepared, plan, targets = inputs()
    prepared.texts["segment:s2"] = "otro pan."
    prepared.analyses["segment:s2"] = analyse("es", "otro pan.")
    with pytest.raises(NarrativeError, match="source surface"):
        radio_preparation_hash(prepared)
