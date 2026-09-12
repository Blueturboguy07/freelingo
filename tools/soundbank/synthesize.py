"""Synthesise the Freelingo sound bank from numpy, then encode it with the system ffmpeg.

Nothing here is sampled and nothing is downloaded: every cue is an array of floats built
by the functions below, which is what makes the bank original work (plan §Art and sound)
and what makes it reproducible (one seed, no I/O into the synthesis).

The cue table is `deep/08-design-system-motion-sound.md` §12. That section is explicit
that it is *a Freelingo specification, not a transcription of Duolingo's bank*: mono,
48 kHz, everything under 400 ms except the two ceremony cues.

Run:

    uv run --project tools/soundbank python tools/soundbank/synthesize.py --out art/sound

Determinism contract
--------------------
* One seed (`SEED`) drives every noise and every "random" partial. No `random`, no
  unseeded `np.random`, no clock, no filesystem read.
* The WAV masters are the anchor: `manifest.json` records their SHA-256 and
  `tests/test_reproducible.py` re-runs this script into a temporary directory and
  compares. A WAV whose hash moved is a real diff in the audio, not encoder noise.
* The encodes are made bit-exact where ffmpeg allows it (`-fflags +bitexact`,
  `-map_metadata -1`, and `-serial_offset 0` so the Ogg page serial is not randomised).
  Their hashes are recorded too, but they are only *asserted* against an ffmpeg whose
  version string matches the one in the manifest, because a codec's own bitstream is a
  property of that codec build, not of this script.

Loudness
--------
§12 says the bank is normalised to -16 LUFS, and EC-COM-09 says the combo shimmer sits
-6 dB under the sting bus so that both can sound in the same frame without either being
suppressed. Both are implemented against `cue_loudness_lkfs` below, which is the
BS.1770-4 K-weighting *without* the 400 ms block gating — see that function's docstring
for why a 240 ms sting cannot be measured by the gated algorithm at all.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import subprocess
import sys
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import soundfile as sf

# --- constants -----------------------------------------------------------------------

SR = 48_000
"""Sample rate. deep/08 §12: one bank, mono, 48 kHz."""

SEED = 20260911
"""The one seed. Changing it rewrites every noise-bearing cue; that is a reviewable diff."""

STING_BUS_LKFS = -16.0
"""deep/08 §12: the bank is normalised to -16 LUFS."""

SHIMMER_BUS_LKFS = STING_BUS_LKFS - 6.0
"""EC-COM-09 / INV-SND-01: the combo-gold shimmer is a second bus, 6 dB down."""

PEAK_CEILING_DBFS = -1.0
"""Headroom kept under 0 dBFS so a decoder's own resampling cannot clip the cue."""

# --- tiny DSP (no scipy: tools/soundbank depends on numpy and soundfile only) ---------


def _biquad(x: np.ndarray, b: Sequence[float], a: Sequence[float]) -> np.ndarray:
    """Direct-form-I biquad. `a[0]` is assumed 1."""
    y = np.zeros_like(x)
    x1 = x2 = y1 = y2 = 0.0
    b0, b1, b2 = b
    _, a1, a2 = a
    for i in range(x.shape[0]):
        xi = float(x[i])
        yi = b0 * xi + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2
        y[i] = yi
        x2, x1 = x1, xi
        y2, y1 = y1, yi
    return y


def _rbj_lowpass(freq: float, q: float = 0.707) -> tuple[list[float], list[float]]:
    """RBJ cookbook low-pass coefficients at `SR`."""
    w0 = 2.0 * np.pi * freq / SR
    alpha = np.sin(w0) / (2.0 * q)
    cos_w0 = np.cos(w0)
    a0 = 1.0 + alpha
    b = [(1.0 - cos_w0) / 2.0 / a0, (1.0 - cos_w0) / a0, (1.0 - cos_w0) / 2.0 / a0]
    a = [1.0, (-2.0 * cos_w0) / a0, (1.0 - alpha) / a0]
    return b, a


def _rbj_bandpass(freq: float, q: float) -> tuple[list[float], list[float]]:
    """RBJ cookbook constant-skirt band-pass at `SR`."""
    w0 = 2.0 * np.pi * freq / SR
    alpha = np.sin(w0) / (2.0 * q)
    cos_w0 = np.cos(w0)
    a0 = 1.0 + alpha
    b = [alpha / a0, 0.0, -alpha / a0]
    a = [1.0, (-2.0 * cos_w0) / a0, (1.0 - alpha) / a0]
    return b, a


def lowpass(x: np.ndarray, freq: float, q: float = 0.707) -> np.ndarray:
    b, a = _rbj_lowpass(freq, q)
    return _biquad(x, b, a)


def bandpass(x: np.ndarray, freq: float, q: float) -> np.ndarray:
    b, a = _rbj_bandpass(freq, q)
    return _biquad(x, b, a)


# --- loudness ------------------------------------------------------------------------

# ITU-R BS.1770-4 K-weighting, the published 48 kHz coefficient pair.
_K_SHELF_B = [1.53512485958697, -2.69169618940638, 1.19839281085285]
_K_SHELF_A = [1.0, -1.69065929318241, 0.73248077421585]
_K_RLB_B = [1.0, -2.0, 1.0]
_K_RLB_A = [1.0, -1.99004745483398, 0.99007225036621]


def cue_loudness_lkfs(x: np.ndarray) -> float:
    """K-weighted loudness of a whole cue, in LKFS.

    This is BS.1770-4's filter stage and its `-0.691 + 10*log10(mean square)` law applied
    to the entire signal, with **no block gating**. That deviation is deliberate and it is
    not a shortcut: BS.1770 measures 400 ms blocks, and the correct-answer sting is 240 ms
    and the mic earcon 120 ms, so the gated algorithm has zero complete blocks to average
    and returns nothing at all for most of this bank. Averaging over the cue is the
    meaningful reading of "how loud is this cue", and it is the measure both
    `STING_BUS_LKFS` and the -6 dB shimmer relation are defined against, so the relation
    between two cues is exact rather than an artefact of where a block boundary fell.
    """
    filtered = _biquad(_biquad(x, _K_SHELF_B, _K_SHELF_A), _K_RLB_B, _K_RLB_A)
    mean_square = float(np.mean(filtered**2))
    if mean_square <= 0.0:
        return float("-inf")
    return -0.691 + 10.0 * float(np.log10(mean_square))


def normalise_to(x: np.ndarray, target_lkfs: float) -> np.ndarray:
    """Scale `x` so `cue_loudness_lkfs` reads exactly `target_lkfs`."""
    gain = 10.0 ** ((target_lkfs - cue_loudness_lkfs(x)) / 20.0)
    return x * gain


def peak_dbfs(x: np.ndarray) -> float:
    peak = float(np.max(np.abs(x))) if x.size else 0.0
    return float(20.0 * np.log10(peak)) if peak > 0.0 else float("-inf")


def bank_headroom_gain_db(bank: dict[str, np.ndarray]) -> float:
    """One gain for the whole bank, so no cue exceeds `PEAK_CEILING_DBFS`.

    This is the reconciliation between two specs that cannot both hold literally. §12 asks
    for -16 LUFS; these are 120-1600 ms percussive one-shots whose crest factor is 10-18 dB,
    so a cue whose *average* sits at -16 LKFS has peaks above full scale — measured on the
    first bake, the correct-answer sting peaked at +1.85 dBFS. Limiting each cue
    individually would fix the peaks and silently destroy the thing that actually matters:
    EC-COM-09 / INV-SND-01 require the combo shimmer to sit exactly 6 dB under the sting
    bus so both can sound in the same frame, and a per-cue limiter changes each cue's
    level by a different amount.

    So the *relative* spec is held exactly and the *absolute* one is relaxed by a single
    recorded number: every cue is scaled by the same gain, every bus relation survives to
    the last decimal, and `manifest.json` carries both `bankHeadroomGainDb` and each cue's
    resulting loudness so the deviation is a fact on the record rather than a surprise.
    """
    worst = max(peak_dbfs(x) for x in bank.values())
    return min(0.0, PEAK_CEILING_DBFS - worst)


# --- generators ----------------------------------------------------------------------


def t(duration_s: float) -> np.ndarray:
    return np.arange(int(round(duration_s * SR)), dtype=np.float64) / SR


def decay(times: np.ndarray, tau_s: float, attack_s: float = 0.004) -> np.ndarray:
    """Percussive envelope: a short linear attack, then an exponential tail."""
    env = np.exp(-times / tau_s)
    attack_n = max(1, int(round(attack_s * SR)))
    ramp = np.minimum(np.arange(times.shape[0], dtype=np.float64) / attack_n, 1.0)
    return env * ramp


def marimba(freq: float, duration_s: float, tau_s: float = 0.075) -> np.ndarray:
    """Two-tone wooden-bar timbre: fundamental plus the 4th and 10th partials a marimba
    bar actually emphasises, all under one exponential decay."""
    times = t(duration_s)
    body = (
        np.sin(2 * np.pi * freq * times)
        + 0.32 * np.sin(2 * np.pi * 4.0 * freq * times)
        + 0.08 * np.sin(2 * np.pi * 9.8 * freq * times)
    )
    return body * decay(times, tau_s)


def bell(freq: float, duration_s: float, tau_s: float, detune: float = 2.76) -> np.ndarray:
    """Inharmonic metallic partial stack (a tubular-bell ratio, not a harmonic series)."""
    times = t(duration_s)
    out = np.sin(2 * np.pi * freq * times) * decay(times, tau_s, attack_s=0.002)
    out += 0.55 * np.sin(2 * np.pi * freq * detune * times) * decay(times, tau_s * 0.6, 0.002)
    out += 0.25 * np.sin(2 * np.pi * freq * 5.40 * times) * decay(times, tau_s * 0.35, 0.002)
    return out


def place(canvas: np.ndarray, signal: np.ndarray, at_s: float, gain: float = 1.0) -> None:
    """Mix `signal` into `canvas` at `at_s`, truncated at the end of the canvas."""
    start = int(round(at_s * SR))
    end = min(canvas.shape[0], start + signal.shape[0])
    if end > start:
        canvas[start:end] += gain * signal[: end - start]


def fade_out(x: np.ndarray, seconds: float = 0.01) -> np.ndarray:
    """Taper the last samples to zero so a truncated tail cannot click."""
    n = min(x.shape[0], int(round(seconds * SR)))
    if n > 1:
        x = x.copy()
        x[-n:] *= np.linspace(1.0, 0.0, n)
    return x


# --- the cues ------------------------------------------------------------------------
#
# Pitch reference: A4 = 440 Hz, equal temperament. `COMBO_SEMITONE_CAP` exists because
# deep/08 §12 has the correct sting step up one scale degree per combo step and cap at
# +7; the shipped file is the combo-0 rendering and the player transposes it.

COMBO_SEMITONE_CAP = 7


def note(semitones_from_a4: float) -> float:
    return 440.0 * 2.0 ** (semitones_from_a4 / 12.0)


C5 = note(3)
E5 = note(7)
G5 = note(10)
C6 = note(15)
A4 = note(0)


def cue_correct() -> np.ndarray:
    """Rising two-note major third, marimba-ish, 240 ms (§12)."""
    out = np.zeros(int(0.240 * SR))
    place(out, marimba(C5, 0.150, tau_s=0.055), 0.000, 1.0)
    place(out, marimba(E5, 0.170, tau_s=0.070), 0.075, 1.0)
    return fade_out(out)


def cue_wrong() -> np.ndarray:
    """Short descending buzz, low-passed, 300 ms (§12). Never harsh: the visual wrong
    state is already loud, so this is a soft glide with the top end taken off."""
    times = t(0.300)
    f0, f1 = 196.0, 104.0
    freq = f0 * (f1 / f0) ** (times / times[-1])
    phase = 2 * np.pi * np.cumsum(freq) / SR
    # A soft buzz: three harmonics, not a raw saw.
    raw = np.sin(phase) + 0.45 * np.sin(2 * phase) + 0.18 * np.sin(3 * phase)
    env = np.minimum(times / 0.012, 1.0) * np.exp(-times / 0.130)
    return fade_out(lowpass(raw * env, 900.0))


def cue_combo_shimmer(rng: np.random.Generator) -> np.ndarray:
    """One-shot shimmer, 600 ms (§12), layered on its own bus 6 dB down (EC-COM-09)."""
    times = t(0.600)
    out = np.zeros_like(times)
    # Seven high partials on a slow swell, so it reads as texture rather than as a note
    # and can never be mistaken for the answer sting it plays alongside.
    for k in range(7):
        freq = 2100.0 * (1.0 + 0.37 * k) * float(rng.uniform(0.98, 1.02))
        phase = float(rng.uniform(0.0, 2 * np.pi))
        swell = np.minimum(times / 0.060, 1.0) * np.exp(-times / (0.150 + 0.035 * k))
        out += (0.85**k) * np.sin(2 * np.pi * freq * times + phase) * swell
    sparkle = bandpass(rng.standard_normal(times.shape[0]), 5200.0, q=1.4)
    out += 0.30 * sparkle * (np.minimum(times / 0.030, 1.0) * np.exp(-times / 0.110))
    return fade_out(out, 0.030)


def cue_fanfare() -> np.ndarray:
    """Four-note lesson-complete fanfare, 1.6 s (§12). Ducks under the XP ticks, so the
    tail is long and quiet rather than a second hit."""
    out = np.zeros(int(1.600 * SR))
    for i, (freq, at) in enumerate([(C5, 0.00), (E5, 0.13), (G5, 0.26), (C6, 0.39)]):
        place(out, marimba(freq, 0.55, tau_s=0.16), at, 1.0 - 0.06 * i)
    # The held final chord under the melody: C major, quiet, long.
    for freq in (C5, E5, G5, C6):
        place(out, bell(freq, 1.10, tau_s=0.42), 0.39, 0.16)
    return fade_out(out, 0.060)


def cue_chest(rng: np.random.Generator) -> np.ndarray:
    """Latch + coin spill, 1.1 s (§12)."""
    out = np.zeros(int(1.100 * SR))
    # Latch: a filtered noise click over a low wooden thunk.
    click_t = t(0.090)
    click = bandpass(rng.standard_normal(click_t.shape[0]), 2600.0, q=0.9)
    click *= np.exp(-click_t / 0.014)
    place(out, click, 0.0, 1.0)
    place(out, marimba(note(-17), 0.28, tau_s=0.075), 0.004, 0.9)
    # Coin spill: fourteen short metallic pings over the next 0.85 s, thinning out.
    for i in range(14):
        at = 0.13 + 0.058 * i + float(rng.uniform(-0.012, 0.012))
        freq = float(rng.uniform(1500.0, 3100.0))
        ping = bell(freq, 0.18, tau_s=0.030, detune=3.1)
        place(out, ping, at, 0.55 * (1.0 - i / 18.0))
    return fade_out(out, 0.050)


def cue_streak(rng: np.random.Generator) -> np.ndarray:
    """Flame whoosh + chime, 900 ms (§12)."""
    out = np.zeros(int(0.900 * SR))
    whoosh_t = t(0.560)
    noise = rng.standard_normal(whoosh_t.shape[0])
    # Sweep the band by crossfading three fixed band-passes: a time-varying biquad would
    # not be reproducible sample-for-sample across numpy versions, a crossfade is.
    low = bandpass(noise, 320.0, q=0.8)
    mid = bandpass(noise, 950.0, q=0.8)
    high = bandpass(noise, 2400.0, q=0.8)
    ramp = whoosh_t / whoosh_t[-1]
    sweep = (
        low * np.clip(1.0 - 2.0 * ramp, 0.0, 1.0)
        + mid * (1.0 - np.abs(2.0 * ramp - 1.0))
        + high * np.clip(2.0 * ramp - 1.0, 0.0, 1.0)
    )
    place(out, sweep * (np.minimum(whoosh_t / 0.050, 1.0) * np.exp(-whoosh_t / 0.320)), 0.0, 1.0)
    place(out, bell(G5, 0.52, tau_s=0.180), 0.350, 0.85)
    place(out, bell(C6, 0.48, tau_s=0.150), 0.395, 0.55)
    return fade_out(out, 0.040)


def _earcon(f_from: float, f_to: float) -> np.ndarray:
    """Two-tone mic earcon, 120 ms (§12). Required: the mic state is otherwise invisible,
    and INV-SND-02 keeps it playing even with Sound effects off."""
    out = np.zeros(int(0.120 * SR))
    place(out, marimba(f_from, 0.075, tau_s=0.028), 0.000, 1.0)
    place(out, marimba(f_to, 0.075, tau_s=0.030), 0.055, 1.0)
    return fade_out(out, 0.006)


def cue_earcon_start() -> np.ndarray:
    return _earcon(A4, E5)


def cue_earcon_stop() -> np.ndarray:
    return _earcon(E5, A4)


# --- the bank ------------------------------------------------------------------------


@dataclass(frozen=True)
class Cue:
    name: str
    target_lkfs: float
    bus: str
    spec: str


BANK: tuple[Cue, ...] = (
    Cue("correct", STING_BUS_LKFS, "sting", "deep/08 §12: rising two-note major third, 240 ms"),
    Cue("wrong", STING_BUS_LKFS, "sting", "deep/08 §12: descending low-passed buzz, 300 ms"),
    Cue(
        "combo-shimmer",
        SHIMMER_BUS_LKFS,
        "shimmer",
        "deep/08 §12 + EC-COM-09/INV-SND-01: one-shot shimmer, 600 ms, -6 dB second bus",
    ),
    Cue("fanfare", STING_BUS_LKFS, "sting", "deep/08 §12: four-note fanfare, 1.6 s"),
    Cue("chest", STING_BUS_LKFS, "sting", "deep/08 §12: latch + coin spill, 1.1 s"),
    Cue("streak", STING_BUS_LKFS, "sting", "deep/08 §12: flame whoosh + chime, 900 ms"),
    Cue("earcon-start", STING_BUS_LKFS, "earcon", "deep/08 §12: mic-on two-tone earcon, 120 ms"),
    Cue("earcon-stop", STING_BUS_LKFS, "earcon", "deep/08 §12: mic-off two-tone earcon, 120 ms"),
)


def render_bank_with_headroom() -> tuple[dict[str, np.ndarray], float]:
    """Every cue, normalised onto its bus, plus the one recorded bank-wide headroom gain.

    The `Generator` is created once and drawn from in a fixed order: that order is part of
    the output, so inserting a cue in the middle of the dict below rewrites every
    noise-bearing cue after it. Add new cues at the end.
    """
    rng = np.random.default_rng(SEED)
    raw: dict[str, np.ndarray] = {
        "correct": cue_correct(),
        "wrong": cue_wrong(),
        "combo-shimmer": cue_combo_shimmer(rng),
        "fanfare": cue_fanfare(),
        "chest": cue_chest(rng),
        "streak": cue_streak(rng),
        "earcon-start": cue_earcon_start(),
        "earcon-stop": cue_earcon_stop(),
    }
    bank = {cue.name: normalise_to(raw[cue.name], cue.target_lkfs) for cue in BANK}
    headroom_db = bank_headroom_gain_db(bank)
    gain = 10.0 ** (headroom_db / 20.0)
    return {name: samples * gain for name, samples in bank.items()}, headroom_db


def render_bank() -> dict[str, np.ndarray]:
    """The bank alone, for callers that do not need the headroom number."""
    return render_bank_with_headroom()[0]


# --- encoding ------------------------------------------------------------------------

OPUS_ARGS = [
    "-c:a",
    "libopus",
    "-b:a",
    "96k",
    "-vbr",
    "on",
    "-application",
    "audio",
    "-serial_offset",
    "0",
]
"""`-serial_offset 0` pins the Ogg page serial, which the muxer otherwise randomises —
without it no two encodes of the same input are ever byte-identical."""

AAC_ARGS = ["-c:a", "aac", "-b:a", "128k"]
"""AAC for the platforms where Opus playback is not a given; mp4 container."""

BITEXACT = ["-fflags", "+bitexact", "-flags", "+bitexact", "-map_metadata", "-1"]
"""Drops creation_time and the encoder tag, both of which are otherwise per-run noise."""


def ffmpeg_version(ffmpeg: str) -> str:
    out = subprocess.run([ffmpeg, "-version"], capture_output=True, text=True, check=True)
    return out.stdout.splitlines()[0].strip()


def encode(ffmpeg: str, source: Path, dest: Path, codec_args: list[str]) -> None:
    dest.unlink(missing_ok=True)
    subprocess.run(
        [ffmpeg, "-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-i", str(source)]
        + BITEXACT
        + ["-ar", str(SR), "-ac", "1"]
        + codec_args
        + [str(dest)],
        check=True,
    )


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


# --- entry point ---------------------------------------------------------------------


def bake(out_dir: Path, ffmpeg: str, keep_wav: bool = False) -> dict[str, object]:
    """Synthesise, encode, and return the manifest.

    The WAV master is an *intermediate*: it is what ffmpeg reads and what the
    reproducibility hash is taken over, but it is not a shipped artefact and it is not
    committed, so by default it is removed once both encodes exist. Leaving eight
    untracked WAVs behind after every bake would make `git status` dirty for a file the
    repository has deliberately decided not to carry, and the next person would either
    commit them by accident or add a .gitignore rule for an artefact that should not have
    been there. `--keep-wav` is for listening to the master.
    """
    out_dir.mkdir(parents=True, exist_ok=True)
    bank, headroom_db = render_bank_with_headroom()
    files: dict[str, object] = {}
    for cue in BANK:
        samples = bank[cue.name]
        wav = out_dir / f"{cue.name}.wav"
        opus = out_dir / f"{cue.name}.opus"
        aac = out_dir / f"{cue.name}.m4a"
        sf.write(str(wav), samples, SR, subtype="PCM_16", format="WAV")
        encode(ffmpeg, wav, opus, OPUS_ARGS)
        encode(ffmpeg, wav, aac, AAC_ARGS)
        wav_digest = sha256(wav)
        files[cue.name] = {
            "bus": cue.bus,
            "spec": cue.spec,
            "durationMs": round(1000.0 * samples.shape[0] / SR, 3),
            "targetLkfs": cue.target_lkfs,
            "loudnessLkfs": round(cue_loudness_lkfs(samples), 3),
            "peakDbfs": round(peak_dbfs(samples), 3),
            "sha256": {"wav": wav_digest, "opus": sha256(opus), "m4a": sha256(aac)},
        }
        if not keep_wav:
            wav.unlink()
    return {
        "$comment": (
            "Generated by tools/soundbank/synthesize.py. Never hand-edit: regenerate with "
            "`uv run --project tools/soundbank python tools/soundbank/synthesize.py "
            "--out art/sound` and review the diff. The wav hashes are the anchor and are "
            "asserted on every machine; the opus/m4a hashes are asserted only against the "
            "recorded ffmpeg build, because a codec bitstream belongs to the codec."
        ),
        "seed": SEED,
        "sampleRate": SR,
        "channels": 1,
        "stingBusLkfs": STING_BUS_LKFS,
        "shimmerBusLkfs": SHIMMER_BUS_LKFS,
        "peakCeilingDbfs": PEAK_CEILING_DBFS,
        "bankHeadroomGainDb": round(headroom_db, 3),
        "bankHeadroomNote": (
            "One gain applied to every cue so none exceeds peakCeilingDbfs. Bus relations "
            "(sting vs shimmer) are therefore exact; absolute loudness is this many dB "
            "under the -16 LKFS target. See bank_headroom_gain_db() in synthesize.py."
        ),
        "ffmpeg": ffmpeg_version(ffmpeg),
        "numpy": np.__version__,
        "python": f"{sys.version_info.major}.{sys.version_info.minor}",
        "cues": files,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, required=True, help="directory for the bank")
    parser.add_argument(
        "--manifest",
        type=Path,
        default=None,
        help="manifest path (default: <out>/manifest.json)",
    )
    parser.add_argument(
        "--keep-wav",
        action="store_true",
        help="leave the WAV masters in place (they are intermediates and not committed)",
    )
    args = parser.parse_args()

    ffmpeg = shutil.which("ffmpeg")
    if ffmpeg is None:
        parser.error("no ffmpeg on PATH; see tools/soundbank/README.md")

    manifest = bake(args.out, ffmpeg, keep_wav=args.keep_wav)
    manifest_path = args.manifest or (args.out / "manifest.json")
    manifest_path.write_text(json.dumps(manifest, indent=2, sort_keys=False) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
