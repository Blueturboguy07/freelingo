"""PCM in, a content-addressed 20 kbps Opus file out — and the file read back.

Two halves, and the second is the one INV-AUD-08 is about.

`encode()` writes `<clip_id>.opus` with `opusenc`. The name is the re-bake key
(`cast.rebake_key`), not a digest of the encoder's output: hashing the output would
make every clip id move when opus-tools is upgraded, and the id is what the app's FSRS
rows and the manifest are keyed by. Hashing the INPUTS means one edited line re-renders
exactly one file and every other id in the bank is untouched.

`decode()` reads that file back to float samples. The bake measures loudness on what
`decode()` returns, never on what went into `encode()`. A 20 kbps encode is exactly
where a clip's level can move, so measuring the encoder's input and calling it the
shipped loudness is the assumption INV-AUD-08's word "measures" exists to forbid.

Neither function has a fallback. If `opusenc` is absent the bake stops, because the
alternatives — ffmpeg's libopus at a different default framesize, or shipping the WAV —
produce a bank whose bytes do not match the manifest that describes it.
"""

from __future__ import annotations

import shutil
import subprocess
import wave
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from ..config import OPUS_BITRATE_KBPS
from ..config.g8 import (
    CLIP_FILENAME,
    OPUS_DECODER,
    OPUS_DECODER_ARGS,
    OPUS_ENCODER,
    OPUS_ENCODER_ARGS,
    OPUS_SERIAL_MASK,
)
from ..inputs import MissingInput

__all__ = ["EncodedClip", "clip_filename", "decode", "encode", "ogg_serial", "require_tools"]


@dataclass(frozen=True, slots=True)
class EncodedClip:
    """What landed on disk."""

    clip_id: str
    path: Path
    bytes: int


def clip_filename(clip_id: str) -> str:
    return CLIP_FILENAME.format(clip_id=clip_id)


def ogg_serial(clip_id: str) -> int:
    """A deterministic Ogg stream serial for a clip, so the encode is reproducible.

    opusenc's default is a random serial, which makes two encodes of identical PCM
    differ in bytes and therefore in sha256 — see `OPUS_SERIAL_MASK`. Derived from the
    clip id (itself the hash of every input to the audio) rather than fixed, so the
    streams stay distinguishable; from a stable hash of the STRING rather than
    `hash()`, whose per-process salt would put the non-determinism straight back.
    """
    import hashlib

    digest = hashlib.sha256(clip_id.encode("utf-8")).digest()
    return int.from_bytes(digest[:4], "big") & OPUS_SERIAL_MASK


def require_tools() -> None:
    """Both CLI tools on PATH, or a failure that names the package.

    Checked once, before the first synthesis rather than before the first encode: a
    bake that renders 8,000 lines and then discovers it cannot encode them has spent
    the whole run to produce nothing.
    """
    missing = [tool for tool in (OPUS_ENCODER, OPUS_DECODER) if shutil.which(tool) is None]
    if missing:
        raise MissingInput(
            f"{', '.join(missing)} not on PATH. Install opus-tools "
            f"(`brew install opus-tools`, `apt-get install -y opus-tools`). There is no "
            f"ffmpeg fallback by design: a different encoder at the same nominal "
            f"bitrate writes different bytes, and the manifest describes bytes."
        )


def encode(samples: Any, rate: int, clip_id: str, directory: Path) -> EncodedClip:
    """Write `<clip_id>.opus` into `directory` at the declared bitrate.

    The WAV handed to `opusenc` is 16-bit PCM written through the stdlib rather than
    soundfile, so the intermediate is byte-identical on any machine with the same
    samples — soundfile's WAV writer emits a `LIST`/`INFO` chunk whose contents vary.
    """
    import numpy as np  # noqa: PLC0415 - rides with the tts group

    directory.mkdir(parents=True, exist_ok=True)
    target = directory / clip_filename(clip_id)
    source = directory / f".{clip_id}.wav"

    clipped = np.clip(np.asarray(samples, dtype=np.float64).reshape(-1), -1.0, 1.0)
    pcm = (clipped * 32767.0).round().astype("<i2")
    with wave.open(str(source), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(rate)
        handle.writeframes(pcm.tobytes())

    args = [
        arg.format(bitrate=OPUS_BITRATE_KBPS, serial=ogg_serial(clip_id))
        for arg in OPUS_ENCODER_ARGS
    ]
    result = subprocess.run(  # noqa: S603 - fixed argv, no shell
        [OPUS_ENCODER, *args, str(source), str(target)],
        capture_output=True,
        text=True,
        check=False,
    )
    source.unlink(missing_ok=True)
    if result.returncode != 0 or not target.exists():
        raise MissingInput(
            f"{OPUS_ENCODER} failed for clip {clip_id} (exit {result.returncode}): "
            f"{result.stderr.strip() or '(no stderr)'}"
        )
    return EncodedClip(clip_id=clip_id, path=target, bytes=target.stat().st_size)


def decode(path: Path) -> tuple[Any, int]:
    """Decode a packed clip back to float samples, for measurement.

    `opusdec` writes a WAV to stdout when handed `-`; it is read with the stdlib for
    the same reason `encode` writes with it.

    The rate comes from the WAV header rather than being assumed. Opus runs at 48 kHz
    internally, but `opusenc` records the INPUT rate in the Ogg header and `opusdec`
    resamples back to it unless `--rate` overrides — so a 24 kHz Kokoro render decodes
    at 24 kHz, measured. The returned rate is the one the measurement is taken at and
    the one the manifest records the duration from; nothing here hard-codes 48 kHz.
    """
    import numpy as np  # noqa: PLC0415 - rides with the tts group

    result = subprocess.run(  # noqa: S603 - fixed argv, no shell
        [OPUS_DECODER, *OPUS_DECODER_ARGS, str(path), "-"],
        capture_output=True,
        check=False,
    )
    if result.returncode != 0 or not result.stdout:
        raise MissingInput(
            f"{OPUS_DECODER} failed for {path.name} (exit {result.returncode}): "
            f"{result.stderr.decode(errors='replace').strip() or '(no stderr)'}"
        )
    import io  # noqa: PLC0415 - only this branch needs it

    with wave.open(io.BytesIO(result.stdout), "rb") as handle:
        rate = handle.getframerate()
        channels = handle.getnchannels()
        width = handle.getsampwidth()
        frames = handle.readframes(handle.getnframes())

    if width == 4:
        samples = np.frombuffer(frames, dtype="<f4").astype(np.float64)
    elif width == 2:
        samples = np.frombuffer(frames, dtype="<i2").astype(np.float64) / 32768.0
    else:  # pragma: no cover - opusdec emits 16-bit or float
        raise MissingInput(f"{OPUS_DECODER} returned {width * 8}-bit samples for {path.name}")

    if channels > 1:  # pragma: no cover - every clip is mono by `--downmix-mono`
        samples = samples.reshape(-1, channels).mean(axis=1)
    return samples, rate
