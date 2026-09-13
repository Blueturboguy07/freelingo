"""Read selected lexical Radio targets from an exact immutable pack snapshot.

This boundary checks the declared target joins it consumes, not all grading/runtime
families. The caller supplies the expected verified/build-approved pack digest; this
reader is not a signature verifier, source reviewer, or fallback dictionary.
"""

from __future__ import annotations

import copy
import hashlib
import json
import re
import sqlite3
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from ..packbuild.itemid import canonical_json, item_id
from .compiler import NarrativeError
from .radio import _closed, _integer, _pairs, _require, _text


@dataclass(frozen=True)
class RadioPackTargets:
    pack_sha256: str
    language: str
    _targets: dict[tuple[str, str, str], dict[str, Any]]

    def resolve(self, exercise_id: str, scheduler_item_id: str, surface_id: str) -> dict[str, Any]:
        try:
            return copy.deepcopy(self._targets[(exercise_id, scheduler_item_id, surface_id)])
        except KeyError as exc:
            raise NarrativeError(
                "Radio target: undeclared exact exercise/scheduler/surface reference."
            ) from exc


def _sha(value):
    _require(
        isinstance(value, str) and re.fullmatch(r"[0-9a-f]{64}", value) is not None,
        "Radio target: malformed SHA256.",
    )
    return value


def _file_hash(path):
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def _json(text):
    return json.loads(text, object_pairs_hook=_pairs)


def _single(rows, where):
    _require(len(rows) == 1, "Radio target: missing or ambiguous " + where + ".")
    return rows[0]


def _identity(binding, definition, language):
    _closed(
        binding,
        {
            "schedulerItemId",
            "surfaceId",
            "surface",
            "language",
            "lexemeId",
            "lemma",
            "pos",
            "wordItemId",
            "semantic",
            "countable",
            "classification",
            "proof",
        },
        "Radio target lexical binding",
    )
    for key in (
        "schedulerItemId",
        "surfaceId",
        "surface",
        "language",
        "lexemeId",
        "lemma",
        "pos",
        "wordItemId",
    ):
        _text(binding[key], "Radio target " + key)
    _require(
        binding["language"] == language
        and definition is not None
        and (binding["lemma"], binding["pos"]) == tuple(definition),
        "Radio target: actual lexical definition/language mismatch.",
    )
    _require(
        type(binding["countable"]) is bool
        and binding["classification"] in {"word", "particle", "bound-morpheme", "character"}
        and (not binding["countable"] or binding["classification"] == "word"),
        "Radio target: invalid explicit countability/classification.",
    )
    semantic = _closed(
        binding["semantic"],
        {"prompt", "preferredSurface", "register", "lexemes", "grammarConcepts", "graphemes"},
        "Radio target lexical semantics",
    )
    for key in ("prompt", "preferredSurface", "register"):
        _text(semantic[key], "Radio target semantic " + key)
    _require(
        semantic["lexemes"] == [binding["lemma"]]
        and semantic["grammarConcepts"] == []
        and semantic["graphemes"] == []
        and binding["wordItemId"] == item_id(semantic),
        "Radio target: semantic identity/tag mismatch.",
    )
    surface_hash = (
        "sf_"
        + hashlib.sha256(canonical_json([language, binding["surface"]]).encode()).hexdigest()[:32]
    )
    _require(binding["surfaceId"] == surface_hash, "Radio target: surface identity mismatch.")


def load_radio_targets(
    path: Path,
    *,
    expected_sha256: str,
    references: list[dict[str, str]],
    maximum_unit_index: int | None = None,
) -> RadioPackTargets:
    """Read only requested exact targets; never map a lemma to the first available ID.

    The returned snapshot keeps full semantic content and review/source hashes. A
    compiler must separately bind each displayed surface to the Radio source occurrence,
    validate its placement, and obtain independent review. Nothing here awards credit.
    """
    try:
        path = Path(path).resolve(strict=True)
        expected = _sha(expected_sha256)
        _require(
            _file_hash(path) == expected,
            "Radio target: pack bytes differ from the expected snapshot.",
        )
        for suffix in ("-wal", "-journal"):
            sidecar = Path(str(path) + suffix)
            _require(
                not sidecar.exists() or sidecar.stat().st_size == 0,
                "Radio target: mutable SQLite sidecar is unsupported.",
            )
        _require(
            isinstance(references, list) and bool(references),
            "Radio target: explicit references required.",
        )
        if maximum_unit_index is not None:
            _integer(maximum_unit_index, "Radio target maximum unit")
        values = {}
        identities = {}
        with sqlite3.connect(path.as_uri() + "?mode=ro", uri=True) as db:
            db.execute("BEGIN")
            language = _text(
                _single(
                    db.execute("SELECT value FROM meta WHERE key='lang'").fetchall(),
                    "pack language",
                )[0],
                "Radio target language",
            )
            for ref in references:
                _closed(
                    ref, {"exerciseId", "schedulerItemId", "surfaceId"}, "Radio target reference"
                )
                key = tuple(
                    _text(ref[k], "Radio target reference")
                    for k in ("exerciseId", "schedulerItemId", "surfaceId")
                )
                _require(key not in values, "Radio target: duplicate reference.")
                eid, sid, surface_id = key
                raw, payload_hash = _single(
                    db.execute(
                        "SELECT payload_json,payload_sha256 FROM exercise_runtime "
                        "WHERE exercise_id=?",
                        (eid,),
                    ).fetchall(),
                    "runtime payload",
                )
                _require(
                    isinstance(raw, str)
                    and hashlib.sha256(raw.encode()).hexdigest() == _sha(payload_hash),
                    "Radio target: runtime payload hash mismatch.",
                )
                runtime = _json(raw)
                _require(
                    isinstance(runtime, dict)
                    and type(runtime.get("schemaVersion")) is int
                    and runtime["schemaVersion"] == 1,
                    "Radio target: unsupported runtime revision.",
                )
                exercise = _single(
                    db.execute(
                        "SELECT item_id,unit_id,lesson_index,source_sentence_id FROM exercise "
                        "WHERE exercise_id=?",
                        (eid,),
                    ).fetchall(),
                    "actual exercise",
                )
                _require(
                    (
                        runtime["exerciseId"],
                        runtime["itemId"],
                        runtime["unitId"],
                        runtime["lessonIndex"],
                    )
                    == (eid, *exercise[:3]),
                    "Radio target: actual exercise placement/identity mismatch.",
                )
                unit_index = _integer(
                    _single(
                        db.execute(
                            "SELECT unit_index FROM unit WHERE unit_id=?", (runtime["unitId"],)
                        ).fetchall(),
                        "actual unit",
                    )[0],
                    "Radio target unit",
                )
                _require(
                    maximum_unit_index is None or unit_index <= maximum_unit_index,
                    "Radio target: target comes from a future unit.",
                )
                proof = _closed(
                    runtime["proof"],
                    {"sourceId", "sourceSha256", "approvalId", "approvalSha256", "draftSha256"},
                    "Radio target runtime proof",
                )
                for field in ("sourceId", "approvalId"):
                    _text(proof[field], "Radio target runtime proof")
                for field in ("sourceSha256", "approvalSha256", "draftSha256"):
                    _sha(proof[field])
                _require(
                    exercise[3] is None or exercise[3] == proof["sourceId"],
                    "Radio target: actual source identity mismatch.",
                )
                scheduler = _single(
                    [
                        r
                        for r in runtime["schedulerSurfaces"]
                        if r.get("itemId") == sid and r.get("surfaceId") == surface_id
                    ],
                    "scheduler surface",
                )
                _closed(
                    scheduler,
                    {"itemId", "kind", "itemRef", "surfaceId", "surface", "language", "canonical"},
                    "Radio target scheduler",
                )
                _require(
                    scheduler["kind"] == "lexeme" and type(scheduler["canonical"]) is bool,
                    "Radio target: declared lexical scheduler target required.",
                )
                binding = _single(
                    [
                        r
                        for r in runtime["lexicalBindings"]
                        if r.get("schedulerItemId") == sid and r.get("surfaceId") == surface_id
                    ],
                    "lexical surface",
                )
                definition = db.execute(
                    "SELECT lemma,pos FROM lexeme WHERE lexeme_id=?", (binding["lexemeId"],)
                ).fetchone()
                _identity(binding, definition, language)
                _require(
                    scheduler["itemRef"] == binding["lexemeId"]
                    and all(
                        scheduler[k] == binding[k] for k in ("surfaceId", "surface", "language")
                    ),
                    "Radio target: lexical/scheduler surface mismatch.",
                )
                _require(
                    db.execute(
                        "SELECT 1 FROM exercise_item_tag WHERE exercise_id=? "
                        "AND item_kind=? AND item_ref=?",
                        (eid, "lexeme", binding["lemma"]),
                    ).fetchone()
                    is not None,
                    "Radio target: actual exercise tag missing.",
                )
                lexical_proof = _closed(
                    binding["proof"],
                    {"sourceId", "sourceSha256", "declarationSha256", "bindingSha256"},
                    "Radio target lexical proof",
                )
                _require(
                    all(lexical_proof[k] == proof[k] for k in ("sourceId", "sourceSha256")),
                    "Radio target: stale lexical source proof.",
                )
                for k in ("sourceSha256", "declarationSha256", "bindingSha256"):
                    _sha(lexical_proof[k])
                identity = {k: binding[k] for k in ("semantic", "countable", "classification")}
                previous = identities.setdefault(binding["wordItemId"], identity)
                _require(
                    previous == identity,
                    "Radio target: conflicting full lexical semantic identity.",
                )
                values[key] = {
                    "exerciseId": eid,
                    "runtimeSha256": payload_hash,
                    "sourceProof": proof,
                    "unitIndex": unit_index,
                    "lexical": binding,
                    "scheduler": scheduler,
                }
        _require(_file_hash(path) == expected, "Radio target: pack changed during extraction.")
        return RadioPackTargets(expected, language, copy.deepcopy(values))
    except (OSError, sqlite3.Error, ValueError, KeyError, TypeError, AttributeError) as exc:
        if isinstance(exc, NarrativeError):
            raise
        raise NarrativeError(
            f"Radio target: missing, malformed or unreadable source evidence: {exc}"
        ) from exc
