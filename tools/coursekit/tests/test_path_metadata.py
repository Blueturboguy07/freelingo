"""S010–S028 source-bound path metadata, not a new course population."""

import copy
import json
from pathlib import Path

import pytest

from coursekit.packbuild.path import build_path_metadata

FIXTURE = Path(__file__).parent / "fixtures/path/declared-input.json"


def inputs():
    data = json.loads(FIXTURE.read_text())
    return data["declaration"], data["units"], data["exercises"]


def build(declaration=None, units=None, exercises=None):
    d, u, e = inputs()
    return build_path_metadata(
        declaration or d,
        units if units is not None else u,
        exercises if exercises is not None else e,
    )


def test_path_keeps_authored_node_mix_and_exact_sessions_without_six_node_inference():
    d, u, e = inputs()
    result = build_path_metadata(d, u, e)
    assert result["sections"] == d["sections"]
    assert result["scoreCeiling"] == 19
    assert result["lessonsPerLevel"] == 2
    assert len(result["sections"][0]["units"][0]["nodes"]) == 3
    assert result["proof"]["declarationSha256"]
    assert d == inputs()[0]
    e[0]["prompt"] = "Changed after build"
    assert result["proof"]["exerciseRowsSha256"] != build(d, u, e)["proof"]["exerciseRowsSha256"]


def test_path_requires_explicit_ceiling_and_node_declaration():
    d, _, _ = inputs()
    del d["scoreCeiling"]
    with pytest.raises(ValueError, match="path"):
        build(d)
    d, _, _ = inputs()
    d["sections"][0]["units"][0]["nodes"] = []
    with pytest.raises(ValueError, match="path"):
        build(d)


@pytest.mark.parametrize(
    "change",
    [
        lambda d: d["sections"][0]["units"][0]["nodes"][0]["sessions"][0]["exerciseIds"].pop(),
        lambda d: d["sections"][0]["units"][0]["nodes"][0]["sessions"][0]["exerciseIds"].reverse(),
        lambda d: d["sections"][0]["units"][0]["nodes"][0]["sessions"][0].update(lessonIndex=201),
        lambda d: d["sections"][1]["units"][0]["nodes"][0].update(nodeId="u001:learn"),
        lambda d: d["sections"][0]["units"][0]["nodes"].reverse(),
        lambda d: d["sections"][0]["units"][0]["nodes"][0].update(type="unitRewind"),
        lambda d: d["sections"][0]["units"][0]["nodes"][0].update(type="jumpHere"),
        lambda d: d["sections"][0]["units"][0]["nodes"][0].update(type="story"),
        lambda d: d["sections"][0]["units"][0]["nodes"][0].update(
            introducesScriptUnits=["invented-grapheme"]
        ),
        lambda d: d.update(scoreCeiling=129),
        lambda d: d.update(legendaryDenominator=["chest"]),
    ],
)
def test_path_rejects_incomplete_reordered_cross_unit_or_unproved_declarations(change):
    d, _, _ = inputs()
    change(d)
    with pytest.raises(ValueError, match="path"):
        build(d)


def test_path_rejects_omitted_unit_and_undeclared_extra_exercise():
    d, u, e = inputs()
    d["sections"].pop()
    with pytest.raises(ValueError, match="path"):
        build(d, u, e)
    d, u, e = inputs()
    e.append({**e[0], "exercise_id": "extra", "slot_index": 3})
    with pytest.raises(ValueError, match="path"):
        build(d, u, e)


def test_path_rejects_corrupt_source_rows_without_repair_or_dropping_them():
    d, u, e = inputs()
    u[0]["level_count"] = 2
    with pytest.raises(ValueError, match="path"):
        build(d, u, e)
    d, u, e = inputs()
    e[0]["lesson_index"] = True
    with pytest.raises(ValueError, match="path"):
        build(d, u, e)
    d, u, e = inputs()
    e.append(copy.deepcopy(e[0]))
    with pytest.raises(ValueError, match="path"):
        build(d, u, e)


def test_path_golden_is_the_actual_producer_output():
    expected = FIXTURE.with_name("produced-metadata.json")
    assert build() == json.loads(expected.read_text())


@pytest.mark.parametrize(
    "change",
    [
        lambda d: d["sections"][0]["units"][0].update(unitIndex=True),
        lambda d: d["sections"][0]["units"][0]["nodes"].__setitem__(0, None),
        lambda d: d["sections"][0]["units"][0]["nodes"].__setitem__(0, []),
    ],
)
def test_path_malformed_input_is_a_named_rejection(change):
    d, _, _ = inputs()
    change(d)
    with pytest.raises(ValueError, match="path"):
        build(d)


def test_path_accepts_the_actual_g9_zero_based_slot_and_writer_boundary(tmp_path):
    import importlib.util
    import sqlite3

    spec = importlib.util.spec_from_file_location(
        "path_loader_fixture", FIXTURE.with_name("build_loader_fixture.py")
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    database = module.build(tmp_path / "pack.sqlite")
    assert database.read_bytes() == FIXTURE.with_name("loader-pack.sqlite").read_bytes()
    with sqlite3.connect(database) as connection:
        assert connection.execute("SELECT MIN(slot_index) FROM exercise").fetchone()[0] == 0
        value = json.loads(
            connection.execute("SELECT value FROM meta WHERE key='path:v1'").fetchone()[0]
        )
        assert value["sections"][0]["units"][1]["nodes"][0]["sessions"][0]["lessonIndex"] == 3
        assert connection.execute("PRAGMA foreign_key_check").fetchall() == []
