"""ITU-R BS.1770-4 loudness, and the normaliser the bake runs before it packs.

INV-AUD-08 says every packed clip **measures** within a declared tolerance of the
target. The verb is the invariant. A bake that normalises and then asserts "therefore
it is at target" proves nothing about the file it shipped: the clip is normalised as
32-bit PCM and shipped as 20 kbps Opus, and a lossy encode at that rate is exactly
where a clip's level can move. So the pipeline is

    synthesise -> measure -> normalise -> encode -> DECODE -> measure again -> assert

and it is the last measurement that INV-AUD-08 is about.

This is the gated algorithm, unlike `tools/soundbank/synthesize.py`'s ungated reading.
The sound bank measures 120-1600 ms percussive one-shots, which have no complete 400 ms
gating block; a spoken line is 1.5-4 s and has twenty of them, and the gate is what
stops a trailing half-second of silence from dragging a line's reading down. Clips
shorter than one block fall back to the ungated whole-signal reading and the manifest
records `gated: false` for them, because a number whose meaning changed silently is
worse than a number that is missing.

numpy only — no `pyloudnorm`, no scipy. The filters are two biquads with published
coefficients and the gating is twenty lines, and a dependency that CI does not carry
would make this the one measurement that cannot run in the job that gates the pack.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from ..config.g8 import (
    LIMITER_LOOKAHEAD_MS,
    LIMITER_SMOOTH_MS,
    LOUDNESS_ABSOLUTE_GATE_LUFS,
    LOUDNESS_BLOCK_MS,
    LOUDNESS_BLOCK_OVERLAP,
    LOUDNESS_RELATIVE_GATE_LU,
)

# numpy is imported inside each function, not at module scope. It arrives with the
# `nlp` group (spaCy) on CI and with `tts` on a bake box, and this module is imported
# by `validators/audio.py`, which must stay importable in a job that has neither.

__all__ = [
    "Loudness",
    "gain_for",
    "limit_peaks",
    "master",
    "measure_lufs",
    "normalise_to",
    "peak_dbfs",
    "trim_gain",
]


@dataclass(frozen=True, slots=True)
class Loudness:
    """One measurement, and whether the gated algorithm was the one that produced it."""

    lufs: float
    gated: bool
    peak_dbfs: float
    blocks: int


# ---------------------------------------------------------------------------
# K-weighting
# ---------------------------------------------------------------------------
#
# BS.1770-4's two stages: a high-shelf ("head") filter and an RLB high-pass. The
# published coefficients are defined at 48 kHz, so a signal at any other rate is
# resampled onto the filter's rate rather than being run through coefficients that do
# not belong to it. `_coefficients_for` derives the pair for an arbitrary rate from the
# same analogue prototype the standard's table came from, which is what makes a 24 kHz
# Kokoro render measurable without a resampler.


def _shelf_coefficients(rate: int) -> tuple[list[float], list[float]]:
    """Stage 1: the high-frequency shelving filter, at `rate`."""
    import numpy as np

    # Analogue prototype behind the standard's 48 kHz table.
    f0, gain_db, q = 1681.974450955533, 3.999843853973347, 0.7071752369554196
    k = np.tan(np.pi * f0 / rate)
    vh = 10.0 ** (gain_db / 20.0)
    vb = vh**0.4996667741545416
    denom = 1.0 + k / q + k * k
    b = [
        (vh + vb * k / q + k * k) / denom,
        2.0 * (k * k - vh) / denom,
        (vh - vb * k / q + k * k) / denom,
    ]
    a = [1.0, 2.0 * (k * k - 1.0) / denom, (1.0 - k / q + k * k) / denom]
    return b, a


def _highpass_coefficients(rate: int) -> tuple[list[float], list[float]]:
    """Stage 2: the RLB high-pass, at `rate`."""
    import numpy as np

    f0, q = 38.13547087602444, 0.5003270373238773
    k = np.tan(np.pi * f0 / rate)
    denom = 1.0 + k / q + k * k
    b = [1.0, -2.0, 1.0]
    a = [1.0, 2.0 * (k * k - 1.0) / denom, (1.0 - k / q + k * k) / denom]
    return b, a


def _biquad(x: Any, b: list[float], a: list[float]) -> Any:
    """Direct-form-I biquad. Written out rather than pulled from scipy, which is not
    a dependency of this tool and would be one for six lines of arithmetic."""
    import numpy as np

    # `.tolist()` rather than indexing the array: a recursive filter cannot be
    # vectorised, and a Python loop over an ndarray pays a scalar-boxing cost on every
    # sample. Over a bank of 8,000 clips that difference is minutes.
    source = np.asarray(x, dtype=np.float64).tolist()
    out: list[float] = []
    x1 = x2 = y1 = y2 = 0.0
    b0, b1, b2 = b
    a1, a2 = a[1], a[2]
    for sample in source:
        value = b0 * sample + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2
        x2, x1 = x1, sample
        y2, y1 = y1, value
        out.append(value)
    return np.asarray(out, dtype=np.float64)


def _k_weight(x: Any, rate: int) -> Any:
    shelf_b, shelf_a = _shelf_coefficients(rate)
    hp_b, hp_a = _highpass_coefficients(rate)
    return _biquad(_biquad(x, shelf_b, shelf_a), hp_b, hp_a)


# ---------------------------------------------------------------------------
# The meter
# ---------------------------------------------------------------------------


def measure_lufs(samples: Any, rate: int) -> Loudness:
    """Measure `samples` (mono float, nominally -1..1) in LUFS.

    Gated per BS.1770-4: 400 ms blocks at 75% overlap, an absolute gate at -70 LUFS,
    then a relative gate 10 LU below the ungated mean of what survived. A signal too
    short for one block is measured ungated over its whole length and reports
    `gated=False` — see the module docstring for why that is recorded rather than
    quietly substituted.
    """
    import numpy as np

    x = np.asarray(samples, dtype=np.float64).reshape(-1)
    if x.size == 0:
        return Loudness(lufs=float("-inf"), gated=False, peak_dbfs=float("-inf"), blocks=0)

    weighted = _k_weight(x, rate)
    peak = peak_dbfs(x)

    block = int(rate * LOUDNESS_BLOCK_MS / 1000)
    step = max(1, int(block * (1.0 - LOUDNESS_BLOCK_OVERLAP)))
    if weighted.size < block:
        return Loudness(
            lufs=_loudness_of(float(np.mean(weighted**2))),
            gated=False,
            peak_dbfs=peak,
            blocks=0,
        )

    starts = range(0, weighted.size - block + 1, step)
    powers = np.array([float(np.mean(weighted[s : s + block] ** 2)) for s in starts])
    levels = np.array([_loudness_of(power) for power in powers])

    keep = levels > LOUDNESS_ABSOLUTE_GATE_LUFS
    if not keep.any():
        return Loudness(lufs=float("-inf"), gated=True, peak_dbfs=peak, blocks=0)

    relative = _loudness_of(float(np.mean(powers[keep]))) + LOUDNESS_RELATIVE_GATE_LU
    keep &= levels > relative
    if not keep.any():  # pragma: no cover - a signal with no block above its own gate
        return Loudness(lufs=float("-inf"), gated=True, peak_dbfs=peak, blocks=0)

    return Loudness(
        lufs=_loudness_of(float(np.mean(powers[keep]))),
        gated=True,
        peak_dbfs=peak,
        blocks=int(keep.sum()),
    )


def _loudness_of(mean_square: float) -> float:
    import numpy as np

    if mean_square <= 0.0:
        return float("-inf")
    return -0.691 + 10.0 * float(np.log10(mean_square))


def peak_dbfs(samples: Any) -> float:
    import numpy as np

    x = np.asarray(samples, dtype=np.float64).reshape(-1)
    peak = float(np.max(np.abs(x))) if x.size else 0.0
    return 20.0 * float(np.log10(peak)) if peak > 0.0 else float("-inf")


# ---------------------------------------------------------------------------
# Normalisation
# ---------------------------------------------------------------------------


def gain_for(measured: float, target: float) -> float:
    """The linear gain that moves `measured` LUFS to `target`."""
    if measured == float("-inf"):
        return 1.0
    return float(10.0 ** ((target - measured) / 20.0))


def normalise_to(samples: Any, rate: int, target: float, *, ceiling_dbfs: float) -> Any:
    """Scale to `target` LUFS, then pull back if that would breach `ceiling_dbfs`.

    Scaling only. This is the honest, lossless operation and it is what the tests
    calibrate against; it is NOT the bake's chain, because on speech with a 16-21 dB
    crest factor the pull-back costs 5-6 LU and lands the whole bank at EC-PACK-52's
    -19.6 LUFS. `master()` below is the chain.
    """
    import numpy as np

    x = np.asarray(samples, dtype=np.float64).reshape(-1)
    measured = measure_lufs(x, rate)
    gain = gain_for(measured.lufs, target)
    scaled = x * gain
    peak = peak_dbfs(scaled)
    if peak > ceiling_dbfs:
        scaled = scaled * (10.0 ** ((ceiling_dbfs - peak) / 20.0))
    return scaled


# ---------------------------------------------------------------------------
# Limiting and the bake's chain
# ---------------------------------------------------------------------------


def limit_peaks(samples: Any, rate: int, ceiling_dbfs: float) -> tuple[Any, float]:
    """Hold the sample peak under `ceiling_dbfs` with a look-ahead gain envelope.

    Deterministic and dependency-free: a sliding-window minimum of the gain each
    sample needs, then a Hann average over a *narrower* window. Taking the minimum
    first over a window twice the smoothing width is what makes the smoothed envelope
    provably never exceed the gain any sample in it required, so the smoothing cannot
    reintroduce an overshoot — a plain smoothed envelope can, and the overshoot then
    appears as a clipped consonant rather than as an error.

    Deliberately NOT a hard clip: clipping a plosive at -1 dBFS puts broadband
    distortion into the exact band a 20 kbps Opus encoder has the fewest bits for.

    Returns the limited signal and the deepest gain reduction it applied, in dB.
    """
    import numpy as np

    x = np.asarray(samples, dtype=np.float64).reshape(-1)
    if x.size == 0:
        return x, 0.0
    ceiling = 10.0 ** (ceiling_dbfs / 20.0)
    if float(np.max(np.abs(x))) <= ceiling:
        return x, 0.0

    smooth = max(3, int(rate * LIMITER_SMOOTH_MS / 1000.0) | 1)
    look = max(smooth * 2 + 1, int(rate * LIMITER_LOOKAHEAD_MS / 1000.0) | 1)

    needed = np.minimum(1.0, ceiling / np.maximum(np.abs(x), 1e-12))
    padded = np.pad(needed, look // 2, mode="edge")
    windows = np.lib.stride_tricks.sliding_window_view(padded, look)
    envelope = windows.min(axis=1)

    window = np.hanning(smooth + 2)[1:-1]
    window = window / window.sum()
    smoothed = np.convolve(np.pad(envelope, smooth // 2, mode="edge"), window, mode="same")
    smoothed = smoothed[smooth // 2 : smooth // 2 + x.size]

    limited = x * smoothed
    # The construction above bounds the result, but a float rounding residue is not
    # worth arguing with: trim whatever is left rather than ship a sample over.
    peak = float(np.max(np.abs(limited)))
    if peak > ceiling:
        limited = limited * (ceiling / peak)
    reduction = -20.0 * float(np.log10(max(float(np.min(smoothed)), 1e-12)))
    return limited, max(reduction, 0.0)


def trim_gain(samples: Any, rate: int, db: float, *, ceiling_dbfs: float) -> Any:
    """Apply a small gain correction and re-limit, for the post-encode loop.

    The correction is fractions of a dB, so the limiter barely engages; it is here
    because "barely" is not "never" and a clip pushed over the ceiling by a 0.5 dB
    make-up would come back from the next encode worse, not better.
    """
    import numpy as np

    x = np.asarray(samples, dtype=np.float64).reshape(-1) * (10.0 ** (db / 20.0))
    limited, _ = limit_peaks(x, rate, ceiling_dbfs)
    return limited


def master(
    samples: Any,
    rate: int,
    target: float,
    *,
    ceiling_dbfs: float,
    tolerance_lu: float,
    max_passes: int,
) -> tuple[Any, float]:
    """The bake's chain: reach `target` LUFS with peaks under `ceiling_dbfs`.

    Limiting lowers loudness, so the target is approached rather than computed: scale,
    limit, re-measure, make up the shortfall, limit again. Returns the mastered signal
    and the total gain reduction the limiter applied, in dB, which the manifest records
    per clip — a clip that needed 9 dB of limiting is a clip a reviewer should hear
    about even though its number is on target.

    On convergence failure it returns the last pass rather than a silently mislevelled
    clip; the stage's post-encode measurement is what refuses it.
    """
    import numpy as np

    x = np.asarray(samples, dtype=np.float64).reshape(-1)
    current = x * gain_for(measure_lufs(x, rate).lufs, target)
    deepest = 0.0

    for _ in range(max_passes):
        current, reduction = limit_peaks(current, rate, ceiling_dbfs)
        deepest = max(deepest, reduction)
        error = target - measure_lufs(current, rate).lufs
        if abs(error) <= tolerance_lu / 2.0:
            break
        current = current * (10.0 ** (error / 20.0))
    else:  # pragma: no cover - every clip measured so far converges in three passes
        current, reduction = limit_peaks(current, rate, ceiling_dbfs)
        deepest = max(deepest, reduction)

    return current, round(float(deepest), 3)
