"""Rebuild this test-only optional path fixture through the actual G9 writer.

The original es-mini Spanish rows keep their source credits. Only this test copy's
canonical level count and lesson coordinates change to make a complete two-level,
four-session miniature; neither the original fixture nor production data is edited.
"""

import json
from dataclasses import replace
from pathlib import Path

from coursekit.packbuild.path import build_path_metadata
from coursekit.packbuild.sqlite import build_rows, fixture_inputs, write_pack


def build(destination: Path) -> Path:
    seed = fixture_inputs()

    def global_lessons(rows):
        return tuple(
            {**row, "lesson_index": row["lesson_index"] + (2 if row["unit_index"] == 2 else 0)}
            for row in rows
        )

    inputs = replace(
        seed,
        units=tuple({**u, "level_count": 1} for u in seed.units),
        exercises=global_lessons(seed.exercises),
        selected=global_lessons(seed.selected),
        candidates=global_lessons(seed.candidates),
    )
    rows = build_rows(inputs)
    units = sorted(rows["unit"], key=lambda u: u["unit_index"])
    declaration = {
        "schemaVersion": 1,
        "packId": inputs.pack_id,
        "courseId": inputs.course_id,
        "packVersion": inputs.version,
        "languageName": "Spanish",
        "scoreCeiling": 9,
        "cefrChecked": True,
        "declaredNodeTypes": ["lesson"],
        "legendaryDenominator": ["lesson"],
        "sections": [
            {"sectionIndex": 1, "title": "Test-only section", "band": "very early A1", "units": []}
        ],
    }
    for unit in units:
        exercises = [e for e in rows["exercise"] if e["unit_id"] == unit["unit_id"]]
        sessions = [
            {
                "lessonIndex": lesson,
                "exerciseIds": [
                    e["exercise_id"]
                    for e in sorted(exercises, key=lambda e: e["slot_index"])
                    if e["lesson_index"] == lesson
                ],
            }
            for lesson in sorted({e["lesson_index"] for e in exercises})
        ]
        declaration["sections"][0]["units"].append(
            {
                "unitId": unit["unit_id"],
                "unitIndex": unit["unit_index"],
                "title": unit["title"],
                "colourIndex": unit["unit_index"] - 1,
                "nodes": [
                    {
                        "nodeId": unit["unit_id"] + ":learn",
                        "type": "lesson",
                        "sessions": sessions,
                        "introducesScriptUnits": [],
                        "requiresScriptUnits": [],
                    }
                ],
            }
        )
    metadata = build_path_metadata(declaration, rows["unit"], rows["exercise"])
    rows["meta"].append(
        {"key": "path:v1", "value": json.dumps(metadata, ensure_ascii=False, sort_keys=True)}
    )
    return write_pack(destination, rows)


if __name__ == "__main__":
    build(Path(__file__).with_name("loader-pack.sqlite"))
