"""INV-PACK-41 — item ids are hashed over the semantic fields only.

The falsifier is `tests/falsifiers/INV-PACK-41.json`: a rebuild after a distractor swap,
plus every other presentation field EC-PACK-38 names, plus the four semantic changes that
MUST mint a new id — because "ids never change" would pass the first eleven cases and be
a useless property.

The other thing this file pins is that there is one rule, not two. `packbuild/itemid.py`
and `packages/schema/src/pack-schema.ts` implement the same hash in two languages, so the
field lists are read out of the TypeScript file rather than agreed by eye, and both sides
assert the same golden vector.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from coursekit.config.g9 import (
    ITEM_ID_GOLDEN_INPUT,
    ITEM_ID_GOLDEN_OUTPUT,
    PACK_SCHEMA_TS_RELPATH,
    PRESENTATION_FIELDS_ARRAY_NAME,
    PRESENTATION_ITEM_FIELDS,
    SEMANTIC_FIELDS_ARRAY_NAME,
    SEMANTIC_ITEM_FIELDS,
)
from coursekit.packbuild.itemid import canonical_json, item_id, semantic_item_content
from coursekit.packbuild.sqlite import exercise_rows, read_ts_string_array, repo_root

FALSIFIER = json.loads(
    (Path(__file__).parent / "falsifiers" / "INV-PACK-41.json").read_text(encoding="utf-8")
)


def _semantic_of(exercise: dict[str, Any]) -> dict[str, Any]:
    """The same projection `exercise_rows` uses, so the test hashes what the pack does."""
    tags = exercise["item_tags"]
    return {
        "prompt": exercise["prompt"],
        "preferredSurface": exercise["accepted_answers"][0],
        "register": exercise["register"],
        "lexemes": list(tags["lemmas"]),
        "grammarConcepts": list(tags.get("grammar_concepts", [])),
        "graphemes": list(tags.get("graphemes", [])),
    }


# ---------------------------------------------------------------------------
# The falsifier
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("case", FALSIFIER["cases"], ids=lambda case: case["why"][:60])
def test_INV_PACK_41_falsifier(case: dict[str, Any]) -> None:
    """[INV-PACK-41] a rebuild after a presentation change leaves every item id intact."""
    before = dict(FALSIFIER["base"])
    after = {**before, **case["change"]}

    before_id = item_id(_semantic_of(before))
    after_id = item_id(_semantic_of(after))

    if case["idChanges"]:
        assert before_id != after_id, case["why"]
    else:
        assert before_id == after_id, case["why"]


def test_INV_PACK_41_holds_through_the_real_writer() -> None:
    """[INV-PACK-41] the same, through `exercise_rows`, not just through the hash.

    The hash being right is not the invariant. The invariant is that a REBUILD leaves the
    ids alone, and a rebuild goes through the writer — which is where a future edit might
    helpfully fold the distractor pool or the audio ref into the id.
    """
    from coursekit.packbuild.sqlite import PackInputs

    base = dict(FALSIFIER["base"])
    swapped = {**base, **{"distractors": ["It is raining today.", "It is hot tomorrow."]}}
    units = (
        {
            "unit_index": 1,
            "section_index": 1,
            "section_cefr": "A1",
            "unit_title": "Weather",
            "function": "Talk about the weather",
            "grammar_concept": "present-adjective",
            "register_slot": "graded_honorific",
            "target_lemmas": ["今日"],
            "level_count": 3,
        },
    )

    def ids(exercise: dict[str, Any]) -> list[str]:
        inputs = PackInputs(
            lang="ja",
            pack_id="p",
            course_id="c",
            major=0,
            version="0",
            units=units,
            exercises=(exercise,),
        )
        return [row["item_id"] for row in exercise_rows(inputs)]

    assert ids(base) == ids(swapped)


# ---------------------------------------------------------------------------
# One rule, two languages
# ---------------------------------------------------------------------------


def test_the_field_lists_come_from_the_typescript_file() -> None:
    """[INV-PACK-41] the semantic/presentation split is read, not remembered.

    Two implementations that each carry their own copy of the list agree until somebody
    adds a field to one of them, and the failure — ids that differ between the builder
    and the app — surfaces as FSRS rows that never resolve on a device.
    """
    schema = repo_root() / PACK_SCHEMA_TS_RELPATH
    assert read_ts_string_array(schema, SEMANTIC_FIELDS_ARRAY_NAME) == SEMANTIC_ITEM_FIELDS
    assert read_ts_string_array(schema, PRESENTATION_FIELDS_ARRAY_NAME) == PRESENTATION_ITEM_FIELDS


def test_the_two_lists_are_disjoint() -> None:
    """A field on both sides would be a rule that says nothing."""
    assert set(SEMANTIC_ITEM_FIELDS).isdisjoint(PRESENTATION_ITEM_FIELDS)


def test_every_field_ec_pack_38_names_is_on_a_side() -> None:
    """EC-PACK-38's ruling, item by item, so a dropped one is a failing test."""
    assert set(SEMANTIC_ITEM_FIELDS) == {
        "prompt",
        "preferredSurface",
        "register",
        "lexemes",
        "grammarConcepts",
        "graphemes",
    }
    assert {
        "ruby",
        "audioHash",
        "strokePaths",
        "illustration",
        "acceptedAlternates",
        "distractors",
    } <= set(PRESENTATION_ITEM_FIELDS)


def test_the_golden_vector_pins_python_to_typescript() -> None:
    """[INV-PACK-41] the same input hashes to the same id on both sides.

    `packages/schema/src/pack-schema.test.ts` asserts this exact literal from the other
    language. Two implementations of one hash need a shared VALUE, not a shared reading
    of a paragraph: canonical JSON, UTF-8, key sorting and `ensure_ascii` are four
    separate ways to disagree, and `¿Cómo estás?` exercises all of them.
    """
    assert item_id(ITEM_ID_GOLDEN_INPUT) == ITEM_ID_GOLDEN_OUTPUT


def test_canonical_json_leaves_non_ascii_alone() -> None:
    """`ensure_ascii=True` would escape every Spanish accent and change every id."""
    assert canonical_json({"b": "á", "a": 1}) == '{"a":1,"b":"á"}'


def test_tag_order_does_not_reach_the_hash_but_list_order_elsewhere_still_can() -> None:
    """Tag arrays are sorted in the projection; nothing else is sorted for you."""
    assert semantic_item_content(
        {**ITEM_ID_GOLDEN_INPUT, "lexemes": ["estar", "cómo"]}
    ) == semantic_item_content({**ITEM_ID_GOLDEN_INPUT, "lexemes": ["cómo", "estar"]})
    assert canonical_json(["b", "a"]) == '["b","a"]'


def test_a_missing_semantic_field_raises_rather_than_defaulting() -> None:
    """A defaulted field collides two different items onto one FSRS row, silently."""
    incomplete = {key: value for key, value in ITEM_ID_GOLDEN_INPUT.items() if key != "register"}
    with pytest.raises(KeyError, match="register"):
        item_id(incomplete)
