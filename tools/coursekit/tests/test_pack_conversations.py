"""[INV-PACK-06, INV-PACK-17] dialogue exposures survive the real G9 boundary."""

import json
from dataclasses import replace

import pytest
from test_conversation_evidence import exercise, fixture, installed, validated

from coursekit.conversation_evidence import ConversationEvidenceError
from coursekit.packbuild.sqlite import (
    build_rows,
    dump_pack,
    exercise_rows,
    fixture_inputs,
    meta_rows,
    provenance_split,
    sentence_rows,
    shipped_sentences,
    write_pack,
)

pytestmark = pytest.mark.parametrize("invariant", ["INV-PACK-06", "INV-PACK-17"])


def pack_fixture(tmp_path, monkeypatch):
    facts = fixture(tmp_path)
    installed(facts, monkeypatch, tmp_path)
    approved = validated(facts)
    source = facts[0][0]
    base = fixture_inputs()
    row = dict(base.exercises[0], **exercise(facts))
    row.update(
        exercise_id="c" * 16,
        audio_ref="a" * 16,
        item_tags=dict(lemmas=sorted(source.lemmas), grammar_concepts=[]),
    )
    selected = dict(
        schema_version=1,
        lang="es",
        unit_index=source.unit_index,
        lesson_index=source.lesson_index,
        slot_index=source.slot_index,
        sentence_id=source.source_id,
        gap=False,
        provenance="corpus",
        accepted_alternates=[],
        known_lemmas=sorted(source.known_lemmas),
        new_lemmas=sorted(source.new_lemmas),
        grammar_concept=source.grammar_concept,
    )
    all_lemmas = source.lemmas | source.known_lemmas
    lemmas = tuple(
        dict(base.lemmas[0], lemma=lemma, pos="NOUN", rank=i + 1)
        for i, lemma in enumerate(sorted(all_lemmas))
    )
    clip = dict(base.clips[0], clip_id="a" * 16, text=approved[source.slot].first_turn_audio_text)
    return replace(
        base,
        sentences=tuple(facts[1]),
        units=(
            dict(
                base.units[0],
                unit_index=source.unit_index,
                target_lemmas=sorted(all_lemmas),
                grammar_concept=source.grammar_concept,
            ),
        ),
        selected=(selected,),
        candidates=(),
        exercises=(row,),
        clips=(clip,),
        lemmas=lemmas,
        selected_sources=facts[0],
        approved_conversations=approved,
    ), facts


def test_real_database_contains_role_sources_and_signed_metadata(invariant, tmp_path, monkeypatch):
    inputs, facts = pack_fixture(tmp_path, monkeypatch)
    expected = {row["sentence_id"] for row in facts[1]}
    assert {row["sentence_id"] for row in shipped_sentences(inputs)} == expected
    assert provenance_split(inputs) == (100.0, 0.0)
    rows = build_rows(inputs)
    database = write_pack(tmp_path / "chat.sqlite", rows)
    stored = dump_pack(database)
    assert {row["sentence_id"] for row in stored["sentence"]} == expected
    metadata = json.loads(
        next(row["value"] for row in stored["meta"] if row["key"] == "conversation:" + "c" * 16)
    )
    approved = next(iter(inputs.approved_conversations.values()))
    assert metadata["evidence_hash"] == approved.evidence_hash
    assert metadata["population_digest"] == approved.population_digest
    assert metadata["plan_digest"] == approved.plan_digest
    assert metadata["roles"] == {name: role.source_id for name, role in approved.roles.items()}
    first_turn = approved.roles["first_turn"]
    first_row = next(
        row for row in stored["sentence"] if row["sentence_id"] == first_turn.source_id
    )
    assert first_row["attribution_owner"] == first_turn.source["attribution_owner"]
    assert first_row["audio_id"] == "a" * 16
    assert all(row["item_ref"] in facts[0][0].lemmas for row in stored["exercise_item_tag"])


@pytest.mark.parametrize(
    "defect",
    [
        "missing_approval",
        "missing_selected",
        "missing_exercise",
        "wrong_prompt",
        "wrong_audio",
        "missing_audio",
        "wrong_audio_language",
        "wrong_audio_pipeline",
        "missing_wrong_source",
        "crossed_owner",
    ],
)
def test_g9_refuses_unbound_chat_sources_or_question_audio(
    invariant, tmp_path, monkeypatch, defect
):
    inputs, _ = pack_fixture(tmp_path, monkeypatch)
    if defect == "missing_approval":
        inputs = replace(inputs, approved_conversations={})
    elif defect == "missing_selected":
        inputs = replace(inputs, selected_sources=())
    elif defect == "missing_exercise":
        inputs = replace(inputs, exercises=())
    elif defect == "wrong_prompt":
        inputs = replace(
            inputs,
            exercises=(dict(inputs.exercises[0], prompt="Complete the chat\nEnglish question"),),
        )
    elif defect == "wrong_audio":
        inputs = replace(inputs, clips=(dict(inputs.clips[0], text=facts_reply(inputs)),))
    elif defect == "missing_audio":
        inputs = replace(inputs, clips=())
    elif defect == "wrong_audio_language":
        inputs = replace(inputs, clips=(dict(inputs.clips[0], lang="fr"),))
    elif defect == "wrong_audio_pipeline":
        inputs = replace(inputs, clips=(dict(inputs.clips[0], pipeline="story"),))
    elif defect == "missing_wrong_source":
        wrong = next(iter(inputs.approved_conversations.values())).roles["wrong_reply"].source_id
        inputs = replace(
            inputs, sentences=tuple(row for row in inputs.sentences if row["sentence_id"] != wrong)
        )
    else:
        inputs = replace(
            inputs,
            sentences=tuple(
                dict(row, attribution_owner="forged owner") for row in inputs.sentences
            ),
        )
    with pytest.raises(
        (ConversationEvidenceError, ValueError), match="conversation|chat|source|audio|planned"
    ):
        build_rows(inputs)


def facts_reply(inputs):
    return inputs.selected_sources[0].text


def test_role_sources_are_not_duplicated_if_already_selected(invariant, tmp_path, monkeypatch):
    inputs, _ = pack_fixture(tmp_path, monkeypatch)
    original = shipped_sentences(inputs)
    assert len(original) == 3
    assert len({row["sentence_id"] for row in original}) == 3
    assert len(sentence_rows(inputs)) == 3
    assert len(exercise_rows(inputs)) == 1
    assert len([row for row in meta_rows(inputs) if row["key"].startswith("conversation:")]) == 1


@pytest.mark.parametrize("defect", [None, "missing_plan", "failed_g6", "changed_role"])
def test_actual_g9_loader_requires_current_planned_role_approval(
    invariant, tmp_path, monkeypatch, defect
):
    from types import SimpleNamespace

    import coursekit.answer_evidence as answers
    from coursekit.stages import g9_package

    inputs, facts = pack_fixture(tmp_path, monkeypatch)
    content = tmp_path / "content"
    authoring = content / "es/authoring"
    authoring.mkdir(parents=True)
    monkeypatch.setenv("COURSEKIT_CONTENT_ROOT", str(content))
    (authoring / "conversations.jsonl").write_text(facts[5].read_text())
    if defect != "missing_plan":
        (authoring / "conversation-plan.json").write_text(
            json.dumps(
                dict(
                    schema_version=1,
                    lang="es",
                    author="explicit test planner",
                    authored_on="2026-09-13",
                    rationale="One real serialized chat in this test.",
                    expected_slots=[list(facts[0][0].slot)],
                )
            )
        )
    if defect == "failed_g6":
        entries = list(answers.read_entries("es"))
        monkeypatch.setattr(
            answers,
            "read_entries",
            lambda lang: iter(
                [*entries, dict(stage="g6", lang="es", status="failed", run_id="new-failure")]
            ),
        )
    if defect == "changed_role":
        facts[1][1]["translation"] = "Changed first-turn translation"
    data = dict(
        ingested_sentence=facts[1],
        analysed_sentence=facts[2],
        banded_lemma=(),
        unit_assignment=(facts[0][0].unit,),
        selected_item=inputs.selected,
        candidate=(),
        exercise=inputs.exercises,
        baked_clip=inputs.clips,
    )
    collected = []

    def collect(lang, kind):
        collected.append(kind)
        return tuple(data[kind])

    monkeypatch.setattr(g9_package, "_collect", collect)
    monkeypatch.setattr(g9_package, "derive_review", lambda lang: None)
    monkeypatch.setattr(g9_package, "licences_seen", lambda lang: ())
    monkeypatch.setattr(g9_package, "_validator_report", lambda lang: {})
    ctx = SimpleNamespace(lang="es", options={})
    if defect:
        with pytest.raises(ConversationEvidenceError):
            g9_package._pack_inputs(ctx)
    else:
        current = g9_package._pack_inputs(ctx)
        assert current.approved_conversations == inputs.approved_conversations
        assert current.selected_sources == facts[0]
        assert "analysed_sentence" in collected
        assert current.extra_exposure_lemmas["c" * 16] >= frozenset({"qué", "comer", "cinco"})


def test_v10_and_v12_include_extra_role_texts_without_changing_v11_population(
    invariant, tmp_path, monkeypatch
):
    from coursekit.validators import pack

    inputs, facts = pack_fixture(tmp_path, monkeypatch)
    bound = {
        "c" * 16: (
            facts[0][0].slot,
            next(iter(inputs.approved_conversations.values())),
            next(iter(inputs.approved_conversations.values())).roles,
        )
    }
    monkeypatch.setattr(pack, "current_conversation_exposures", lambda lang, exercises=None: bound)
    canonical = pack.ShippedItem(
        1,
        1,
        0,
        facts[0][0].source_id,
        "corpus",
        facts[0][0].text,
        facts[0][0].translation,
        "CC0-1.0",
        "shippable",
        True,
        "original owner",
        3,
    )
    monkeypatch.setattr(pack, "shipped_items", lambda lang: (canonical,))
    combined = pack.all_shipped_text_items("es")
    assert len(combined) == 3
    assert {item.item_id for item in combined} == {row["sentence_id"] for row in facts[1]}
    assert pack.shipped_items("es") == (canonical,)
    roles = next(iter(bound.values()))[2]
    roles["wrong_reply"].source["licence"] = "NOASSERTION"
    note = type("Entry", (), {"note": lambda self, **kwargs: None})()
    ctx = type("Context", (), {"lang": "es", "entry": note})()
    assert any(
        f.severity == "blocking" and "unresolved" in f.message
        for f in pack.every_sentence_carries_a_resolved_licence(ctx)
    )
    roles["wrong_reply"].source["licence"] = "CC0-1.0"
    roles["wrong_reply"].source["translation"] = "Unrenderable \U0010ffff"
    # Translation is immutable in the role object; use a newly bound valid object for
    # this downstream font falsifier rather than pretending it is a new G6 approval.
    roles["wrong_reply"] = replace(roles["wrong_reply"], translation="Unrenderable \U0010ffff")
    monkeypatch.setattr(pack, "_read_optional", lambda kind, lang: [])
    assert any(
        f.severity == "blocking" and "U+10FFFF" in f.message
        for f in pack.direction_and_font_coverage(ctx)
    )
