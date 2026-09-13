"""Bounded Radio source checks and discard-only selection, before pack-wide gates.

This reports its exact scope. It is not coursekit validate, independent language
review, an audio bake, or a replacement for combined lesson/story/radio validation.
"""

from __future__ import annotations

import copy
import hashlib
import math
from datetime import date
from typing import Any

from ..artifacts import validate_record
from ..config.g6 import BLOCKING_ISSUE_TYPES, DEGRADATION_NAMES, ENGINE_NONE
from ..config.narratives import RADIO_SOURCE_REMAINING
from ..ledger import is_lexical_pos
from ..packbuild.itemid import canonical_json
from ..registers import sentence_register_matches, unit_register
from .compiler import NarrativeError
from .radio import RadioPreparation, _closed, _require, _text, radio_preparation_hash
from .radio_draft import RadioDraft


def _hash(value):
    return hashlib.sha256(canonical_json(value).encode()).hexdigest()


def inspect_radio_source(
    prepared: RadioPreparation, units: list[dict[str, Any]], *, grammar=None, perplexity=None
) -> dict[str, Any]:
    """Check actual source spans, declared unit allowance/register and G6 language axes.

    Grammar/perplexity are the existing configured engine APIs, with real probe
    availability and unchanged blocking issue types/bands. Missing/failed checks
    produce named evidence; neither missing means zero errors. Target occurrence
    plans, independent meaning/answer review and combined V1–V12 remain separate.
    """
    result = {
        "schemaVersion": 1,
        "sourceSha256": prepared.source_hash,
        "preparationSha256": None,
        "unitsSha256": _hash(units),
        "eligible_for_draft": False,
        "engines": {},
        "surfaces": [],
        "blocking": [],
        "remaining": list(RADIO_SOURCE_REMAINING),
    }

    def block(code, where, detail):
        result["blocking"].append({"code": code, "where": where, "detail": detail})

    try:
        result["preparationSha256"] = radio_preparation_hash(prepared)
        _require(
            set(prepared.texts) == set(prepared.analyses),
            "Radio preflight: incomplete surface population.",
        )
        _require(
            isinstance(units, list) and bool(units),
            "Radio preflight: declared curriculum required.",
        )
        by_unit = {}
        first = {}
        for unit in units:
            validate_record("unit_assignment", unit)
            _require(
                unit["lang"] == prepared.source["language"] and unit["unit_index"] not in by_unit,
                "Radio preflight: duplicate/wrong-language unit declaration.",
            )
            unit_register(unit["lang"], unit)
            by_unit[unit["unit_index"]] = unit
            for lemma in unit["target_lemmas"]:
                _require(lemma not in first, "Radio preflight: repeated target introduction.")
                first[lemma] = unit["unit_index"]
        _require(
            sorted(by_unit) == list(range(1, max(by_unit) + 1)),
            "Radio preflight: curriculum unit population is incomplete.",
        )
        unit = by_unit[prepared.source["unit_index"]]
        if prepared.source["register"] != unit_register(unit["lang"], unit):
            block("register-declaration", "source", prepared.source["register"])
    except (ValueError, KeyError, TypeError) as exc:
        block("source-evidence", "source", str(exc))
        return result
    available = {}
    for name, engine, field in [
        ("grammar", grammar, "grammar_engine"),
        ("perplexity", perplexity, "perplexity_engine"),
    ]:
        try:
            probe = (
                engine.probe(unit["lang"])
                if engine is not None
                else {
                    "available": False,
                    field: ENGINE_NONE,
                    "reason": "Not provided; this check did not run.",
                }
            )
        except Exception as exc:
            probe = {"available": False, field: ENGINE_NONE, "reason": str(exc)}
        if not isinstance(probe, dict):
            probe = {"available": False, field: ENGINE_NONE, "reason": "Malformed engine probe."}
        available[name] = (
            probe.get("available") is True
            and isinstance(probe.get(field), str)
            and probe[field] not in ("", ENGINE_NONE)
        )
        result["engines"][name] = copy.deepcopy(probe)
    missing = [name + "_engine" for name, value in available.items() if not value]
    result["engines"]["degraded_to"] = (
        ENGINE_NONE if len(missing) == 2 else DEGRADATION_NAMES[missing[0]] if missing else ""
    )
    if len(missing) == 2:
        block("language-unavailable", "source", "Neither grammar nor perplexity engine ran.")
    for aid, text in prepared.texts.items():
        analysis = prepared.analyses[aid]
        unknown = sorted(
            {
                t["lemma"]
                for t in analysis["tokens"]
                if is_lexical_pos(t["pos"])
                and (t["lemma"] not in first or first[t["lemma"]] > unit["unit_index"])
            }
        )
        registered = sentence_register_matches(unit["lang"], unit, text, analysis)
        row = {
            "analysisId": aid,
            "text": text,
            "analysisSha256": _hash(analysis),
            "unavailableLemmas": unknown,
            "register": registered,
            "grammar": None,
            "perplexity": None,
        }
        result["surfaces"].append(row)
        if unknown:
            block("curriculum-allowance", aid, unknown)
        if not registered:
            block("register", aid, "Wrong/mixed register or exact analysis missing.")
        if available["grammar"]:
            try:
                matches = grammar.check(unit["lang"], text)
                row["grammar"] = [m.to_json() for m in matches]
                bad = [
                    m.to_json()
                    for m in matches
                    if m.issue_type in BLOCKING_ISSUE_TYPES[unit["lang"]]
                ]
                if bad:
                    block("grammar", aid, bad)
            except Exception as exc:
                block("grammar-call-failed", aid, str(exc))
        if available["perplexity"]:
            try:
                inside, score = perplexity.in_band(text)
                _require(
                    type(inside) is bool and type(score) in (int, float) and math.isfinite(score),
                    "Radio perplexity: invalid measured result.",
                )
                row["perplexity"] = {
                    "inside": inside,
                    "score": score,
                    "band": list(perplexity.band),
                }
                if not inside:
                    block("perplexity", aid, row["perplexity"])
            except Exception as exc:
                block("perplexity-call-failed", aid, str(exc))
    for q in prepared.source["questions"]:
        if q["kind"] != "listenSelect":
            continue
        # Every legal whole-segment window ending here necessarily includes this
        # final segment. No full listening window or preferred occurrence is inferred.
        heard = {
            t["lemma"]
            for t in prepared.analyses["segment:" + q["after_segment"]]["tokens"]
            if is_lexical_pos(t["pos"])
        }
        bad = sorted((set(q["tile_lemmas"]) - set(q["correct_lemmas"])) & heard)
        if bad:
            block("heard-distractor", q["id"], bad)
    result["eligible_for_draft"] = not result["blocking"]
    return result


def radio_review_hash(draft: RadioDraft, source_check: dict[str, Any]) -> str:
    return _hash({"candidate": draft.review_candidate(), "sourceCheck": source_check})


def select_radio_draft(
    candidates: list[dict[str, Any]], reviews: list[dict[str, Any]]
) -> tuple[RadioDraft, list[dict[str, Any]]]:
    """First wholly eligible independently reviewed candidate, with explicit discards.

    Both source author and occurrence-plan author are excluded from independent review.
    This selects a draft, not a playable episode or a passing/released pack. Rejected
    sources stay unchanged; a new authoring revision is a new candidate and review hash.
    """
    discarded = []
    for candidate in candidates:
        try:
            _closed(candidate, {"draft", "source_check"}, "Radio candidate")
            draft = candidate["draft"]
            check = candidate["source_check"]
            _require(isinstance(draft, RadioDraft), "Radio candidate: compiled draft required.")
            _closed(
                check,
                {
                    "schemaVersion",
                    "sourceSha256",
                    "preparationSha256",
                    "unitsSha256",
                    "eligible_for_draft",
                    "engines",
                    "surfaces",
                    "blocking",
                    "remaining",
                },
                "Radio source check",
            )
            _require(
                check["eligible_for_draft"] is True
                and check["blocking"] == []
                and check["sourceSha256"] == draft.evidence["sourceSha256"]
                and check["preparationSha256"] == draft.evidence["preparationSha256"],
                "Radio candidate: stale or failed source check.",
            )
            _require(
                {r["analysisId"] for r in check["surfaces"]} == set(draft.evidence["analyses"])
                and len(check["surfaces"]) == len(draft.evidence["analyses"]),
                "Radio candidate: incomplete checked surface population.",
            )
            for row in check["surfaces"]:
                _require(
                    row["analysisSha256"] == _hash(draft.evidence["analyses"][row["analysisId"]]),
                    "Radio candidate: stale checked analysis.",
                )
            digest = radio_review_hash(draft, check)
            matching = [r for r in reviews if r.get("candidateSha256") == digest]
            _require(
                len(matching) == 1, "Radio candidate: missing or ambiguous independent review."
            )
            review = _closed(
                matching[0],
                {"candidateSha256", "reviewer", "verdict", "date", "note"},
                "Radio review",
            )
            reviewer = _text(review["reviewer"], "Radio reviewer")
            _text(review["note"], "Radio review note")
            date.fromisoformat(review["date"])
            _require(
                review["verdict"] == "accept"
                and reviewer
                not in {
                    draft.author,
                    draft.evidence["source"]["author"],
                    draft.evidence["plan"]["author"],
                },
                "Radio candidate: rejected or self-reviewed source/plan.",
            )
            return draft, discarded
        except (ValueError, KeyError, TypeError, AttributeError) as exc:
            draft = candidate.get("draft") if isinstance(candidate, dict) else None
            identifier = draft.content.get("id") if isinstance(draft, RadioDraft) else None
            discarded.append({"id": identifier, "reason": str(exc)})
    raise NarrativeError(f"No Radio draft survives exact independent selection: {discarded}")
