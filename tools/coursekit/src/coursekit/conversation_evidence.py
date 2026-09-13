"""Reviewed dialogue roles bound to a caller plan, actual sources and current G6.

Role evidence is additional display exposure, never additional selected slots or
teaching credit. A caller cannot infer its plan from whichever reviews survived.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
from collections.abc import Iterable, Mapping
from copy import deepcopy
from dataclasses import dataclass, replace
from datetime import date
from pathlib import Path
from typing import Any

from .answer_evidence import (
    AnswerEvidenceError,
    SurfacePolicy,
    _current_g6,
    _pair,
    validate_surface_proof,
)
from .artifacts import ArtifactError, _repo_root, run_dir, sentence_id, validate_record
from .config.conversation_evidence import (
    CONVERSATION_APPROVAL_PATH,
    CONVERSATION_EVIDENCE_LICENCE,
    CONVERSATION_EVIDENCE_PATH,
    CONVERSATION_EVIDENCE_VERSION,
    CONVERSATION_PLAN_PATH,
    CONVERSATION_ROLES,
    CONVERSATION_SHAPE,
)
from .config.g4 import CROSS_UNIT_REPEAT_CEILING, LEDGER_EXCLUDED_POS
from .config.g5 import CONTENT_ROOT_DIRNAME, CONTENT_ROOT_ENV_VAR, MAX_TOKENS, MIN_TOKENS
from .exercises.shapes import prompt_for, shape_of_record
from .registers import RegisterPolicyError, _sentence_tokens
from .selected_sources import (
    SelectedSource,
    SourceEvidenceError,
    evidence_digest,
    source_population_digest,
)

Slot = tuple[int, int, int]
_AUTHOR_FIELDS = {
    "schema_version",
    "selected_reply",
    "roles",
    "correct_reply_rationale",
    "wrong_reply_rationale",
    "author",
    "licence",
    "authored_on",
}
_REVIEW_FIELDS = {"reviewer", "verdict", "note", "content_hash"}


class ConversationEvidenceError(ValueError):
    """Missing, crossed, stale or incomplete conversation evidence."""


def _require(condition: bool, message: str) -> None:
    if not condition:
        raise ConversationEvidenceError(message)


def _text(value: Any) -> bool:
    return isinstance(value, str) and bool(value.strip())


def _fields(value: Any, names: set[str], context: str) -> None:
    _require(
        isinstance(value, Mapping) and set(value) == names,
        f"{context}: missing or unexpected fields",
    )


def _slot(value: Any) -> Slot:
    _require(
        isinstance(value, (list, tuple))
        and len(value) == 3
        and all(type(index) is int for index in value)
        and value[0] > 0
        and value[1] > 0
        and value[2] >= 0,
        "invalid conversation slot",
    )
    return tuple(value)


def conversation_plan_digest(
    expected_slots: Iterable[Slot], sources: Iterable[SelectedSource]
) -> str:
    """An explicit empty plan is allowed; missing planned rows are never an empty plan."""
    plan = tuple(_slot(slot) for slot in expected_slots)
    slots = {source.slot for source in sources}
    _require(len(set(plan)) == len(plan), "duplicate planned conversation slot")
    _require(set(plan) <= slots, "conversation plan contains an unselected slot")
    return evidence_digest([list(slot) for slot in sorted(plan)])


def load_conversation_plan(
    lang: str,
    sources: Iterable[SelectedSource],
    *,
    path: Path | None = None,
) -> tuple[Slot, ...]:
    """Read a deliberate plan, never infer one from whichever reviews remain."""
    sources = tuple(sources)
    source_population_digest(sources)
    _require(all(source.lang == lang for source in sources), "conversation plan language mismatch")
    if path is None:
        root = Path(os.environ.get(CONTENT_ROOT_ENV_VAR, _repo_root() / CONTENT_ROOT_DIRNAME))
        path = root / lang / CONVERSATION_PLAN_PATH
    _require(path.is_file(), f"missing conversation plan: {path}")
    try:
        row = json.loads(path.read_text(encoding="utf-8"))
        _fields(
            row,
            {"schema_version", "lang", "authored_on", "author", "rationale", "expected_slots"},
            "conversation plan",
        )
        _require(
            type(row["schema_version"]) is int
            and row["schema_version"] == CONVERSATION_EVIDENCE_VERSION,
            "unsupported conversation plan version",
        )
        _require(row["lang"] == lang, "conversation plan language mismatch")
        for field in ("author", "rationale", "authored_on"):
            _require(_text(row[field]), f"missing plan {field}")
        _require(
            date.fromisoformat(row["authored_on"]).isoformat() == row["authored_on"],
            "plan authored_on must be an ISO date",
        )
        _require(isinstance(row["expected_slots"], list), "planned slots must be an explicit array")
        slots = tuple(_slot(slot) for slot in row["expected_slots"])
        conversation_plan_digest(slots, sources)
        return tuple(sorted(slots))
    except ConversationEvidenceError:
        raise
    except (json.JSONDecodeError, KeyError, TypeError, ValueError) as exc:
        raise ConversationEvidenceError(f"{path}: malformed conversation plan") from exc


@dataclass(frozen=True, slots=True)
class ConversationSource:
    source_kind: str
    source_id: str
    lang: str
    text: str
    translation: str
    source: Mapping[str, Any]
    analysis: Mapping[str, Any]
    minimum_tokens: int
    window_pos_digest: str

    @property
    def lemmas(self) -> frozenset[str]:
        return frozenset(
            token["lemma"]
            for token in self.analysis["tokens"]
            if token["pos"] not in LEDGER_EXCLUDED_POS
        )

    def snapshot(self) -> dict[str, Any]:
        return dict(
            source_kind=self.source_kind,
            source_id=self.source_id,
            lang=self.lang,
            text=self.text,
            translation=self.translation,
            source_digest=evidence_digest(self.source),
            analysis_digest=evidence_digest(self.analysis),
            length_policy=dict(
                minimum=self.minimum_tokens,
                maximum=MAX_TOKENS,
                window_pos_digest=self.window_pos_digest,
            ),
        )


def _index(rows, key):
    result = {}
    for row in rows:
        value = row.get(key)
        _require(value is not None and value not in result, f"missing or duplicate {key}")
        result[value] = row
    return result


def resolve_conversation_roles(
    selected_reply: SelectedSource,
    first_turn_source_id: str,
    wrong_reply_source_id: str,
    ingested: Iterable[Mapping[str, Any]],
    analysed: Iterable[Mapping[str, Any]],
) -> dict[str, ConversationSource]:
    """First/wrong roles use shippable G0/G1; the correct reply is exactly selected."""
    try:
        g0, g1 = _index(ingested, "sentence_id"), _index(analysed, "sentence_id")
        roles = {}
        for name, sid in (
            ("first_turn", first_turn_source_id),
            ("correct_reply", selected_reply.source_id),
            ("wrong_reply", wrong_reply_source_id),
        ):
            if name == "correct_reply":
                source, analysis = selected_reply.source, selected_reply.analysis
                kind, minimum = selected_reply.source_kind, selected_reply.minimum_tokens
                _require(
                    source["text"] == selected_reply.text
                    and source["translation"] == selected_reply.translation,
                    "selected reply carries contradictory source facts",
                )
            else:
                _require(sid in g0 and sid in g1, f"{name} lacks exact G0/G1 source")
                source, analysis = g0[sid], g1[sid]
                validate_record("ingested_sentence", source)
                validate_record("analysed_sentence", analysis)
                _require(
                    source["lang"] == analysis["lang"] == selected_reply.lang,
                    "foreign-language conversation source",
                )
                _require(
                    sentence_id(selected_reply.lang, source["text"]) == sid,
                    "conversation source id does not identify exact text",
                )
                _require(source["licence_verdict"] == "shippable", "role is not shippable")
                _require(
                    not source["attribution_required"] or _text(source["attribution_owner"]),
                    "role lacks original attribution",
                )
                kind, minimum = "corpus", MIN_TOKENS
            _sentence_tokens(source["text"], analysis)
            roles[name] = ConversationSource(
                kind,
                sid,
                selected_reply.lang,
                source["text"],
                source["translation"],
                deepcopy(source),
                deepcopy(analysis),
                minimum,
                selected_reply.window_pos_digest,
            )
        _require(
            len({role.text for role in roles.values()}) == len(CONVERSATION_ROLES),
            "dialogue roles must have distinct surfaces",
        )
        return roles
    except (ArtifactError, RegisterPolicyError, KeyError, TypeError) as exc:
        raise ConversationEvidenceError(f"invalid conversation source: {exc}") from exc


def conversation_content_hash(row: Mapping[str, Any]) -> str:
    return evidence_digest({key: row[key] for key in sorted(_AUTHOR_FIELDS)})


def _rows_digest(rows) -> str:
    return evidence_digest([rows[slot] for slot in sorted(rows)])


def _validate_row(row, reply, roles):
    _fields(row, _AUTHOR_FIELDS | {"review"}, "conversation row")
    _require(
        row["schema_version"] == CONVERSATION_EVIDENCE_VERSION, "unsupported conversation version"
    )
    _require(row["selected_reply"] == reply.snapshot(), "stale selected reply placement")
    _require(row["licence"] == CONVERSATION_EVIDENCE_LICENCE, "unsupported authoring licence")
    for field in ("author", "authored_on", "correct_reply_rationale", "wrong_reply_rationale"):
        _require(_text(row[field]), f"missing contextual author field {field}")
    _require(
        re.fullmatch(r"\d{4}-\d{2}-\d{2}", row["authored_on"]) is not None,
        "authored_on must be an ISO date",
    )
    _fields(row["roles"], set(CONVERSATION_ROLES), "conversation roles")
    _fields(roles, set(CONVERSATION_ROLES), "resolved conversation roles")
    for name in CONVERSATION_ROLES:
        role = row["roles"][name]
        _fields(role, {"source", "pair"}, f"{name} evidence")
        _require(role["source"] == roles[name].snapshot(), f"stale or crossed {name} source")
        try:
            _pair(role["pair"], reply)
        except AnswerEvidenceError as exc:
            raise ConversationEvidenceError(str(exc)) from exc
    review = row["review"]
    _fields(review, _REVIEW_FIELDS, "independent context review")
    _require(all(_text(review[field]) for field in _REVIEW_FIELDS), "incomplete context review")
    _require(
        review["reviewer"].strip().casefold() != row["author"].strip().casefold(),
        "conversation reviewer must be independent",
    )
    _require(review["verdict"] == "accepted", "conversation review is not accepted")
    _require(review["content_hash"] == conversation_content_hash(row), "stale context review hash")


@dataclass(frozen=True, slots=True)
class ConversationEvidence:
    rows: Mapping[Slot, Mapping[str, Any]]
    roles: Mapping[Slot, Mapping[str, ConversationSource]]
    expected_slots: tuple[Slot, ...]
    digest: str
    population_digest: str
    plan_digest: str


@dataclass(frozen=True, slots=True)
class ApprovedConversation:
    roles: Mapping[str, ConversationSource]
    selected_reply: Mapping[str, Any]
    evidence_hash: str
    population_digest: str
    plan_digest: str
    reviewed_row: Mapping[str, Any]

    @property
    def first_turn_audio_text(self) -> str:
        return self.roles["first_turn"].text

    @property
    def reply_taught_lemmas(self) -> frozenset[str]:
        return self.roles["correct_reply"].lemmas

    @property
    def all_role_exposure_lemmas(self) -> frozenset[str]:
        return frozenset().union(*(role.lemmas for role in self.roles.values()))


def _bind_evidence(lang, sources, ingested, analysed, expected_slots, rows):
    sources, ingested, analysed = tuple(sources), tuple(ingested), tuple(analysed)
    population = source_population_digest(sources)
    _require(all(source.lang == lang for source in sources), "conversation language mismatch")
    plan = tuple(sorted(_slot(slot) for slot in expected_slots))
    plan_digest = conversation_plan_digest(plan, sources)
    _require(set(rows) == set(plan), "missing or extra planned conversation reviews")
    by_slot = {source.slot: source for source in sources}
    bound = {}
    for slot in plan:
        row = rows[slot]
        try:
            roles = resolve_conversation_roles(
                by_slot[slot],
                row["roles"]["first_turn"]["source"]["source_id"],
                row["roles"]["wrong_reply"]["source"]["source_id"],
                ingested,
                analysed,
            )
            _validate_row(row, by_slot[slot], roles)
        except (KeyError, TypeError) as exc:
            raise ConversationEvidenceError("malformed conversation roles") from exc
        bound[slot] = roles
    return ConversationEvidence(
        deepcopy(rows), bound, plan, _rows_digest(rows), population, plan_digest
    )


def load_conversation_evidence(lang, sources, ingested, analysed, expected_slots, *, path=None):
    """Require every caller-planned chat, even if no authored rows survived review."""
    if path is None:
        root = Path(os.environ.get(CONTENT_ROOT_ENV_VAR, _repo_root() / CONTENT_ROOT_DIRNAME))
        path = root / lang / CONVERSATION_EVIDENCE_PATH
    _require(path.is_file(), f"missing conversation evidence: {path}")
    rows = {}
    for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip():
            continue
        try:
            row = json.loads(line)
            _fields(row, _AUTHOR_FIELDS | {"review"}, "conversation row")
            slot = _slot(
                [row["selected_reply"][key] for key in ("unit_index", "lesson_index", "slot_index")]
            )
            _require(slot not in rows, "duplicate conversation review")
            rows[slot] = row
        except (json.JSONDecodeError, KeyError, TypeError) as exc:
            raise ConversationEvidenceError(
                f"{path}:{line_number}: malformed conversation evidence"
            ) from exc
    return _bind_evidence(lang, sources, ingested, analysed, expected_slots, rows)


def conversation_exposure_accounting(sources, roles_by_slot):
    """Count actual distinct slot/text exposures; selected replies are not extra slots.

    This report adds no teaching credit and leaves V11's selected population alone.
    Format siblings at one slot collapse. Repeated first turns in distinct slots do not.
    """
    sources = tuple(sources)
    source_population_digest(sources)
    by_slot = {source.slot: source for source in sources}
    _require(set(roles_by_slot) <= set(by_slot), "role exposure outside selected slots")
    occurrences = {(source.slot, source.text) for source in sources}
    for slot, roles in roles_by_slot.items():
        occurrences.update((slot, role.text) for role in roles.values())
    by_text = {}
    by_unit_text = {}
    for slot, text in sorted(occurrences):
        by_text.setdefault(text, set()).add(slot[0])
        by_unit_text.setdefault((slot[0], text), []).append(slot)
    duplicates = [
        dict(unit_index=unit, text=text, slots=[list(slot) for slot in slots])
        for (unit, text), slots in sorted(by_unit_text.items())
        if len(slots) > 1
    ]
    repeated = sum(len(units) - 1 for units in by_text.values())
    return dict(
        selected_denominator=len(sources),
        role_exposure_count=len(occurrences),
        same_unit_duplicates=duplicates,
        cross_unit_repeats=repeated,
        cross_unit_ratio=repeated / len(sources),
        occurrences=[dict(slot=list(slot), text=text) for slot, text in sorted(occurrences)],
    )


def build_conversation_approval(lang, sources, evidence, checks_by_slot_and_role, *, run_id):
    """G6 producer. Complete role checks and the explicit plan are immutable output."""
    sources = tuple(sources)
    _require(_text(run_id), "conversation approval needs its G6 run id")
    _require(
        source_population_digest(sources) == evidence.population_digest, "stale selected population"
    )
    _require(
        conversation_plan_digest(evidence.expected_slots, sources) == evidence.plan_digest,
        "changed conversation plan",
    )
    _require(evidence.digest == _rows_digest(evidence.rows), "changed conversation evidence")
    _require(
        set(evidence.expected_slots)
        == set(evidence.rows)
        == set(evidence.roles)
        == set(checks_by_slot_and_role),
        "incomplete conversation approval population",
    )
    by_slot = {source.slot: source for source in sources}
    occurrences = []
    for slot in evidence.expected_slots:
        reply, row, roles = by_slot[slot], evidence.rows[slot], evidence.roles[slot]
        _require(reply.lang == lang, "approval language mismatch")
        _validate_row(row, reply, roles)
        checked = checks_by_slot_and_role[slot]
        _fields(checked, set(CONVERSATION_ROLES), "approved role checks")
        for name in CONVERSATION_ROLES:
            role = roles[name]
            _require(
                isinstance(checked[name], list) and len(checked[name]) == 2,
                "each role needs exact Spanish and English proofs",
            )
            policy = replace(SurfacePolicy.from_source(reply), minimum_tokens=role.minimum_tokens)
            for proof, use, text in zip(
                checked[name],
                ("forward", "reverse_only"),
                (role.text, role.translation),
                strict=True,
            ):
                try:
                    validate_surface_proof(
                        policy,
                        proof,
                        use=use,
                        text=text,
                        pair=row["roles"][name]["pair"],
                        review_hash=row["review"]["content_hash"],
                        required_target_lemmas=reply.new_lemmas
                        if name == "correct_reply"
                        else frozenset(),
                        expected_analysis=role.analysis if use == "forward" else None,
                    )
                except AnswerEvidenceError as exc:
                    raise ConversationEvidenceError(f"{slot}/{name}: {exc}") from exc
        occurrences.append(
            dict(
                slot=list(slot),
                source_id=reply.source_id,
                review_hash=row["review"]["content_hash"],
                roles=deepcopy(checked),
            )
        )
    exposure = conversation_exposure_accounting(sources, evidence.roles)
    _require(not exposure["same_unit_duplicates"], "duplicate conversation exposure within a unit")
    _require(
        exposure["cross_unit_ratio"] <= CROSS_UNIT_REPEAT_CEILING,
        "conversation exposures exceed cross-unit repetition ceiling",
    )
    return dict(
        schema_version=CONVERSATION_EVIDENCE_VERSION,
        lang=lang,
        run_id=run_id,
        population_digest=evidence.population_digest,
        evidence_digest=evidence.digest,
        plan_digest=evidence.plan_digest,
        expected_slots=[list(slot) for slot in evidence.expected_slots],
        occurrences=occurrences,
        exposure=exposure,
    )


def write_conversation_approval(lang, approval):
    _require(approval.get("lang") == lang, "approval language mismatch")
    path = run_dir(lang) / CONVERSATION_APPROVAL_PATH
    data = (
        json.dumps(approval, sort_keys=True, ensure_ascii=False, allow_nan=False) + "\n"
    ).encode()
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".tmp")
    temporary.write_bytes(data)
    temporary.replace(path)
    return {
        "conversation_approval": dict(
            relative_path=CONVERSATION_APPROVAL_PATH,
            sha256=hashlib.sha256(data).hexdigest(),
            **{
                key: approval[key]
                for key in ("run_id", "population_digest", "evidence_digest", "plan_digest")
            },
        )
    }


def load_validated_conversation_evidence(
    lang, sources, ingested, analysed, expected_slots, *, evidence=None, g6_entry=None, path=None
):
    """Consumers rebind actual G0/G1 even when handed a cached evidence object."""
    sources, ingested, analysed, expected_slots = (
        tuple(sources),
        tuple(ingested),
        tuple(analysed),
        tuple(expected_slots),
    )
    current = load_conversation_evidence(
        lang, sources, ingested, analysed, expected_slots, path=path
    )
    if evidence is not None:
        _require(current == evidence, "cached conversation evidence is stale")
    evidence = current
    try:
        entry = _current_g6(lang)
    except AnswerEvidenceError as exc:
        raise ConversationEvidenceError(str(exc)) from exc
    if g6_entry is not None:
        _require(g6_entry == entry, "supplied G6 entry is not the latest actual attempt")
    _require(
        entry.get("lang") == lang and entry.get("stage") == "g6" and entry.get("status") == "ok",
        "G6 conversation approval did not succeed",
    )
    note = entry.get("notes", {}).get("conversation_approval")
    _fields(
        note,
        {
            "relative_path",
            "sha256",
            "run_id",
            "population_digest",
            "evidence_digest",
            "plan_digest",
        },
        "G6 conversation note",
    )
    _require(
        note["relative_path"] == CONVERSATION_APPROVAL_PATH and note["run_id"] == entry["run_id"],
        "conversation approval belongs to another G6 run",
    )
    output = run_dir(lang) / CONVERSATION_APPROVAL_PATH
    _require(
        output.is_file() and not output.is_symlink(), "missing immutable conversation approval"
    )
    data = output.read_bytes()
    _require(hashlib.sha256(data).hexdigest() == note["sha256"], "conversation output was modified")
    try:
        approval = json.loads(data)
        for key in ("population_digest", "evidence_digest", "plan_digest"):
            _require(approval[key] == note[key], "crossed conversation approval digest")
        checks = {}
        for occurrence in approval["occurrences"]:
            _fields(
                occurrence, {"slot", "source_id", "review_hash", "roles"}, "approved occurrence"
            )
            slot = _slot(occurrence["slot"])
            _require(slot not in checks, "duplicate approved conversation")
            checks[slot] = occurrence["roles"]
        rebuilt = build_conversation_approval(
            lang, sources, evidence, checks, run_id=entry["run_id"]
        )
        _require(rebuilt == approval, "conversation approval differs from current evidence")
    except (json.JSONDecodeError, KeyError, TypeError, SourceEvidenceError) as exc:
        raise ConversationEvidenceError("malformed conversation approval") from exc
    return {
        slot: ApprovedConversation(
            deepcopy(evidence.roles[slot]),
            deepcopy(evidence.rows[slot]["selected_reply"]),
            evidence.rows[slot]["review"]["content_hash"],
            evidence.population_digest,
            evidence.plan_digest,
            deepcopy(evidence.rows[slot]),
        )
        for slot in evidence.expected_slots
    }


def conversation_sources_for_exercise(exercise, approved_by_slot, selected_sources):
    """Exact serialized G7 join without inventing an exercise slot_index field."""
    try:
        _require(
            shape_of_record(exercise).id == CONVERSATION_SHAPE, "exercise is not a conversation"
        )
    except (KeyError, TypeError, ValueError) as exc:
        raise ConversationEvidenceError("exercise is not a serialized conversation") from exc
    _require(_text(exercise.get("exercise_id")), "conversation lacks exercise id")
    sources = tuple(selected_sources)
    matches = [
        source
        for source in sources
        if source.unit_index == exercise.get("unit_index")
        and source.lesson_index == exercise.get("lesson_index")
        and source.source_id == exercise.get("source_sentence_id")
    ]
    _require(len(matches) == 1, "missing or ambiguous selected conversation reply")
    source = matches[0]
    _require(source.slot in approved_by_slot, "exercise was not in the approved conversation plan")
    approved = approved_by_slot[source.slot]
    _require(
        approved.population_digest == source_population_digest(sources)
        and approved.selected_reply == source.snapshot(),
        "stale approved exercise population",
    )
    _require(
        approved.plan_digest == conversation_plan_digest(approved_by_slot, sources),
        "approved conversation plan is incomplete",
    )
    roles = approved.roles
    _validate_row(approved.reviewed_row, source, roles)
    _require(
        approved.evidence_hash == approved.reviewed_row["review"]["content_hash"],
        "approved conversation review hash changed",
    )
    _require(
        exercise.get("lang") == source.lang and exercise.get("register") == source.register,
        "conversation language or register changed",
    )
    _require(
        exercise.get("prompt")
        == prompt_for(CONVERSATION_SHAPE, lang=source.lang, body=roles["first_turn"].text),
        "conversation prompt changed",
    )
    _require(
        exercise.get("accepted_answers") == [roles["correct_reply"].text], "canonical reply changed"
    )
    _require(exercise.get("distractors") == [roles["wrong_reply"].text], "sole wrong reply changed")
    return roles
