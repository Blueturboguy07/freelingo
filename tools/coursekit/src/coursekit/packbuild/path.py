"""Explicit signed path declaration, joined to the actual G9 population.

S010–S028; INV-PACK-03/56, INV-PATH-15/23. This is an authoring-input
boundary, not a new template generator. In particular no Spanish node mix, node ID
or Score ceiling is inferred from CEFR or level_count. G3's level_count and
LESSONS_PER_LEVEL remain the authoritative canonical lesson grouping constraints.

2026-09-13: revision 1 supports exercise-backed lesson/practice/unitReview nodes
and chest taps. Script and long-form nodes require distinct source declarations;
unsupported declarations fail, never disappear. The independent app decoder reads
this same wire and rechecks all actual SQL source joins before exposing a path.
"""

from __future__ import annotations

import copy
import hashlib
from collections.abc import Mapping, Sequence
from typing import Any

from ..config.g3 import LESSONS_PER_LEVEL
from .itemid import canonical_json

PATH_METADATA_KEY = "path:v1"
PATH_METADATA_VERSION = 1
PATH_NODE_TYPES = ("lesson", "practice", "unitReview", "chest")
PATH_BANDS = (
    ("very early A1", "A1", 0, 9),
    ("early A1", "A1", 10, 19),
    ("high A1", "A1", 20, 29),
    ("A2", "A2", 30, 59),
    ("early B1", "B1", 60, 79),
    ("high B1", "B1", 80, 99),
    ("early B2", "B2", 100, 114),
    ("high B2", "B2", 115, 129),
)
UNIT_SOURCE_FIELDS = (
    "unit_id",
    "section_index",
    "section_cefr",
    "unit_index",
    "title",
    "level_count",
)
EXERCISE_SOURCE_FIELDS = (
    "exercise_id",
    "item_id",
    "unit_id",
    "lesson_index",
    "slot_index",
    "type",
    "prompt",
    "preferred_surface",
    "register",
    "accepted_answers_json",
    "distractors_json",
    "source_sentence_id",
)
DECLARATION_FIELDS = (
    "schemaVersion",
    "packId",
    "courseId",
    "packVersion",
    "languageName",
    "scoreCeiling",
    "cefrChecked",
    "declaredNodeTypes",
    "legendaryDenominator",
    "sections",
)


def _require(condition: bool, detail: str) -> None:
    if not condition:
        raise ValueError("path: " + detail)


def _object(value: Any, fields: Sequence[str], detail: str) -> dict[str, Any]:
    _require(isinstance(value, dict) and set(value) == set(fields), detail + " fields")
    return value


def _text(value: Any, detail: str) -> str:
    _require(isinstance(value, str) and bool(value.strip()), detail)
    return value


def _int(value: Any, detail: str, minimum: int = 0) -> int:
    _require(type(value) is int and minimum <= value <= 9007199254740991, detail)
    return value


def _array(value: Any, detail: str, *, empty: bool = False) -> list[Any]:
    _require(isinstance(value, list) and (empty or bool(value)), detail)
    return value


def _strings(value: Any, detail: str, *, empty: bool = False) -> list[str]:
    values = _array(value, detail, empty=empty)
    for v in values:
        _text(v, detail)
    _require(len(set(values)) == len(values), detail + " duplicates")
    return values


def _hash(value: Any) -> str:
    return hashlib.sha256(canonical_json(value).encode("utf-8")).hexdigest()


def _source_rows(
    rows: Sequence[Mapping[str, Any]], fields: Sequence[str], identity: str
) -> list[dict[str, Any]]:
    result = []
    for row in rows:
        _require(
            isinstance(row, Mapping) and set(fields) <= set(row),
            "missing " + identity + " source fields",
        )
        projected = {key: row[key] for key in fields}
        _text(projected[identity], identity)
        result.append(projected)
    # IDs produced by G9 are ASCII; UTF-16 order also agrees with JavaScript for
    # any supplementary character a future original author explicitly chooses.
    result.sort(key=lambda row: row[identity].encode("utf-16-be"))
    _require(len({row[identity] for row in result}) == len(result), "duplicate " + identity)
    return result


def build_path_metadata(
    declaration: Mapping[str, Any],
    unit_rows: Sequence[Mapping[str, Any]],
    exercise_rows: Sequence[Mapping[str, Any]],
) -> dict[str, Any]:
    d = _object(copy.deepcopy(declaration), DECLARATION_FIELDS, "declaration")
    _require(
        d["schemaVersion"] == PATH_METADATA_VERSION and type(d["schemaVersion"]) is int, "version"
    )
    for key in ("packId", "courseId", "packVersion", "languageName"):
        _text(d[key], key)
    _require(type(d["cefrChecked"]) is bool, "cefrChecked")
    ceiling = _int(d["scoreCeiling"], "score ceiling")
    declared = _strings(d["declaredNodeTypes"], "declared node types")
    _require(set(declared) <= set(PATH_NODE_TYPES), "unsupported node source declaration")
    denominator = _strings(d["legendaryDenominator"], "legendary denominator", empty=True)
    _require(set(denominator) <= set(declared) & {"lesson", "practice"}, "legendary denominator")
    units = _source_rows(unit_rows, UNIT_SOURCE_FIELDS, "unit_id")
    exercises = _source_rows(exercise_rows, EXERCISE_SOURCE_FIELDS, "exercise_id")
    _require(bool(units) and bool(exercises), "empty source population")
    source_units = {row["unit_id"]: row for row in units}
    for unit in units:
        for key in ("unit_index", "section_index", "level_count"):
            _int(unit[key], key, 1)
        _text(unit["title"], "unit title")
        _text(unit["section_cefr"], "section CEFR")
    by_lesson: dict[tuple[str, int], list[dict[str, Any]]] = {}
    for row in exercises:
        _text(row["unit_id"], "exercise unit")
        _require(row["unit_id"] in source_units, "unknown exercise unit")
        _int(row["lesson_index"], "lesson index", 1)
        _int(row["slot_index"], "slot index")
        for field in EXERCISE_SOURCE_FIELDS:
            if field not in ("lesson_index", "slot_index", "source_sentence_id"):
                _text(row[field], "exercise " + field)
        if row["source_sentence_id"] is not None:
            _text(row["source_sentence_id"], "source sentence")
        by_lesson.setdefault((row["unit_id"], row["lesson_index"]), []).append(row)
    for rows in by_lesson.values():
        _require(len({row["slot_index"] for row in rows}) == len(rows), "duplicate lesson slot")
        rows.sort(key=lambda row: (row["slot_index"], row["exercise_id"].encode("utf-16-be")))
    seen_units = []
    seen_nodes = set()
    used_types = set()
    source_section_ids = []
    last_band = -1
    absolute_unit = 0
    for section in _array(d["sections"], "sections"):
        _object(section, ("sectionIndex", "title", "band", "units"), "section")
        section_id = _int(section["sectionIndex"], "section index", 1)
        source_section_ids.append(section_id)
        _text(section["title"], "section title")
        band = next((i for i, row in enumerate(PATH_BANDS) if row[0] == section["band"]), None)
        _require(band is not None and band >= last_band, "section band ordering")
        last_band = band
        for unit in _array(section["units"], "section units"):
            _object(unit, ("unitId", "unitIndex", "title", "colourIndex", "nodes"), "unit")
            identifier = _text(unit["unitId"], "unit ID")
            source = source_units.get(identifier)
            _require(source is not None and identifier not in seen_units, "unit population")
            _int(unit["unitIndex"], "declared unit index", 1)
            absolute_unit += 1
            _require(unit["unitIndex"] == source["unit_index"] == absolute_unit, "unit order/index")
            _require(source["section_index"] == section_id, "unit section binding")
            _require(source["section_cefr"] == PATH_BANDS[band][1], "section CEFR binding")
            _require(unit["title"] == source["title"], "unit title binding")
            _int(unit["colourIndex"], "colour index")
            seen_units.append(identifier)
            lesson_indices = sorted(lesson for uid, lesson in by_lesson if uid == identifier)
            canonical_lessons = []
            canonical_nodes = 0
            nodes = _array(unit["nodes"], "unit nodes")
            _require(
                isinstance(nodes[0], dict) and nodes[0].get("type") == "lesson",
                "unit must start with a canonical lesson",
            )
            for node in nodes:
                _object(
                    node,
                    ("nodeId", "type", "sessions", "introducesScriptUnits", "requiresScriptUnits"),
                    "node",
                )
                node_id = _text(node["nodeId"], "node ID")
                kind = node["type"]
                _require(node_id not in seen_nodes, "duplicate node ID")
                seen_nodes.add(node_id)
                _require(kind in declared, "undeclared node type")
                used_types.add(kind)
                _require(
                    node["introducesScriptUnits"] == [] and node["requiresScriptUnits"] == [],
                    "script source declaration unavailable",
                )
                sessions = _array(node["sessions"], "node sessions", empty=kind == "chest")
                _require(kind != "chest" or not sessions, "chest may not claim lesson sources")
                seen_lessons = set()
                if kind == "lesson":
                    canonical_nodes += 1
                    _require(len(sessions) == LESSONS_PER_LEVEL, "canonical lessons per level")
                for session in sessions:
                    _object(session, ("lessonIndex", "exerciseIds"), "session")
                    lesson = _int(session["lessonIndex"], "session lesson", 1)
                    _require(lesson not in seen_lessons, "duplicate session lesson")
                    seen_lessons.add(lesson)
                    refs = _strings(session["exerciseIds"], "exercise population")
                    actual = by_lesson.get((identifier, lesson), [])
                    _require(
                        refs == [row["exercise_id"] for row in actual],
                        "exact ordered lesson population",
                    )
                    if kind == "lesson":
                        canonical_lessons.append(lesson)
            _require(canonical_nodes == source["level_count"], "canonical level count")
            _require(canonical_lessons == lesson_indices, "canonical lesson partition/order")
    _require(len(seen_units) == len(units), "missing unit population")
    _require(
        source_section_ids == sorted({u["section_index"] for u in units}),
        "section population/order",
    )
    _require(used_types == set(declared), "declared node type population")
    _require(
        PATH_BANDS[last_band][2] <= ceiling <= PATH_BANDS[last_band][3],
        "score ceiling outside final band",
    )
    return {
        **d,
        "lessonsPerLevel": LESSONS_PER_LEVEL,
        "proof": {
            "declarationSha256": _hash(d),
            "unitRowsSha256": _hash(units),
            "exerciseRowsSha256": _hash(exercises),
        },
    }
