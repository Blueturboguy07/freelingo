"""The loudness meter, calibrated rather than trusted.

INV-AUD-08 turns on the word "measures". A meter nobody calibrated is a meter that
reports a number every clip agrees with and no external standard does, and the bake
would then normalise 8,000 clips to the wrong level and pass its own gate.

So the first test here is the BS.1770 calibration point: a 1 kHz sine at -20 dBFS RMS
must read -20 LUFS. It is the same check `tools/soundbank` makes of its own ungated
meter, deliberately duplicated rather than imported — the sound bank and the voice bank
are two tools with two meters aimed at one target (-16 LUFS, `deep/08` §12), and the
thing that has to agree is the READING, not the code.
"""

from __future__ import annotations

import math

import pytest

from coursekit.config.g8 import (
    LOUDNESS_ABSOLUTE_GATE_LUFS,
    LOUDNESS_BLOCK_MS,
    PEAK_CEILING_DBFS,
    TARGET_LUFS,
)
from coursekit.tts.loudness import (
    _highpass_coefficients,
    _shelf_coefficients,
    gain_for,
    measure_lufs,
    normalise_to,
    peak_dbfs,
)

np = pytest.importorskip("numpy")

RATE = 48_000


def _sine(seconds: float, dbfs_rms: float, freq: float = 1000.0, rate: int = RATE):
    t = np.arange(int(rate * seconds)) / rate
    amplitude = 10.0 ** (dbfs_rms / 20.0) * math.sqrt(2.0)
    return amplitude * np.sin(2.0 * math.pi * freq * t)


# ---------------------------------------------------------------------------
# Calibration
# ---------------------------------------------------------------------------


def test_the_published_48k_coefficients_are_reproduced() -> None:
    """The standard's table, to fourteen places.

    The coefficients are derived from the analogue prototype rather than pasted, so
    that a 24 kHz Kokoro render can be measured without a resampler. That derivation
    is only trustworthy if it lands exactly on the published pair at 48 kHz.
    """
    shelf_b, shelf_a = _shelf_coefficients(48_000)
    assert [round(v, 11) for v in shelf_b] == [1.53512485959, -2.69169618941, 1.19839281085]
    assert [round(v, 11) for v in shelf_a] == [1.0, -1.69065929318, 0.73248077422]

    hp_b, hp_a = _highpass_coefficients(48_000)
    assert hp_b == [1.0, -2.0, 1.0]
    assert [round(v, 11) for v in hp_a] == [1.0, -1.99004745483, 0.99007225037]


def test_the_meter_hits_the_bs1770_calibration_point() -> None:
    """[INV-AUD-08] a 1 kHz sine at -20 dBFS RMS reads -20 LUFS, within 0.1 LU."""
    measured = measure_lufs(_sine(3.0, -20.0), RATE)
    assert measured.gated is True
    assert abs(measured.lufs - (-20.0)) < 0.1, measured


def test_the_meter_is_linear_in_gain() -> None:
    """6 dB of gain is 6 LU of loudness. Without this the normaliser cannot converge."""
    base = _sine(2.0, -24.0)
    quiet = measure_lufs(base, RATE).lufs
    loud = measure_lufs(base * 2.0, RATE).lufs
    assert abs((loud - quiet) - 6.0206) < 0.01


# ---------------------------------------------------------------------------
# Gating — the reason this meter is not the sound bank's
# ---------------------------------------------------------------------------


def test_a_silent_tail_does_not_drag_the_reading_down() -> None:
    """The gate, stated as the thing it buys.

    A spoken line ends in silence. Ungated, two seconds of speech followed by two
    seconds of nothing measures 3 dB quieter than the same speech alone, and a bake
    that normalised on that reading would ship every clip 3 dB hot.
    """
    speech = _sine(2.0, -20.0)
    padded = np.concatenate([speech, np.zeros(RATE * 2)])

    gated = measure_lufs(padded, RATE)
    speech_only = measure_lufs(speech, RATE)
    ungated_error = 10.0 * math.log10(float(np.mean(padded**2)) / float(np.mean(speech**2)))

    # Ungated, the silence costs 3 dB; gated it costs a third of a LU, and that third
    # is the blocks straddling the boundary, which BS.1770 keeps because they are
    # within 10 LU of the mean.
    assert ungated_error < -2.5, "the fixture must contain enough silence to matter"
    assert abs(gated.lufs - speech_only.lufs) < 0.5
    assert abs(gated.lufs - speech_only.lufs) < abs(ungated_error) / 5.0


def test_a_clip_shorter_than_one_block_reports_that_it_was_not_gated() -> None:
    """400 ms is one block. Below it the gated algorithm has nothing to average, and a
    number whose meaning changed silently is worse than a number that is missing."""
    short = _sine(LOUDNESS_BLOCK_MS / 1000.0 / 2.0, -20.0)
    measured = measure_lufs(short, RATE)
    assert measured.gated is False
    assert measured.blocks == 0
    assert abs(measured.lufs - (-20.0)) < 0.2


def test_silence_measures_minus_infinity_rather_than_zero() -> None:
    measured = measure_lufs(np.zeros(RATE), RATE)
    assert measured.lufs == float("-inf")
    assert measured.lufs < LOUDNESS_ABSOLUTE_GATE_LUFS


def test_an_empty_signal_is_not_a_crash() -> None:
    measured = measure_lufs(np.zeros(0), RATE)
    assert measured.lufs == float("-inf")


# ---------------------------------------------------------------------------
# Normalisation
# ---------------------------------------------------------------------------


def test_normalising_lands_on_the_declared_target() -> None:
    """[INV-AUD-08] the level the bake asks for is the level it gets, pre-encode."""
    for start in (-30.0, -24.0, -12.0):
        levelled = normalise_to(
            _sine(2.0, start), RATE, TARGET_LUFS, ceiling_dbfs=PEAK_CEILING_DBFS
        )
        assert abs(measure_lufs(levelled, RATE).lufs - TARGET_LUFS) < 0.1


def test_the_peak_ceiling_wins_over_the_target() -> None:
    """A clip whose crest factor puts it into clipping is pulled back, not clipped.

    A clipped clip fails the post-encode re-measurement for a reason that reads like an
    encoder bug, which is a long way to travel to find a gain stage.
    """
    spiky = _sine(1.0, -40.0)
    spiky[1000] = 0.99  # one sample far above the rest: crest factor ~40 dB
    levelled = normalise_to(spiky, RATE, TARGET_LUFS, ceiling_dbfs=PEAK_CEILING_DBFS)
    assert peak_dbfs(levelled) <= PEAK_CEILING_DBFS + 1e-9
    assert measure_lufs(levelled, RATE).lufs < TARGET_LUFS


def test_gain_for_silence_is_a_no_op_not_an_infinity() -> None:
    assert gain_for(float("-inf"), TARGET_LUFS) == 1.0
