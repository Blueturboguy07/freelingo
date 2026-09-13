"""Exact selected occurrences shared by language approval and downstream consumers.

Selection identifies a placement as well as a sentence. A corpus ID proves neither
its English pair nor its destination ledger; a reserve candidate proves neither the
chosen text nor its analysis. The snapshot binds those facts without adding fields to
the frozen G0-G9 records. It is evidence identity, not a language-quality certificate.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Iterable, Mapping
from copy import deepcopy
from dataclasses import dataclass
from typing import Any

from .artifacts import ArtifactError, first_accepted_candidates, sentence_id, validate_record
from .config.g4 import LEDGER_EXCLUDED_POS
from .config.g5 import MAX_TOKENS, MIN_TOKENS, min_tokens_for_slot
from .registers import RegisterPolicyError, _sentence_tokens, unit_register


class SourceEvidenceError(ValueError):
    """Missing, stale or contradictory selected-source evidence."""


def evidence_digest(value: Any) -> str:
    """Hash exact JSON facts; text is not case/accent/whitespace-normalized."""
    payload = json.dumps(
        value, sort_keys=True, ensure_ascii=False, separators=(",", ":"), allow_nan=False
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


@dataclass(frozen=True, slots=True)
class SelectedSource:
    lang: str
    unit_index: int
    lesson_index: int
    slot_index: int
    source_kind: str
    source_id: str
    text: str
    translation: str
    analysis: Mapping[str, Any]
    known_lemmas: frozenset[str]
    new_lemmas: frozenset[str]
    grammar_concept: str
    register: str
    source: Mapping[str, Any]
    unit: Mapping[str, Any]
    legacy_alternates: tuple[str, ...]
    minimum_tokens: int
    window_pos_digest: str

    @property
    def slot(self) -> tuple[int, int, int]:
        return self.unit_index, self.lesson_index, self.slot_index

    @property
    def lemmas(self) -> frozenset[str]:
        return frozenset(
            token["lemma"]
            for token in self.analysis["tokens"]
            if token["pos"] not in LEDGER_EXCLUDED_POS
        )

    def snapshot(self) -> dict[str, Any]:
        """Serializable authored-review join, including original licence/owner facts."""
        return {
            "lang": self.lang,
            "unit_index": self.unit_index,
            "lesson_index": self.lesson_index,
            "slot_index": self.slot_index,
            "source_kind": self.source_kind,
            "source_id": self.source_id,
            "text": self.text,
            "translation": self.translation,
            "known_lemmas": sorted(self.known_lemmas),
            "new_lemmas": sorted(self.new_lemmas),
            "grammar_concept": self.grammar_concept,
            "register": self.register,
            "source_digest": evidence_digest(self.source),
            "analysis_digest": evidence_digest(self.analysis),
            "unit_digest": evidence_digest(self.unit),
            "legacy_alternates": list(self.legacy_alternates),
            "length_policy": {
                "minimum": self.minimum_tokens,
                "maximum": MAX_TOKENS,
                "window_pos_digest": self.window_pos_digest,
            },
        }


def _index(rows: Iterable[Mapping[str, Any]], key: str) -> dict[Any, Mapping[str, Any]]:
    result = {}
    for row in rows:
        value = row.get(key)
        if value is None or value in result:
            raise SourceEvidenceError(f"missing or duplicate {key}: {value!r}")
        result[value] = row
    return result


def resolve_selected_sources(
    lang: str,
    selected: Iterable[Mapping[str, Any]],
    candidates: Iterable[Mapping[str, Any]],
    ingested: Iterable[Mapping[str, Any]],
    analysed: Iterable[Mapping[str, Any]],
    units: Iterable[Mapping[str, Any]],
    banded: Iterable[Mapping[str, Any]] = (),
) -> tuple[SelectedSource, ...]:
    """Resolve every actual G4 slot against the ordered post-G6 surviving stream.

    No reserves, stale spans, extra gap fills or partial populations are returned.
    Foreign-language input and duplicate identities fail rather than being overwritten.
    """
    try:
        return _resolve(lang, selected, candidates, ingested, analysed, units, banded)
    except (ArtifactError, RegisterPolicyError, KeyError, TypeError) as exc:
        raise SourceEvidenceError(str(exc)) from exc


def _resolve(lang, selected, candidates, ingested, analysed, units, banded):
    selected = list(selected)
    if not selected:
        raise SourceEvidenceError("selected-source population is empty")
    g0 = _index(ingested, "sentence_id")
    g1 = _index(analysed, "sentence_id")
    declarations = _index(units, "unit_index")
    lexical_rows = _index(banded, "lemma")
    for row in lexical_rows.values():
        if row.get("lang", lang) != lang or not isinstance(row.get("pos"), str):
            raise SourceEvidenceError("invalid G2 length-policy evidence")
    lexicon_pos = {lemma: row["pos"] for lemma, row in lexical_rows.items()}
    chosen = first_accepted_candidates(candidates, lang=lang)
    seen_slots: set[tuple[int, int, int]] = set()
    seen_authored: set[str] = set()
    result = []
    for item in selected:
        validate_record("selected_item", item)
        if item["lang"] != lang:
            raise SourceEvidenceError("selected source language mismatch")
        slot = (item["unit_index"], item["lesson_index"], item["slot_index"])
        if slot in seen_slots:
            raise SourceEvidenceError(f"duplicate selected slot {slot}")
        seen_slots.add(slot)
        unit = declarations.get(slot[0])
        if unit is None or item["grammar_concept"] != unit.get("grammar_concept"):
            raise SourceEvidenceError(f"selected slot {slot} has no matching unit declaration")
        register = unit_register(lang, unit)
        if item["gap"]:
            if item["sentence_id"] is not None or item["provenance"] != "llm":
                raise SourceEvidenceError(f"contradictory gap identity at {slot}")
            source = chosen.get(slot)
            if source is None:
                raise SourceEvidenceError(f"selected gap {slot} has no surviving candidate")
            sid = source["candidate_id"]
            if sid in seen_authored or sid in g0:
                raise SourceEvidenceError(f"duplicate authored source identity {sid}")
            seen_authored.add(sid)
            analysis = source["analysis"]
            kind = "authored"
            alternates = source.get("accepted_alternates", [])
        else:
            sid = item["sentence_id"]
            if sid is None or item["provenance"] != "corpus":
                raise SourceEvidenceError(f"contradictory corpus identity at {slot}")
            source, analysis = g0.get(sid), g1.get(sid)
            if source is None or analysis is None:
                raise SourceEvidenceError(f"selected corpus source {sid} lacks G0/G1 evidence")
            validate_record("ingested_sentence", source)
            validate_record("analysed_sentence", analysis)
            if source["lang"] != lang or analysis["lang"] != lang:
                raise SourceEvidenceError(f"source {sid} has a foreign-language join")
            if sentence_id(lang, source["text"]) != sid:
                raise SourceEvidenceError(f"source {sid} does not identify its exact text")
            if source["licence_verdict"] != "shippable":
                raise SourceEvidenceError(f"source {sid} is not licensed for shipment")
            if source["attribution_required"] and not source["attribution_owner"]:
                raise SourceEvidenceError(f"source {sid} lacks required attribution")
            kind = "corpus"
            alternates = item.get("accepted_alternates", [])
        _sentence_tokens(source["text"], analysis)
        known, new = item["known_lemmas"], item["new_lemmas"]
        if len(set(known)) != len(known) or len(set(new)) != len(new) or set(known) & set(new):
            raise SourceEvidenceError(f"ambiguous known/new ledger at {slot}")
        result.append(
            SelectedSource(
                lang,
                *slot,
                kind,
                sid,
                source["text"],
                source["translation"],
                deepcopy(analysis),
                frozenset(known),
                frozenset(new),
                item["grammar_concept"],
                register,
                deepcopy(source),
                deepcopy(unit),
                tuple(alternates),
                MIN_TOKENS if kind == "corpus" else min_tokens_for_slot(known, new, lexicon_pos),
                evidence_digest(
                    {lemma: lexicon_pos.get(lemma) for lemma in sorted(set(known) | set(new))}
                ),
            )
        )
    return tuple(sorted(result, key=lambda source: source.slot))


def source_population_digest(sources: Iterable[SelectedSource]) -> str:
    rows = sorted(sources, key=lambda source: source.slot)
    if not rows or len({source.slot for source in rows}) != len(rows):
        raise SourceEvidenceError("population must contain unique, nonempty selected occurrences")
    return evidence_digest([source.snapshot() for source in rows])
