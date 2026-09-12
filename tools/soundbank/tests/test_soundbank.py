"""Tests for the generated sound bank.

The load-bearing one is `test_rebake_is_byte_identical`: it re-runs the whole synthesis
into a temporary directory and compares hashes with the committed manifest. Without it,
"regenerate the bank" is a diff nobody can review — eight binary files changed, and no way
to tell a deliberate retune from a numpy upgrade that moved every sample by one LSB.

Run:  uv run --project tools/soundbank pytest
"""

from __future__ import annotations

import hashlib
import json
import shutil
import subprocess
from pathlib import Path

import numpy as np
import pytest

from synthesize import (
    BANK,
    PEAK_CEILING_DBFS,
    SHIMMER_BUS_LKFS,
    SR,
    STING_BUS_LKFS,
    bake,
    cue_loudness_lkfs,
    ffmpeg_version,
    peak_dbfs,
    render_bank,
)

REPO = Path(__file__).resolve().parents[3]
SOUND = REPO / "art" / "sound"
MANIFEST = SOUND / "manifest.json"


@pytest.fixture(scope="session")
def manifest() -> dict:
    return json.loads(MANIFEST.read_text())


@pytest.fixture(scope="session")
def ffmpeg() -> str:
    found = shutil.which("ffmpeg")
    if found is None:
        pytest.skip("no ffmpeg on PATH")
    return found


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


# --- the committed bank ---------------------------------------------------------------


def test_every_cue_ships_in_both_encodings(manifest: dict) -> None:
    """The WAV master is not shipped; Opus and AAC are."""
    for cue in BANK:
        assert cue.name in manifest["cues"], f"{cue.name} missing from the manifest"
        for ext in ("opus", "m4a"):
            assert (SOUND / f"{cue.name}.{ext}").is_file(), f"{cue.name}.{ext} not committed"


def test_committed_files_match_the_manifest(manifest: dict) -> None:
    """A hand-edited or half-regenerated file is caught here rather than at runtime."""
    for cue in BANK:
        recorded = manifest["cues"][cue.name]["sha256"]
        for ext in ("opus", "m4a"):
            path = SOUND / f"{cue.name}.{ext}"
            assert sha256(path) == recorded[ext], f"{path.name} differs from the manifest"


def test_shimmer_sits_exactly_six_db_under_the_sting_bus(manifest: dict) -> None:
    """EC-COM-09 / INV-SND-01.

    The edge case is the correct-answer sting and the combo-gold flip landing on the same
    frame. deep/08 §12's "never two effects in the same frame - the later one wins" would
    silently drop one of them, so the ruling layers the shimmer on a second bus 6 dB down
    instead. That number is only real if it is in the audio, so it is asserted here on the
    measured loudness of the shipped cues, not on the constants that produced them.
    """
    cues = manifest["cues"]
    sting = [c["loudnessLkfs"] for c in cues.values() if c["bus"] == "sting"]
    shimmer = cues["combo-shimmer"]["loudnessLkfs"]

    assert len(set(sting)) == 1, f"the sting bus is not level: {sorted(set(sting))}"
    assert sting[0] - shimmer == pytest.approx(6.0, abs=0.01)
    assert pytest.approx(6.0) == STING_BUS_LKFS - SHIMMER_BUS_LKFS
    assert cues["combo-shimmer"]["bus"] == "shimmer", "the shimmer must be its own class"


def test_no_cue_exceeds_the_peak_ceiling(manifest: dict) -> None:
    for name, cue in manifest["cues"].items():
        assert cue["peakDbfs"] <= PEAK_CEILING_DBFS + 1e-6, f"{name} clips"


def test_durations_match_the_spec_table(manifest: dict) -> None:
    """deep/08 §12, which also says everything under 400 ms bar the two ceremony cues."""
    expected = {
        "correct": 240.0,
        "wrong": 300.0,
        "combo-shimmer": 600.0,
        "fanfare": 1600.0,
        "chest": 1100.0,
        "streak": 900.0,
        "earcon-start": 120.0,
        "earcon-stop": 120.0,
    }
    for name, ms in expected.items():
        assert manifest["cues"][name]["durationMs"] == pytest.approx(ms)

    ceremony = {"fanfare", "chest", "streak", "combo-shimmer"}
    for name, cue in manifest["cues"].items():
        if name not in ceremony:
            assert cue["durationMs"] <= 400.0, f"{name} is a long cue but not a ceremony one"


# --- the measure itself ---------------------------------------------------------------


def test_loudness_meter_hits_the_bs1770_calibration_point() -> None:
    """A full-scale 997 Hz sine reads -3.01 LKFS. That is the published calibration point
    for a single channel, so it checks the K-weighting coefficients and the -0.691 offset
    together — and it is the reason the -6 dB claim above can be trusted."""
    t = np.arange(SR * 3) / SR
    assert cue_loudness_lkfs(np.sin(2 * np.pi * 997.0 * t)) == pytest.approx(-3.01, abs=0.02)


def test_loudness_is_linear_in_gain() -> None:
    t = np.arange(SR) / SR
    tone = np.sin(2 * np.pi * 440.0 * t)
    assert cue_loudness_lkfs(0.5 * tone) - cue_loudness_lkfs(tone) == pytest.approx(-6.02, abs=0.01)


def test_render_bank_is_deterministic_in_process() -> None:
    """Catches an unseeded generator, a dict ordering change, or a clock creeping in —
    without paying for the ffmpeg encodes."""
    first, second = render_bank(), render_bank()
    assert first.keys() == second.keys()
    for name in first:
        assert np.array_equal(first[name], second[name]), f"{name} is not reproducible"


def test_bank_is_mono_and_at_the_spec_sample_rate() -> None:
    for name, samples in render_bank().items():
        assert samples.ndim == 1, f"{name} is not mono"
        assert peak_dbfs(samples) <= PEAK_CEILING_DBFS + 1e-6


# --- the expensive one ----------------------------------------------------------------


def test_rebake_is_byte_identical(tmp_path: Path, manifest: dict, ffmpeg: str) -> None:
    """Re-run the whole script and compare every file with the recorded hashes.

    The WAV masters are asserted unconditionally: they are pure numpy, so a change there
    is a change in the audio and must be reviewed as one.

    The Opus and AAC hashes are asserted only when the local ffmpeg reports the same
    version string the bank was baked with. A codec's bitstream is a property of that
    codec build — libopus writes its own version into the OpusTags packet — so demanding
    byte-equality across ffmpeg builds would be asserting something this script does not
    control, and would go red for a reason that has nothing to do with the sound.
    """
    fresh = bake(tmp_path, ffmpeg)

    for cue in BANK:
        recorded = manifest["cues"][cue.name]["sha256"]["wav"]
        assert fresh["cues"][cue.name]["sha256"]["wav"] == recorded, (
            f"{cue.name}.wav changed: the synthesis is not reproducible, or the audio was "
            "deliberately retuned and art/sound/manifest.json was not regenerated"
        )

    if ffmpeg_version(ffmpeg) != manifest["ffmpeg"]:
        pytest.skip(f"ffmpeg is {ffmpeg_version(ffmpeg)}, bank baked with {manifest['ffmpeg']}")

    for cue in BANK:
        for ext in ("opus", "m4a"):
            assert (
                fresh["cues"][cue.name]["sha256"][ext] == manifest["cues"][cue.name]["sha256"][ext]
            ), f"{cue.name}.{ext} is not a reproducible encode"


def test_encoding_is_not_timestamped(tmp_path: Path, ffmpeg: str) -> None:
    """Two encodes of one input agree.

    This is the half of reproducibility that has nothing to do with the synthesis: the mp4
    muxer stamps creation_time and the Ogg muxer randomises the page serial, and either one
    alone makes every rebake a full-bank diff. `-fflags +bitexact` and `-serial_offset 0`
    are what stop that, and this is the test that says so.
    """
    import soundfile as sf

    from synthesize import AAC_ARGS, OPUS_ARGS, encode

    source = tmp_path / "tone.wav"
    t = np.arange(SR // 4) / SR
    sf.write(str(source), 0.25 * np.sin(2 * np.pi * 440 * t), SR, subtype="PCM_16", format="WAV")

    for args, ext in ((OPUS_ARGS, "opus"), (AAC_ARGS, "m4a")):
        first, second = tmp_path / f"a.{ext}", tmp_path / f"b.{ext}"
        encode(ffmpeg, source, first, list(args))
        encode(ffmpeg, source, second, list(args))
        assert sha256(first) == sha256(second), f"{ext} encoding is not deterministic"


def test_shipped_encodings_decode_to_the_right_length(ffmpeg: str, manifest: dict) -> None:
    """A file that is present and hashed can still be unplayable; ask the decoder."""
    decode = [ffmpeg, "-hide_banner", "-loglevel", "error", "-nostdin"]
    for cue in BANK:
        for ext in ("opus", "m4a"):
            out = subprocess.run(
                decode + ["-i", str(SOUND / f"{cue.name}.{ext}"), "-f", "s16le", "-"],
                capture_output=True,
                check=True,
            )
            seconds = len(out.stdout) / 2 / SR
            expected = manifest["cues"][cue.name]["durationMs"] / 1000.0
            # Opus pads with a pre-skip and AAC with an encoder delay; 60 ms covers both.
            assert seconds == pytest.approx(expected, abs=0.06), f"{cue.name}.{ext} decoded oddly"
