"""Independently reviewed whole answers, approved against the actual G6 population.

A mutable author file alone cannot add an accepted answer to G7. A successful G6
entry binds its exact reviewed facts and complete selected population to the checked
output. Forward Spanish and reverse-only English have separate surface checks.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
from collections.abc import Iterable, Mapping
from copy import deepcopy
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .artifacts import _repo_root, run_dir
from .config.answer_evidence import (
    ANSWER_APPROVAL_PATH,
    ANSWER_EVIDENCE_LICENCE,
    ANSWER_EVIDENCE_PATH,
    ANSWER_EVIDENCE_VERSION,
)
from .config.g4 import LEDGER_EXCLUDED_POS, MAX_NEW_LEMMAS_PER_EXERCISE
from .config.g5 import CONTENT_ROOT_DIRNAME, CONTENT_ROOT_ENV_VAR, MAX_TOKENS
from .config.g6 import BACKTRANSLATION_MIN_SCORE, BACKTRANSLATION_SCORE_RANGE
from .ledger import count_units
from .registers import RegisterPolicyError, _sentence_tokens, sentence_register_matches
from .runlog import read_entries
from .selected_sources import (
    SelectedSource,
    SourceEvidenceError,
    evidence_digest,
    source_population_digest,
)

_AUTHOR_FIELDS = {
    "schema_version",
    "source",
    "author",
    "licence",
    "authored_on",
    "rationale",
    "canonical_pair",
    "spanish",
    "english_reverse_only",
}
_REVIEW_FIELDS = {"reviewer", "verdict", "note", "content_hash"}
_CHECK_FIELDS = {"engine", "language", "requested", "available", "passed", "detail"}


class AnswerEvidenceError(ValueError):
    """A missing, stale, incomplete or unapproved answer set."""


def _require(condition: bool, message: str) -> None:
    if not condition:
        raise AnswerEvidenceError(message)


def _text(value: Any) -> bool:
    return isinstance(value, str) and bool(value.strip())


def _fields(value: Any, names: set[str], context: str) -> None:
    _require(
        isinstance(value, Mapping) and set(value) == names,
        f"{context}: missing or unexpected fields",
    )


def answer_content_hash(row: Mapping[str, Any]) -> str:
    """All authored fields, including exact placement/pair and ordered alternatives."""
    return evidence_digest({key: row[key] for key in sorted(_AUTHOR_FIELDS)})


def _pair(value: Any, source: SelectedSource) -> None:
    _fields(value, {"score", "judgement", "register"}, "pair judgement")
    _require(
        value["register"] in {"neutral", source.register},
        "reviewed whole-sentence register conflicts with its destination",
    )
    low, high = BACKTRANSLATION_SCORE_RANGE
    _require(
        type(value["score"]) is int and low <= value["score"] <= high,
        "invalid bilingual rubric score",
    )
    _require(
        value["score"] >= BACKTRANSLATION_MIN_SCORE and _text(value["judgement"]),
        "pair lacks a passing explicit bilingual judgement",
    )


def _validate_row(row: Mapping[str, Any], source: SelectedSource) -> None:
    _fields(row, _AUTHOR_FIELDS | {"review"}, "answer row")
    _require(row["schema_version"] == ANSWER_EVIDENCE_VERSION, "unsupported answer version")
    _require(row["source"] == source.snapshot(), f"stale source snapshot at {source.slot}")
    _require(row["licence"] == ANSWER_EVIDENCE_LICENCE, "unsupported answer evidence licence")
    for field in ("author", "rationale", "authored_on"):
        _require(_text(row[field]), f"missing {field}")
    _require(
        re.fullmatch(r"\d{4}-\d{2}-\d{2}", row["authored_on"]) is not None,
        "authored_on must be an ISO date",
    )
    _pair(row["canonical_pair"], source)
    for name, canonical in (("spanish", source.text), ("english_reverse_only", source.translation)):
        _require(isinstance(row[name], list), f"{name} must be explicit, including empty sets")
        seen = {canonical.casefold().strip()}
        for alternate in row[name]:
            _fields(alternate, {"text", "pair"}, name)
            _require(_text(alternate["text"]), f"empty {name} alternate")
            folded = alternate["text"].casefold().strip()
            _require(folded not in seen, f"duplicate {name} answer")
            seen.add(folded)
            _pair(alternate["pair"], source)
    _require(
        set(source.legacy_alternates) <= {row["text"] for row in row["spanish"]},
        "legacy Spanish alternatives lack explicit reviewed coverage",
    )
    review = row["review"]
    _fields(review, _REVIEW_FIELDS, "independent review")
    _require(all(_text(review[field]) for field in _REVIEW_FIELDS), "incomplete review")
    _require(
        review["reviewer"].strip().casefold() != row["author"].strip().casefold(),
        "answer review must be independent of its author",
    )
    _require(review["verdict"] == "accepted", "answer review is not accepted")
    _require(review["content_hash"] == answer_content_hash(row), "stale answer review hash")


@dataclass(frozen=True, slots=True)
class AnswerEvidence:
    rows: Mapping[tuple[int, int, int], Mapping[str, Any]]
    digest: str
    population_digest: str


@dataclass(frozen=True, slots=True)
class ApprovedAnswers:
    spanish: tuple[str, ...]
    english_reverse_only: tuple[str, ...]
    spanish_analysis_by_surface: Mapping[str, Mapping[str, Any]]
    evidence_hash: str


def _evidence_rows_digest(rows) -> str:
    return evidence_digest([rows[key] for key in sorted(rows)])


def load_answer_evidence(
    lang: str,
    sources: Iterable[SelectedSource],
    *,
    path: Path | None = None,
) -> AnswerEvidence:
    """Every selected occurrence has one current independent review, even if empty."""
    sources = tuple(sources)
    by_slot = {source.slot: source for source in sources}
    population = source_population_digest(sources)
    _require(all(source.lang == lang for source in sources), "evidence language mismatch")
    if path is None:
        root = Path(os.environ.get(CONTENT_ROOT_ENV_VAR, _repo_root() / CONTENT_ROOT_DIRNAME))
        path = root / lang / ANSWER_EVIDENCE_PATH
    _require(path.is_file(), f"missing answer evidence: {path}")
    rows = {}
    for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip():
            continue
        try:
            row = json.loads(line)
            _fields(row, _AUTHOR_FIELDS | {"review"}, f"answer row {line_number}")
            snapshot = row["source"]
            key = tuple(snapshot[field] for field in ("unit_index", "lesson_index", "slot_index"))
            _require(all(type(index) is int for index in key), "invalid occurrence coordinate")
            _require(key in by_slot and key not in rows, f"extra or duplicate answer row {key}")
            _validate_row(row, by_slot[key])
        except (json.JSONDecodeError, KeyError, TypeError, SourceEvidenceError) as exc:
            raise AnswerEvidenceError(f"{path}:{line_number}: malformed answer evidence") from exc
        rows[key] = row
    _require(rows.keys() == by_slot.keys(), "missing selected-occurrence answer reviews")
    return AnswerEvidence(rows, _evidence_rows_digest(rows), population)


def answer_surfaces(source: SelectedSource, row: Mapping[str, Any]):
    """Exact canonical-first surface/pair triples; no inferred accepted answers."""
    return [
        ("forward", source.text, row["canonical_pair"]),
        *(("forward", alternate["text"], alternate["pair"]) for alternate in row["spanish"]),
        ("reverse_only", source.translation, row["canonical_pair"]),
        *(
            ("reverse_only", alternate["text"], alternate["pair"])
            for alternate in row["english_reverse_only"]
        ),
    ]


def _validate_check(check: Any, *, language: str, required: bool) -> None:
    _fields(check, _CHECK_FIELDS, "language check")
    _require(
        check["language"] == language and _text(check["engine"]),
        "wrong-language or unidentified check engine",
    )
    _require(
        type(check["available"]) is bool and type(check["requested"]) is bool,
        "check availability must be explicit",
    )
    _require(isinstance(check["detail"], Mapping), "check lacks explicit details")
    if check["available"]:
        _require(
            check["engine"] != "none" and check["passed"] is True,
            "surface failed a requested language check",
        )
    else:
        _require(
            not required
            and not check["requested"]
            and check["passed"] is None
            and check["engine"] == "none"
            and _text(check["detail"].get("reason")),
            "required or requested engine unavailable; cannot claim a pass",
        )


@dataclass(frozen=True, slots=True)
class SurfacePolicy:
    """Destination allowance is independent of which role must carry its target."""

    lang: str
    known_lemmas: frozenset[str]
    new_lemmas: frozenset[str]
    unit: Mapping[str, Any]
    register: str
    minimum_tokens: int
    window_pos_digest: str

    @classmethod
    def from_source(cls, source: SelectedSource) -> SurfacePolicy:
        return cls(
            source.lang,
            source.known_lemmas,
            source.new_lemmas,
            source.unit,
            source.register,
            source.minimum_tokens,
            source.window_pos_digest,
        )


def validate_surface_proof(
    source: SurfacePolicy,
    proof: Mapping[str, Any],
    *,
    use: str,
    text: str,
    pair: Mapping[str, Any],
    review_hash: str,
    required_target_lemmas: frozenset[str],
    expected_analysis: Mapping[str, Any] | None = None,
) -> None:
    """Pure per-surface boundary shared by answers and independently joined roles.

    A non-teaching role can omit a reserved target. It cannot enlarge the allowed
    vocabulary, spend another new item, borrow analysis, or skip any language axis.
    """
    _require(use in {"forward", "reverse_only"}, "unsupported surface direction")
    _require(required_target_lemmas <= source.new_lemmas, "target outside destination reserve")
    _pair(pair, source)
    _fields(proof, {"use", "text", "analysis", "checks"}, "surface proof")
    _require(proof["use"] == use and proof["text"] == text, "wrong surface or answer direction")
    spanish = use == "forward"
    language = source.lang if spanish else "en"
    names = (
        {"ledger", "register", "length", "duplicate", "pair", "grammar", "perplexity"}
        if spanish
        else {"pair", "grammar"}
    )
    _fields(proof["checks"], names, "surface checks")
    for name, check in proof["checks"].items():
        _validate_check(
            check,
            language=language,
            required=name not in {"grammar", "perplexity"} or not spanish,
        )
    detail = proof["checks"]["pair"]["detail"]
    _require(
        detail.get("review_hash") == review_hash and detail.get("score") == pair["score"],
        "pair proof lacks the exact review",
    )
    if not spanish:
        _require(proof["analysis"] is None, "English cannot borrow Spanish analysis")
        return
    _require(
        any(proof["checks"][name]["available"] for name in ("grammar", "perplexity")),
        "no Spanish language engine ran",
    )
    try:
        tokens = _sentence_tokens(text, proof["analysis"])
    except RegisterPolicyError as exc:
        raise AnswerEvidenceError(str(exc)) from exc
    adapter = proof["analysis"].get("adapter", proof["analysis"].get("analyser"))
    _require(isinstance(adapter, Mapping), "surface analysis lacks its original adapter")
    token_count = count_units({"lang": source.lang, "tokens": tokens, "adapter": adapter})
    _require(
        source.minimum_tokens <= token_count <= MAX_TOKENS,
        "Spanish surface violates its destination length window",
    )
    _require(
        proof["checks"]["length"]["detail"]
        == {
            "minimum": source.minimum_tokens,
            "maximum": MAX_TOKENS,
            "count": token_count,
            "window_pos_digest": source.window_pos_digest,
        },
        "length proof does not bind the current shared policy",
    )
    lemmas = {token["lemma"] for token in tokens if token["pos"] not in LEDGER_EXCLUDED_POS}
    _require(
        lemmas <= source.known_lemmas | source.new_lemmas,
        "surface contains an unseen destination lemma",
    )
    _require(required_target_lemmas <= lemmas, "surface omits a reserved target lemma")
    _require(
        len(lemmas - source.known_lemmas) <= MAX_NEW_LEMMAS_PER_EXERCISE,
        "surface exceeds the new-lemma budget",
    )
    _require(
        sentence_register_matches(source.lang, source.unit, text, proof["analysis"]),
        "surface violates destination register",
    )
    if expected_analysis is not None:
        _require(
            proof["analysis"] == expected_analysis, "canonical analysis changed after selection"
        )


def _validate_surfaces(source, row, proofs):
    expected = answer_surfaces(source, row)
    _require(
        isinstance(proofs, list) and len(proofs) == len(expected), "missing or extra surface proof"
    )
    for proof, (use, text, pair) in zip(proofs, expected, strict=True):
        validate_surface_proof(
            SurfacePolicy.from_source(source),
            proof,
            use=use,
            text=text,
            pair=pair,
            review_hash=row["review"]["content_hash"],
            required_target_lemmas=source.new_lemmas,
            expected_analysis=source.analysis if use == "forward" and text == source.text else None,
        )


def build_answer_approval(
    lang: str,
    sources: Iterable[SelectedSource],
    evidence: AnswerEvidence,
    checks_by_slot: Mapping[tuple[int, int, int], list[Mapping[str, Any]]],
    *,
    run_id: str,
) -> dict[str, Any]:
    """G6-only producer: refuse any failed surface; never silently trim the set."""
    sources = tuple(sorted(sources, key=lambda source: source.slot))
    _require(_text(run_id), "approval needs its G6 run id")
    _require(
        source_population_digest(sources) == evidence.population_digest,
        "answer review belongs to a different source population",
    )
    _require(evidence.digest == _evidence_rows_digest(evidence.rows), "answer evidence changed")
    slots = {source.slot for source in sources}
    _require(slots == set(checks_by_slot) == set(evidence.rows), "incomplete approval population")
    occurrences = []
    surfaces_in_unit: dict[tuple[int, str], tuple[int, int, int]] = {}
    for source in sources:
        _require(source.lang == lang, "approval language mismatch")
        row = evidence.rows[source.slot]
        _validate_row(row, source)
        _validate_surfaces(source, row, checks_by_slot[source.slot])
        for use, text, _pair_evidence in answer_surfaces(source, row):
            if use == "forward":
                key = (source.unit_index, text)
                _require(
                    key not in surfaces_in_unit or surfaces_in_unit[key] == source.slot,
                    "duplicate Spanish answer across selected slots in the same unit",
                )
                surfaces_in_unit[key] = source.slot
        occurrences.append(
            {
                "slot": list(source.slot),
                "source_id": source.source_id,
                "review_hash": row["review"]["content_hash"],
                "surfaces": deepcopy(checks_by_slot[source.slot]),
            }
        )
    return {
        "schema_version": ANSWER_EVIDENCE_VERSION,
        "lang": lang,
        "run_id": run_id,
        "population_digest": evidence.population_digest,
        "evidence_digest": evidence.digest,
        "occurrences": occurrences,
    }


def write_answer_approval(lang: str, approval: Mapping[str, Any]) -> dict[str, Any]:
    """Persist exact G6 output; return the note G6 must attach before it succeeds."""
    _require(approval.get("lang") == lang, "approval output language mismatch")
    path = run_dir(lang) / ANSWER_APPROVAL_PATH
    data = (
        json.dumps(approval, sort_keys=True, ensure_ascii=False, allow_nan=False) + "\n"
    ).encode()
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".tmp")
    temporary.write_bytes(data)
    temporary.replace(path)
    return {
        "answer_approval": {
            "relative_path": ANSWER_APPROVAL_PATH,
            "sha256": hashlib.sha256(data).hexdigest(),
            "run_id": approval["run_id"],
            "population_digest": approval["population_digest"],
            "evidence_digest": approval["evidence_digest"],
        }
    }


def _current_g6(lang: str) -> Mapping[str, Any]:
    """Latest actual attempts, including failures; an older success cannot hide one."""
    entries = list(read_entries(lang))
    latest = {entry["stage"]: (index, entry) for index, entry in enumerate(entries)}
    _require("g6" in latest, "G6 approval has never run")
    index, g6 = latest["g6"]
    for stage in ("g0", "g1", "g2", "g3", "g4", "g5"):
        _require(
            stage in latest and latest[stage][0] < index and latest[stage][1]["status"] == "ok",
            f"G6 approval is stale after {stage}",
        )
    return g6


def load_validated_answer_evidence(
    lang: str,
    sources: Iterable[SelectedSource],
    *,
    evidence: AnswerEvidence | None = None,
    g6_entry: Mapping[str, Any] | None = None,
) -> dict[tuple[int, int, int], ApprovedAnswers]:
    """G7 boundary: exact reviewed input, current successful G6 and immutable output."""
    sources = tuple(sources)
    if evidence is None:
        evidence = load_answer_evidence(lang, sources)
    entry = _current_g6(lang)
    if g6_entry is not None:
        _require(g6_entry == entry, "supplied G6 entry is not the latest actual attempt")
    _require(
        entry.get("lang") == lang and entry.get("stage") == "g6" and entry.get("status") == "ok",
        "G6 approval did not succeed",
    )
    note = entry.get("notes", {}).get("answer_approval")
    _fields(
        note,
        {"relative_path", "sha256", "run_id", "population_digest", "evidence_digest"},
        "G6 answer-approval note",
    )
    _require(
        note["relative_path"] == ANSWER_APPROVAL_PATH and note["run_id"] == entry["run_id"],
        "approval note belongs to another G6 run",
    )
    path = run_dir(lang) / ANSWER_APPROVAL_PATH
    _require(path.is_file() and not path.is_symlink(), "missing immutable G6 approval output")
    data = path.read_bytes()
    _require(hashlib.sha256(data).hexdigest() == note["sha256"], "G6 approval output was modified")
    try:
        approval = json.loads(data)
        _fields(
            approval,
            {
                "schema_version",
                "lang",
                "run_id",
                "population_digest",
                "evidence_digest",
                "occurrences",
            },
            "G6 answer approval",
        )
        _require(
            approval["schema_version"] == ANSWER_EVIDENCE_VERSION
            and approval["lang"] == lang
            and approval["run_id"] == entry["run_id"],
            "wrong G6 approval identity",
        )
        _require(
            approval["population_digest"]
            == note["population_digest"]
            == evidence.population_digest
            == source_population_digest(sources),
            "stale G6 selected population",
        )
        _require(
            approval["evidence_digest"] == note["evidence_digest"] == evidence.digest,
            "stale G6 authored answer evidence",
        )
        checks = {}
        for occurrence in approval["occurrences"]:
            _fields(occurrence, {"slot", "source_id", "review_hash", "surfaces"}, "occurrence")
            key = tuple(occurrence["slot"])
            _require(
                key not in checks and key in evidence.rows, "extra/duplicate approved occurrence"
            )
            row = evidence.rows[key]
            _require(
                occurrence["source_id"] == row["source"]["source_id"]
                and occurrence["review_hash"] == row["review"]["content_hash"],
                "approved occurrence has a crossed source/review join",
            )
            checks[key] = occurrence["surfaces"]
        rebuilt = build_answer_approval(lang, sources, evidence, checks, run_id=entry["run_id"])
        _require(rebuilt == approval, "approval structure differs from its current evidence")
    except (json.JSONDecodeError, KeyError, TypeError, SourceEvidenceError) as exc:
        raise AnswerEvidenceError("malformed or stale G6 answer approval") from exc
    return {
        source.slot: ApprovedAnswers(
            tuple(proof["text"] for proof in checks[source.slot] if proof["use"] == "forward"),
            tuple(proof["text"] for proof in checks[source.slot] if proof["use"] == "reverse_only"),
            {
                proof["text"]: proof["analysis"]
                for proof in checks[source.slot]
                if proof["use"] == "forward"
            },
            evidence.rows[source.slot]["review"]["content_hash"],
        )
        for source in sources
    }
