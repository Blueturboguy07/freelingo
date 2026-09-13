"""Conversation roles cannot borrow a reply's source, ledger or G6 approval."""

import json
from copy import deepcopy
from dataclasses import replace

import pytest
from test_answer_evidence import check, install_run
from test_selected_sources import source_fixture

from coursekit.artifacts import dedup_hash, sentence_id
from coursekit.conversation_evidence import (
    ConversationEvidenceError,
    build_conversation_approval,
    conversation_content_hash,
    conversation_exposure_accounting,
    conversation_sources_for_exercise,
    load_conversation_evidence,
    load_validated_conversation_evidence,
    resolve_conversation_roles,
    write_conversation_approval,
)
from coursekit.ledger import count_units
from coursekit.selected_sources import resolve_selected_sources

pytestmark = pytest.mark.parametrize("invariant", ["INV-PACK-06", "INV-PACK-08"])


def corpus(text, translation, specs):
    fixture = source_fixture()
    source, analysis = fixture["ingested"][0], fixture["analysed"][0]
    sid = sentence_id("es", text)
    tokens, start = [], 0
    for surface, lemma, pos in specs:
        start = text.index(surface, start)
        tokens.append(
            dict(
                surface=surface,
                lemma=lemma,
                pos=pos,
                morph="",
                start=start,
                end=start + len(surface),
            )
        )
        start += len(surface)
    source.update(
        sentence_id=sid,
        text=text,
        translation=translation,
        dedup_hash=dedup_hash(text),
        token_count=sum(t["pos"] != "PUNCT" for t in tokens),
        attribution_required=True,
        attribution_owner="original owner",
    )
    analysis.update(
        sentence_id=sid,
        tokens=tokens,
        lemmas=[t["lemma"] for t in tokens],
        display_tokens=[t["surface"] for t in tokens],
    )
    return source, analysis


def fixture(tmp_path):
    triples = [
        corpus(
            "Quiero una tarta.",
            "I want a cake.",
            [
                ("Quiero", "querer", "VERB"),
                ("una", "uno", "DET"),
                ("tarta", "tarta", "NOUN"),
                (".", ".", "PUNCT"),
            ],
        ),
        corpus(
            "¿Qué quieres comer?",
            "What do you want to eat?",
            [
                ("¿", "¿", "PUNCT"),
                ("Qué", "qué", "PRON"),
                ("quieres", "querer", "VERB"),
                ("comer", "comer", "VERB"),
                ("?", "?", "PUNCT"),
            ],
        ),
        corpus(
            "Son las cinco.",
            "It is five o'clock.",
            [
                ("Son", "ser", "AUX"),
                ("las", "el", "DET"),
                ("cinco", "cinco", "NUM"),
                (".", ".", "PUNCT"),
            ],
        ),
    ]
    ingested, analysed = [p[0] for p in triples], [p[1] for p in triples]
    data = source_fixture()
    data.update(ingested=ingested, analysed=analysed)
    data["selected"][0].update(
        sentence_id=ingested[0]["sentence_id"],
        new_lemmas=["tarta"],
        known_lemmas=["querer", "uno", "qué", "comer", "ser", "el", "cinco"],
    )
    sources = resolve_selected_sources("es", **data)
    roles = resolve_conversation_roles(
        sources[0], ingested[1]["sentence_id"], ingested[2]["sentence_id"], ingested, analysed
    )
    row = dict(
        schema_version=1,
        selected_reply=sources[0].snapshot(),
        roles={
            name: dict(
                source=role.snapshot(),
                pair=dict(
                    score=4, register="neutral", judgement="Exact Spanish and English meaning."
                ),
            )
            for name, role in roles.items()
        },
        correct_reply_rationale="The cake directly answers what the speaker wants to eat.",
        wrong_reply_rationale="The time does not answer a question about food.",
        author="dialogue author",
        licence="CC-BY-NC-SA-4.0",
        authored_on="2026-09-13",
        review=None,
    )
    row["review"] = dict(
        reviewer="independent dialogue reviewer",
        verdict="accepted",
        note="Both response choices checked in this exact context.",
        content_hash=conversation_content_hash(row),
    )
    path = tmp_path / "conversations.jsonl"
    rewrite(path, row)
    return sources, ingested, analysed, [sources[0].slot], row, path


def rewrite(path, row, *, review_again=False):
    if review_again:
        row["review"]["content_hash"] = conversation_content_hash(row)
    path.write_text(json.dumps(row) + "\n")


def load(facts):
    sources, ingested, analysed, plan, _, path = facts
    return load_conversation_evidence("es", sources, ingested, analysed, plan, path=path)


def proofs(evidence):
    result = {}
    for slot, roles in evidence.roles.items():
        result[slot] = {}
        for name, role in roles.items():
            pair = check("es")
            pair["detail"] = dict(
                score=4, review_hash=evidence.rows[slot]["review"]["content_hash"]
            )
            count = count_units(
                dict(
                    lang="es",
                    tokens=role.analysis["tokens"],
                    adapter=role.analysis.get("adapter", role.analysis.get("analyser")),
                )
            )
            spanish = dict(
                use="forward",
                text=role.text,
                analysis=deepcopy(role.analysis),
                checks={
                    **{
                        axis: check("es") for axis in ("ledger", "register", "duplicate", "grammar")
                    },
                    "pair": pair,
                    "perplexity": check("es", available=False),
                    "length": {
                        **check("es"),
                        "detail": dict(
                            minimum=role.minimum_tokens,
                            maximum=12,
                            count=count,
                            window_pos_digest=role.window_pos_digest,
                        ),
                    },
                },
            )
            english_pair = deepcopy(pair)
            english_pair["language"] = "en"
            english = dict(
                use="reverse_only",
                text=role.translation,
                analysis=None,
                checks=dict(pair=english_pair, grammar=check("en")),
            )
            result[slot][name] = [spanish, english]
    return result


def build(facts, evidence=None, checked=None):
    evidence = load(facts) if evidence is None else evidence
    return build_conversation_approval(
        "es",
        facts[0],
        evidence,
        proofs(evidence) if checked is None else checked,
        run_id="fresh-run",
    )


def installed(facts, monkeypatch, tmp_path):
    import coursekit.conversation_evidence as module

    evidence = load(facts)
    monkeypatch.setattr(module, "run_dir", lambda lang: tmp_path)
    notes = write_conversation_approval("es", build(facts, evidence))
    entry = dict(lang="es", stage="g6", status="ok", run_id="fresh-run", notes=notes)
    install_run(monkeypatch, entry)
    return evidence, entry


def validated(facts, **kwargs):
    return load_validated_conversation_evidence(
        "es", facts[0], facts[1], facts[2], facts[3], path=facts[5], **kwargs
    )


def exercise(facts):
    return dict(
        exercise_id="chat-fixture",
        type="cloze",
        lang="es",
        register="tu",
        unit_index=1,
        lesson_index=1,
        source_sentence_id=facts[0][0].source_id,
        prompt="Complete the chat\n¿Qué quieres comer?",
        accepted_answers=["Quiero una tarta."],
        distractors=["Son las cinco."],
    )


def test_named_roles_keep_target_credit_and_attribution_separate(invariant, tmp_path, monkeypatch):
    facts = fixture(tmp_path)
    evidence, _ = installed(facts, monkeypatch, tmp_path)
    approved = validated(facts)
    chat = approved[facts[3][0]]
    assert chat.reply_taught_lemmas == facts[0][0].lemmas
    assert "cinco" not in chat.reply_taught_lemmas
    assert "cinco" in chat.all_role_exposure_lemmas
    assert "tarta" not in chat.roles["first_turn"].lemmas
    roles = conversation_sources_for_exercise(exercise(facts), approved, facts[0])
    assert set(roles) == {"first_turn", "correct_reply", "wrong_reply"}
    assert roles["first_turn"].source["attribution_owner"] == "original owner"
    assert roles["first_turn"].source == facts[1][1]
    assert chat.first_turn_audio_text == "¿Qué quieres comer?"
    assert chat.population_digest == evidence.population_digest


@pytest.mark.parametrize(
    "defect",
    [
        "missing_plan_row",
        "extra_plan_row",
        "duplicate_plan",
        "foreign_slot",
        "crossed_reply",
        "source_text",
        "source_translation",
        "analysis",
        "licence",
        "owner",
        "register",
        "self_review",
        "context",
        "review_hash",
    ],
)
def test_plan_source_context_and_review_joins_fail_closed(invariant, tmp_path, defect):
    facts = fixture(tmp_path)
    sources, ingested, analysed, plan, row, path = facts
    if defect == "missing_plan_row":
        path.write_text("")
    elif defect == "extra_plan_row":
        plan.clear()
    elif defect == "duplicate_plan":
        plan.append(plan[0])
    elif defect == "foreign_slot":
        plan[0] = (9, 9, 9)
    elif defect == "crossed_reply":
        row["roles"]["correct_reply"] = deepcopy(row["roles"]["wrong_reply"])
        rewrite(path, row, review_again=True)
    elif defect == "source_text":
        ingested[1]["text"] = "Quiero comer."
    elif defect == "source_translation":
        ingested[1]["translation"] = "When will you eat?"
    elif defect == "analysis":
        analysed[1]["tokens"][1]["lemma"] = "cuándo"
    elif defect == "licence":
        ingested[1]["licence_verdict"] = "oracle_only"
    elif defect == "owner":
        ingested[1]["attribution_owner"] = None
    elif defect == "register":
        row["roles"]["first_turn"]["pair"]["register"] = "usted"
        rewrite(path, row, review_again=True)
    elif defect == "self_review":
        row["review"]["reviewer"] = row["author"]
        rewrite(path, row)
    elif defect == "context":
        row["wrong_reply_rationale"] = ""
        rewrite(path, row, review_again=True)
    else:
        row["wrong_reply_rationale"] = "Changed context"
        rewrite(path, row)
    with pytest.raises(ConversationEvidenceError):
        load(facts)


@pytest.mark.parametrize(
    "defect",
    [
        "missing_role",
        "extra_role",
        "crossed_proof",
        "unseen",
        "missing_target",
        "length",
        "stale_analysis",
        "english_engine",
        "no_engine",
        "pair_hash",
    ],
)
def test_each_role_requires_real_destination_and_language_checks(invariant, tmp_path, defect):
    facts = fixture(tmp_path)
    evidence = load(facts)
    checked = proofs(evidence)
    roles = checked[facts[3][0]]
    if defect == "missing_role":
        del roles["first_turn"]
    elif defect == "extra_role":
        roles["spare"] = deepcopy(roles["first_turn"])
    elif defect == "crossed_proof":
        roles["first_turn"] = deepcopy(roles["wrong_reply"])
    elif defect == "unseen":
        roles["first_turn"][0]["analysis"]["tokens"][1]["lemma"] = "unseen"
    elif defect == "missing_target":
        roles["correct_reply"][0]["analysis"]["tokens"][2]["lemma"] = "uno"
    elif defect == "length":
        roles["first_turn"][0]["checks"]["length"]["detail"]["minimum"] = 1
    elif defect == "stale_analysis":
        roles["wrong_reply"][0]["analysis"]["tokens"][0]["morph"] = "Person=2"
    elif defect == "english_engine":
        roles["first_turn"][1]["checks"]["grammar"] = check("es")
    elif defect == "no_engine":
        roles["first_turn"][0]["checks"]["grammar"] = check("es", available=False)
    else:
        roles["first_turn"][0]["checks"]["pair"]["detail"]["review_hash"] = "old"
    with pytest.raises(ConversationEvidenceError):
        build(facts, evidence, checked)


@pytest.mark.parametrize(
    "defect",
    [
        "changed_nonchat",
        "changed_role",
        "changed_plan",
        "changed_output",
        "new_g6",
        "new_g1",
        "changed_review_file",
    ],
)
def test_validated_loader_binds_actual_current_inputs_and_g6(
    invariant, tmp_path, monkeypatch, defect
):
    import coursekit.answer_evidence as answers

    facts = fixture(tmp_path)
    evidence, entry = installed(facts, monkeypatch, tmp_path)
    if defect == "changed_nonchat":
        extra = replace(facts[0][0], slot_index=1, source_id="b" * 16)
        facts = ((facts[0][0], extra), *facts[1:])
    elif defect == "changed_role":
        facts[1][1]["translation"] = "Changed English"
    elif defect == "changed_plan":
        facts[3].clear()
    elif defect == "changed_review_file":
        facts[4]["wrong_reply_rationale"] = "Changed rationale after G6"
        rewrite(facts[5], facts[4], review_again=True)
    elif defect == "changed_output":
        path = tmp_path / "g6/conversation-approval.json"
        path.write_text(path.read_text() + " ")
    else:
        history = [{"stage": f"g{i}", "status": "ok"} for i in range(6)] + [entry]
        history.append(dict(stage="g6" if defect == "new_g6" else "g1", status="failed"))
        monkeypatch.setattr(answers, "read_entries", lambda lang: iter(history))
    with pytest.raises(ConversationEvidenceError):
        validated(facts, evidence=evidence, g6_entry=entry)


@pytest.mark.parametrize(
    "field,value",
    [
        ("unit_index", 2),
        ("lesson_index", 2),
        ("source_sentence_id", "b" * 16),
        ("prompt", "Complete the chat\nEnglish prompt"),
        ("lang", "fr"),
        ("register", "usted"),
        ("accepted_answers", ["Other answer"]),
        ("distractors", ["Son las cinco.", "Extra"]),
        ("type", "typed_translate_forward"),
    ],
)
def test_exercise_join_rejects_wrong_placement_shape_or_display(
    invariant, tmp_path, monkeypatch, field, value
):
    facts = fixture(tmp_path)
    installed(facts, monkeypatch, tmp_path)
    approved = validated(facts)
    row = exercise(facts)
    row[field] = value
    with pytest.raises(ConversationEvidenceError):
        conversation_sources_for_exercise(row, approved, facts[0])


def test_exercise_join_rejects_ambiguous_reply_occurrences(invariant, tmp_path, monkeypatch):
    facts = fixture(tmp_path)
    installed(facts, monkeypatch, tmp_path)
    approved = validated(facts)
    with pytest.raises(ConversationEvidenceError):
        conversation_sources_for_exercise(
            exercise(facts), approved, (*facts[0], replace(facts[0][0], slot_index=1))
        )


def test_explicit_empty_plan_is_bound_and_does_not_infer_rows(invariant, tmp_path):
    facts = fixture(tmp_path)
    facts[3].clear()
    facts[5].write_text("")
    approval = build(facts)
    assert approval["expected_slots"] == []
    assert approval["occurrences"] == []
    assert approval["exposure"]["selected_denominator"] == 1


def test_role_repeats_do_not_inflate_selected_denominator(invariant, tmp_path):
    facts = fixture(tmp_path)
    evidence = load(facts)
    first = facts[0][0]
    second = replace(
        first, unit_index=2, lesson_index=2, source_id="b" * 16, text="Other canonical sentence"
    )
    role_occurrences = {
        first.slot: evidence.roles[first.slot],
        second.slot: evidence.roles[first.slot],
    }
    accounting = conversation_exposure_accounting((first, second), role_occurrences)
    assert accounting["selected_denominator"] == 2
    assert accounting["cross_unit_repeats"] == 3
    assert accounting["cross_unit_ratio"] == 1.5
    same_unit = replace(second, unit_index=1)
    accounting = conversation_exposure_accounting(
        (first, same_unit),
        {first.slot: evidence.roles[first.slot], same_unit.slot: evidence.roles[first.slot]},
    )
    assert len(accounting["same_unit_duplicates"]) == 3


@pytest.mark.parametrize("require_target", [True, False])
def test_target_requirement_is_separate_from_unchanged_destination_allowance(
    invariant, tmp_path, require_target
):
    from coursekit.answer_evidence import AnswerEvidenceError, SurfacePolicy, validate_surface_proof

    facts = fixture(tmp_path)
    evidence = load(facts)
    role = evidence.roles[facts[3][0]]["first_turn"]
    proof = proofs(evidence)[facts[3][0]]["first_turn"][0]
    kwargs = dict(
        use="forward",
        text=role.text,
        pair=facts[4]["roles"]["first_turn"]["pair"],
        review_hash=facts[4]["review"]["content_hash"],
        expected_analysis=role.analysis,
        required_target_lemmas=facts[0][0].new_lemmas if require_target else frozenset(),
    )
    policy = SurfacePolicy.from_source(facts[0][0])
    if require_target:
        with pytest.raises(AnswerEvidenceError, match="omits a reserved target"):
            validate_surface_proof(policy, proof, **kwargs)
    else:
        validate_surface_proof(policy, proof, **kwargs)
        policy = replace(
            policy,
            known_lemmas=policy.known_lemmas - {"qué", "comer"},
            new_lemmas=frozenset({"qué", "comer"}),
        )
        with pytest.raises(AnswerEvidenceError, match="new-lemma budget"):
            validate_surface_proof(policy, proof, **kwargs)


def test_corpus_role_cannot_borrow_authored_one_word_floor(invariant, tmp_path):
    facts = fixture(tmp_path)
    source, analysis = corpus("Comer", "To eat", [("Comer", "comer", "VERB")])
    facts[1][1], facts[2][1] = source, analysis
    roles = resolve_conversation_roles(
        facts[0][0], source["sentence_id"], facts[1][2]["sentence_id"], facts[1], facts[2]
    )
    facts[4]["roles"]["first_turn"]["source"] = roles["first_turn"].snapshot()
    rewrite(facts[5], facts[4], review_again=True)
    evidence = load(facts)
    assert evidence.roles[facts[3][0]]["first_turn"].minimum_tokens == 3
    with pytest.raises(ConversationEvidenceError, match="length window"):
        build(facts, evidence)


@pytest.mark.parametrize("same_unit", [True, False])
def test_extra_role_exposure_cannot_hide_behind_format_siblings(invariant, tmp_path, same_unit):
    facts = fixture(tmp_path)
    evidence = load(facts)
    first = evidence.roles[facts[3][0]]["first_turn"]
    additional = replace(
        facts[0][0],
        slot_index=1,
        unit_index=1 if same_unit else 2,
        source_id=first.source_id,
        text=first.text,
        translation=first.translation,
        source=first.source,
        analysis=first.analysis,
        new_lemmas=frozenset(),
    )
    facts = ((*facts[0], additional), *facts[1:])
    with pytest.raises(
        ConversationEvidenceError, match="within a unit" if same_unit else "cross-unit repetition"
    ):
        build(facts)


def test_reviewed_role_metadata_cannot_be_mutated_before_pack_join(
    invariant, tmp_path, monkeypatch
):
    facts = fixture(tmp_path)
    installed(facts, monkeypatch, tmp_path)
    approved = validated(facts)
    approved[facts[3][0]].roles["first_turn"].source["attribution_owner"] = "different owner"
    with pytest.raises(ConversationEvidenceError, match="stale or crossed first_turn"):
        conversation_sources_for_exercise(exercise(facts), approved, facts[0])


def test_approval_output_remains_bound_even_if_tamper_hash_is_recomputed(
    invariant, tmp_path, monkeypatch
):
    facts = fixture(tmp_path)
    _, entry = installed(facts, monkeypatch, tmp_path)
    import hashlib

    path = tmp_path / "g6/conversation-approval.json"
    value = json.loads(path.read_bytes())
    value["occurrences"][0]["source_id"] = "b" * 16
    path.write_text(json.dumps(value))
    entry["notes"]["conversation_approval"]["sha256"] = hashlib.sha256(
        path.read_bytes()
    ).hexdigest()
    install_run(monkeypatch, entry)
    with pytest.raises(ConversationEvidenceError, match="differs from current evidence"):
        validated(facts)
