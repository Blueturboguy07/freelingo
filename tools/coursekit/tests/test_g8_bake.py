"""The G8 stage: what gets a clip, and the budget arithmetic INV-PACK-15 asserts.

The budget tests are the ones that matter here, and the committed falsifier is
`falsifiers/INV-PACK-15.json`. Review R14's finding was not that somebody computed a
size wrong; it was that the size was computed against ONE of three denominators while
Stories and Radio ride the same cast, the same validators and the same budget. A
manifest carrying only a lesson row is comfortably inside 120 MB and is exactly the
shape of the estimate that was refuted, so "all three pipelines are present and sized"
is the property under test, not "the total is small enough".

The stage's rendering half is not unit-tested with a mock engine. Mocking Kokoro would
test the mock: the properties that matter — that the shipped Opus file measures within
tolerance of the target, that `opusenc` accepts what the levelling produces — are only
true of real audio, and `test_a_real_clip_survives_the_whole_chain` runs the real one
when the weights are on the machine.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from coursekit.config import (
    ARTIFACT_SCHEMA_VERSION,
    AUDIO_BUDGET_MB,
    AUDIO_PIPELINES,
    OPUS_BITRATE_KBPS,
)
from coursekit.config.g8 import (
    AUDIO_BUDGET_BYTES,
    BUDGET_HEADROOM_BYTES,
    BYTES_PER_MB,
    BYTES_PER_SECOND_AT_BITRATE,
    CAST_SAMPLE_TEXT,
    LESSON_ROLE,
    MASTER_MAX_PASSES,
    PEAK_CEILING_DBFS,
    PIPELINE_RESERVED_BYTES,
    TARGET_TEXT_FIELD_BY_TYPE,
)
from coursekit.inputs import group_is_installed
from coursekit.stages.g8_bake import build_manifest, plan_utterances
from coursekit.tts.cast import load_cast, rebake_key

FALSIFIERS = Path(__file__).parent / "falsifiers"
PACK15 = json.loads((FALSIFIERS / "INV-PACK-15.json").read_text(encoding="utf-8"))["input"]


def _exercise(kind: str, prompt: str, answer: str, index: int = 1) -> dict[str, Any]:
    return {
        "schema_version": ARTIFACT_SCHEMA_VERSION,
        "lang": "es",
        "exercise_id": f"{index:016x}",
        "unit_index": 1,
        "lesson_index": 1,
        "type": kind,
        "prompt": prompt,
        "accepted_answers": [answer],
        "distractors": [],
        "alignment": [],
        "item_tags": {"lemmas": ["x"], "grammar_concepts": []},
        "audio_ref": None,
        "register": "neutral",
        "source_sentence_id": None,
    }


def _entry(pipeline: str, byte_count: int, clip_id: str, duration_ms: int = 2000) -> dict[str, Any]:
    return {
        "clip_id": clip_id,
        "role": LESSON_ROLE,
        "voice": "ef_dora:1.000@1.000",
        "engine": "kokoro",
        "engine_pin": "model-files-v1.0",
        "pipeline": pipeline,
        "role_sample": False,
        "text": "Hola.",
        "path": f"bank/{clip_id}.opus",
        "sha256": "0" * 64,
        "bytes": byte_count,
        "duration_ms": duration_ms,
        "loudness_lufs": -16.0,
        "loudness_gated": True,
        "peak_dbfs": -1.0,
        "limiter_reduction_db": 0.0,
    }


# ---------------------------------------------------------------------------
# Planning — V7's "every renderable string has audio", at the source
# ---------------------------------------------------------------------------


def test_every_cast_role_gets_a_sample_clip_even_with_no_exercises() -> None:
    """S002 plays a sample per speaker, so three of four voices are not dead weight."""
    cast = load_cast("es")
    planned = plan_utterances(cast, [])
    assert {u.role_id for u in planned} == set(CAST_SAMPLE_TEXT)
    assert all(u.role_sample for u in planned)


def test_two_exercises_showing_one_sentence_share_one_file() -> None:
    cast = load_cast("es")
    text = "El gato duerme en la silla."
    planned = plan_utterances(
        cast,
        [_exercise("listen", "The cat sleeps", text, 1), _exercise("word_bank", "x", text, 2)],
    )
    lesson = [u for u in planned if not u.role_sample]
    assert len(lesson) == 1
    assert lesson[0].clip_id == rebake_key(cast, LESSON_ROLE, text)


def test_a_match_exercise_asks_for_no_clip() -> None:
    """`match`'s audio is per tile at P6; a pair has no single spoken string, and
    inventing one would hand V7 a clip nothing ever plays."""
    cast = load_cast("es")
    assert TARGET_TEXT_FIELD_BY_TYPE["match"] is None
    planned = plan_utterances(cast, [_exercise("match", "rojo", "red")])
    assert all(u.role_sample for u in planned)


def test_the_plan_is_ordered_by_clip_id_not_by_exercise() -> None:
    """A manifest ordered by exercise index reshuffles wholesale when G7 reorders, and
    a re-bake's diff stops being "the clips that changed"."""
    cast = load_cast("es")
    planned = plan_utterances(
        cast, [_exercise("listen", "x", f"Frase {n}.", n) for n in range(10)]
    )
    assert [u.clip_id for u in planned] == sorted(u.clip_id for u in planned)


def test_the_target_string_is_the_target_language_side() -> None:
    """The listening family grades the learner against the TARGET sentence; baking the
    English prompt would produce a bank of English audio that every other check passes."""
    cast = load_cast("es")
    planned = plan_utterances(
        cast, [_exercise("listen", "Where is the station?", "¿Dónde está la estación?")]
    )
    texts = {u.text for u in planned if not u.role_sample}
    assert texts == {"¿Dónde está la estación?"}


def test_the_committed_falsifier_for_this_invariant_names_itself() -> None:
    """Same identity clause as `test_cast.py`'s, for INV-PACK-15's corpus."""
    raw = json.loads((FALSIFIERS / "INV-PACK-15.json").read_text(encoding="utf-8"))
    assert raw["invariant"] == "INV-PACK-15"
    assert raw["source"] == ["EC-PACK-15", "EC-PACK-16"]
    assert raw["why"].strip()
    assert {"lessonsOnly", "allThree", "overBudget", "noCodecRow"} <= set(PACK15)
    assert PACK15["budgetMb"] == AUDIO_BUDGET_MB
    assert PACK15["bitrateKbps"] == OPUS_BITRATE_KBPS
    # The falsifier's own arithmetic must be the arithmetic the tool uses, or the
    # fixture stops describing the bug it was written for.
    assert PACK15["allThree"]["declared_bytes"] == sum(
        row["reserved_bytes"] for row in PACK15["allThree"]["pipelines"].values()
    )


# ---------------------------------------------------------------------------
# INV-PACK-15 — the budget
# ---------------------------------------------------------------------------


def test_the_manifest_charges_every_pipeline() -> None:
    """[INV-PACK-15] all three pipelines, each sized, summed against the budget.

    The falsifier is `lessonsOnly`: 50 MB against 120 MB looks comfortable and is the
    exact shape review R14 refuted.
    """
    cast = load_cast("es")
    manifest = build_manifest(cast, [_entry("lesson", 5_000, "a" * 16)])
    budget = manifest["budget"]

    assert set(budget["pipelines"]) == set(AUDIO_PIPELINES)
    assert len(budget["pipelines"]) == 3, PACK15["lessonsOnly"]["note"]
    for pipeline in AUDIO_PIPELINES:
        assert budget["pipelines"][pipeline]["reserved_bytes"] > 0
        assert budget["pipelines"][pipeline]["assumption"]

    expected = sum(PIPELINE_RESERVED_BYTES.values())
    assert budget["declared_bytes"] == expected
    assert budget["budget_bytes"] == AUDIO_BUDGET_BYTES


def test_a_pipeline_that_outgrows_its_reservation_is_charged_what_it_costs() -> None:
    """Otherwise a lesson bank at 90 MB hides behind a 50 MB promise."""
    cast = load_cast("es")
    over = PACK15["overBudget"]["pipelines"]["lesson"]["baked_bytes"]
    manifest = build_manifest(cast, [_entry("lesson", over, "b" * 16)])
    pipelines = manifest["budget"]["pipelines"]
    assert pipelines["lesson"]["charged_bytes"] == over
    assert manifest["budget"]["declared_bytes"] > AUDIO_BUDGET_BYTES
    assert manifest["budget"]["headroom_bytes"] < 0


def test_the_three_reservations_fit_inside_the_budget() -> None:
    """The arithmetic R13 found nobody had done, as a test rather than a paragraph.

    50.0 + 27.0 + 21.0 = 98.0 MB against 120. If a future edit to the assumptions
    breaks that, it breaks here and not at P6 with a bank already baked.
    """
    assert BUDGET_HEADROOM_BYTES > 0
    assert sum(PIPELINE_RESERVED_BYTES.values()) < AUDIO_BUDGET_BYTES
    assert AUDIO_BUDGET_MB * BYTES_PER_MB == AUDIO_BUDGET_BYTES


def test_the_budget_has_a_bitrate_beside_it() -> None:
    """[INV-PACK-15] R13's finding: 8,000 utterances inside 35-40 MB is 4.4 KB each.

    The refutation only exists because the figure can be divided by something. The
    bytes-per-second constant is that something, and the old budget fails against it.
    """
    assert BYTES_PER_SECOND_AT_BITRATE == 2500.0
    lesson_seconds = 8_000 * 2.5
    assert lesson_seconds * BYTES_PER_SECOND_AT_BITRATE == 50_000_000
    assert lesson_seconds * BYTES_PER_SECOND_AT_BITRATE > 40 * BYTES_PER_MB, (
        "the inherited 35-40 MB budget must not fit the inherited utterance count"
    )


def test_the_manifest_carries_codec_bitrate_and_total_bytes() -> None:
    """[INV-PACK-15] the three fields the invariant names, by name."""
    cast = load_cast("es")
    manifest = build_manifest(cast, [_entry("lesson", 4_321, "c" * 16)])
    assert manifest["codec"] == "opus"
    assert manifest["bitrate_kbps"] == 20
    assert manifest["totals"]["bytes"] == 4_321


def test_the_manifest_records_the_cast_and_the_engine_pin() -> None:
    """A manifest that names the voices but not the engine cannot show EC-PACK-52."""
    cast = load_cast("es")
    manifest = build_manifest(cast, [])
    assert manifest["engine"] == "kokoro"
    assert manifest["engine_pin"] == cast.engine_pin
    assert [row["role"] for row in manifest["cast"]] == [role.id for role in cast.roles]
    assert all(row["voice"] for row in manifest["cast"])


# ---------------------------------------------------------------------------
# INV-AUD-08 — the whole chain, on real audio
# ---------------------------------------------------------------------------


def test_a_real_clip_survives_the_whole_chain() -> None:
    """[INV-AUD-08] synthesise -> master -> encode -> DECODE -> measure, within tolerance.

    The measurement is taken on the decoded Opus file. Measuring the encoder's input
    instead would prove nothing about the file in the pack, which is the assumption the
    invariant's word "measures" exists to forbid.
    """
    if not group_is_installed("tts"):
        pytest.skip("the tts group is not installed")
    import shutil

    if shutil.which("opusenc") is None or shutil.which("opusdec") is None:
        pytest.skip("opus-tools is not on PATH")

    from coursekit.tts.kokoro import build
    from coursekit.tts.loudness import master, measure_lufs, peak_dbfs
    from coursekit.tts.transcode import decode, encode

    cast = load_cast("es")
    engine = build("es")
    if not engine.model_path.exists() or not engine.voices_path.exists():
        pytest.skip("kokoro weights are not on this machine")

    text = "Buenos días, ¿cómo estás?"
    samples, rate = engine.synthesise(text, cast.role("narrator"))
    levelled, reduction = master(
        samples,
        rate,
        cast.target_lufs,
        ceiling_dbfs=PEAK_CEILING_DBFS,
        tolerance_lu=cast.tolerance_lu,
        max_passes=MASTER_MAX_PASSES,
    )
    assert peak_dbfs(levelled) <= PEAK_CEILING_DBFS + 1e-6
    assert reduction >= 0.0

    import tempfile

    with tempfile.TemporaryDirectory() as tmp:
        clip_id = rebake_key(cast, "narrator", text)
        clip = encode(levelled, rate, clip_id, Path(tmp))
        assert clip.path.name == f"{clip_id}.opus"
        decoded, decoded_rate = decode(clip.path)
        measured = measure_lufs(decoded, decoded_rate)

    drift = abs(measured.lufs - cast.target_lufs)
    assert drift <= cast.tolerance_lu, (
        f"the SHIPPED clip measured {measured.lufs:.2f} LUFS, {drift:.2f} LU from the "
        f"declared {cast.target_lufs}"
    )
    # And the encode actually held the declared bitrate, within the slack a VBR
    # encoder needs on a two-second clip.
    implied_kbps = clip.bytes * 8 / (len(decoded) / decoded_rate) / 1000
    assert 12 <= implied_kbps <= 34, implied_kbps


def test_loudness_is_measured_on_the_decoded_file() -> None:
    """[INV-AUD-08] the falsifier's `driftedClip`, as an assertion about the chain.

    A clip whose PCM was normalised to -16 and whose decoded Opus measures -19.6 is
    EC-PACK-52. The stage compares the DECODED reading with the tolerance, so this test
    pins the fact that the two readings are taken on different signals and only the
    second one gates.
    """
    from coursekit.stages import g8_bake

    source = Path(g8_bake.__file__).read_text(encoding="utf-8")
    measure_line = source.index("decoded, decoded_rate = decode(clip.path)")
    assert source.index("measured = measure_lufs(decoded", measure_line) > measure_line
    assert "measure_lufs(samples" not in source, (
        "the gate must not read the synthesiser's output; that is the assumption "
        "INV-AUD-08 forbids"
    )
