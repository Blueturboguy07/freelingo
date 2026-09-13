"""Additional dialogue exposure and signed provenance at the G9 boundary."""

from __future__ import annotations

import json

from ..config.conversation_evidence import CONVERSATION_META_PREFIX
from ..conversation_evidence import ConversationEvidenceError
from ..conversation_inputs import bind_conversation_exercises


def roles_for_pack(inputs):
    """Bind every planned chat to its exact display, original sources and question audio."""
    conversations = bind_conversation_exercises(
        inputs.lang, inputs.exercises, inputs.selected_sources, inputs.approved_conversations
    )
    by_id = {}
    for row in inputs.sentences:
        sid = str(row["sentence_id"])
        if sid in by_id and by_id[sid] != row:
            raise ConversationEvidenceError("conflicting conversation source identity")
        by_id[sid] = row
    clips = {}
    for clip in inputs.clips:
        cid = str(clip["clip_id"])
        if cid in clips and clips[cid] != clip:
            raise ConversationEvidenceError("conflicting conversation audio identity")
        clips[cid] = clip
    exercises = {str(row["exercise_id"]): row for row in inputs.exercises}
    for eid, (_slot, _approved, roles) in conversations.items():
        exercise = exercises[eid]
        for role in roles.values():
            if role.source_kind == "corpus" and by_id.get(role.source_id) != role.source:
                raise ConversationEvidenceError("conversation role differs from actual G0 source")
        clip = clips.get(exercise.get("audio_ref"))
        if (
            clip is None
            or clip.get("text") != roles["first_turn"].text
            or clip.get("lang") != inputs.lang
            or clip.get("pipeline") != "lesson"
        ):
            raise ConversationEvidenceError("conversation audio does not contain its first turn")
    return conversations


def exposure_lemmas(inputs):
    result = {key: frozenset(value) for key, value in inputs.extra_exposure_lemmas.items()}
    for eid, (_slot, _approved, roles) in roles_for_pack(inputs).items():
        result[eid] = result.get(eid, frozenset()).union(*(role.lemmas for role in roles.values()))
    return result


def extra_corpus_sentences(inputs):
    rows = {}
    for _slot, _approved, roles in roles_for_pack(inputs).values():
        for role in roles.values():
            if role.source_kind == "corpus":
                rows[role.source_id] = dict(role.source, provenance="corpus")
    return tuple(rows[key] for key in sorted(rows))


def metadata_rows(inputs):
    rows = []
    for eid, (slot, approved, roles) in sorted(roles_for_pack(inputs).items()):
        rows.append(
            dict(
                key=CONVERSATION_META_PREFIX + eid,
                value=json.dumps(
                    dict(
                        slot=list(slot),
                        roles={name: role.source_id for name, role in roles.items()},
                        evidence_hash=approved.evidence_hash,
                        population_digest=approved.population_digest,
                        plan_digest=approved.plan_digest,
                    ),
                    sort_keys=True,
                    ensure_ascii=False,
                ),
            )
        )
    return rows
