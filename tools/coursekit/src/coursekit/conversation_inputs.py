"""Current conversation consumer inputs, shared by G9 and validators."""

from __future__ import annotations

from .artifacts import read_records
from .config.conversation_evidence import CONVERSATION_SHAPE
from .conversation_evidence import (
    ConversationEvidenceError,
    conversation_sources_for_exercise,
    load_conversation_plan,
    load_validated_conversation_evidence,
)
from .exercises.shapes import instruction_for
from .selected_sources import resolve_selected_sources


def resolve_current_conversations(lang, *, selected, candidates, ingested, analysed, units, banded):
    sources = resolve_selected_sources(
        lang,
        selected=selected,
        candidates=candidates,
        ingested=ingested,
        analysed=analysed,
        units=units,
        banded=banded,
    )
    plan = load_conversation_plan(lang, sources)
    approved = load_validated_conversation_evidence(lang, sources, ingested, analysed, plan)
    return sources, approved


def load_current_conversations(lang):
    records = {
        argument: tuple(read_records(kind, lang=lang))
        for argument, kind in (
            ("selected", "selected_item"),
            ("candidates", "candidate"),
            ("ingested", "ingested_sentence"),
            ("analysed", "analysed_sentence"),
            ("units", "unit_assignment"),
            ("banded", "banded_lemma"),
        )
    }
    return resolve_current_conversations(lang, **records)


def bind_conversation_exercises(lang, exercises, sources, approved):
    result = {}
    used_slots = set()
    for exercise in exercises:
        if str(exercise["prompt"]).partition("\n")[0] != instruction_for(
            CONVERSATION_SHAPE, lang=lang
        ):
            continue
        roles = conversation_sources_for_exercise(exercise, approved, sources)
        source = next(
            source
            for source in sources
            if source.source_id == exercise["source_sentence_id"]
            and source.unit_index == exercise["unit_index"]
            and source.lesson_index == exercise["lesson_index"]
        )
        if source.slot in used_slots:
            raise ConversationEvidenceError("duplicate conversation exercise for a planned slot")
        used_slots.add(source.slot)
        result[str(exercise["exercise_id"])] = (source.slot, approved[source.slot], roles)
    if used_slots != set(approved):
        raise ConversationEvidenceError("planned conversation is missing from emitted exercises")
    return result


def current_conversation_exposures(lang, exercises=None):
    """Only displayed dialogues add exposure; G9 separately enforces the full plan."""
    if exercises is None:
        exercises = tuple(read_records("exercise", lang=lang))
    else:
        exercises = tuple(exercises)
    instruction = instruction_for(CONVERSATION_SHAPE, lang=lang)
    if not any(str(row["prompt"]).partition("\n")[0] == instruction for row in exercises):
        return {}
    sources, approved = load_current_conversations(lang)
    return bind_conversation_exercises(lang, exercises, sources, approved)
