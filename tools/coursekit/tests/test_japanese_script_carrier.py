from copy import deepcopy

import pytest
from test_japanese_script_analysis import record

from coursekit.artifacts import (
    ArtifactError,
    artifact_path,
    read_records,
    validate_record,
    write_records,
)
from coursekit.japanese_script import validate_script_analysis


def test_INV_PACK_43_paired_script_records_roundtrip_without_losing_unicode_spans(tmp_path):
    text, analysis, script = record()
    path = tmp_path / "scripts.jsonl"
    assert write_records("japanese_script_analysis", [script], path=path) == 1
    loaded = list(read_records("japanese_script_analysis", path=path))
    assert loaded == [script]
    assert validate_script_analysis(loaded[0], analysis, text=text).mode_a_to_mode_c == (
        0,
        0,
        0,
        1,
        2,
    )
    assert artifact_path("ja", "japanese_script_analysis").name == "scripts.jsonl"


@pytest.mark.parametrize(
    "key,value",
    [
        ("lang", "es"),
        ("reading_review_status", "reviewed"),
        ("text_sha256", "bad"),
        ("analysis_sha256", "bad"),
        ("mode_c_tokens", []),
        ("mode_a_surface_readings", []),
        ("tts_reading", "漢字"),
        ("tts_reading", "kana123"),
        ("tts_reading", "   "),
    ],
)
def test_INV_PACK_52_script_carrier_refuses_invalid_record_shapes(key, value):
    _, _, script = record()
    bad = deepcopy(script)
    bad[key] = value
    with pytest.raises(ArtifactError):
        validate_record("japanese_script_analysis", bad)


def test_INV_PACK_43_script_objects_are_closed_all_the_way_down():
    _, _, script = record()
    script["mode_c_tokens"][0]["verified"] = True
    with pytest.raises(ArtifactError):
        validate_record("japanese_script_analysis", script)
