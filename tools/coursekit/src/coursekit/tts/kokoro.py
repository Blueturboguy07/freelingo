"""Kokoro: the synthesis engine the Spanish, French and Japanese banks are baked on.

Apache-2.0 for the code AND the weights, which is the whole reason it is here. There
are no cloud keys in this environment, and the plan's local path is not a degradation
of a cloud path — a bake that falls back to a device voice ships audio that is neither
content-addressed nor reproducible, which is why `inputs.require_group('tts')` runs
before anything in this module is imported.

Three things this module is careful about, each of which silently changes every clip in
a bank while leaving every clip id alone:

1. **The weights are pinned by release tag and checked by digest.** `latest` would move
   every style vector under a manifest that still claims the old digests.
2. **A blend is a weighted sum of style vectors**, taken over the canonical sorted
   weight list from `cast.py`, so the same cast entry produces the same vector on every
   machine and in every Python dict ordering.
3. **`lang` is espeak's tag, not the pipeline's.** Kokoro's own `lang_code` is a third
   spelling again (`e` for Spanish). Passing the wrong one phonemises Spanish text with
   an English G2P and produces audio that sounds like a person reading Spanish badly —
   which no validator downstream can catch, because the text, the duration and the
   loudness are all fine.
"""

from __future__ import annotations

import hashlib
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from ..config.g8 import (
    KOKORO_ESPEAK_LANG,
    KOKORO_MODEL_FILENAME,
    KOKORO_RELEASE_TAG,
    KOKORO_RELEASE_URL,
    KOKORO_SAMPLE_RATE,
    KOKORO_SPANISH_VOICES,
    KOKORO_VOICES_FILENAME,
    KOKORO_WEIGHTS_BYTES,
    KOKORO_WEIGHTS_DEFAULT_DIR,
    KOKORO_WEIGHTS_ENV_VAR,
    KOKORO_WEIGHTS_SHA256,
)
from ..inputs import MissingInput, require_group
from . import register_voice
from .cast import CastRole

__all__ = ["KokoroEngine", "weights_dir"]


def weights_dir() -> Path:
    """Where the pinned model and voice pack live."""
    return Path(os.environ.get(KOKORO_WEIGHTS_ENV_VAR) or KOKORO_WEIGHTS_DEFAULT_DIR).expanduser()


@dataclass(slots=True)
class KokoroEngine:
    """A loaded Kokoro session. One per bake; loading it is seconds, not milliseconds."""

    lang: str
    model_path: Path
    voices_path: Path
    _kokoro: Any = None

    #: What the manifest records as the engine's identity. The pin is part of the
    #: re-bake key, so bumping the release re-bakes the bank by construction.
    engine_id: str = "kokoro"

    @property
    def pin(self) -> str:
        return KOKORO_RELEASE_TAG

    def load(self) -> None:
        require_group("tts", needed_by="g8 bake (kokoro)")
        _require_weights(self.model_path, self.voices_path)
        from kokoro_onnx import Kokoro  # noqa: PLC0415 - the group may be absent

        self._kokoro = Kokoro(str(self.model_path), str(self.voices_path))

    def voices(self) -> tuple[str, ...]:
        if self._kokoro is None:
            self.load()
        assert self._kokoro is not None
        return tuple(self._kokoro.get_voices())

    def style_for(self, role: CastRole) -> Any:
        """The style vector for a cast role: a stock vector, or a declared blend.

        The sum is taken over `role.weights`, which `cast.py` already sorted, so the
        float addition happens in one fixed order. Two machines that add the same
        floats in different orders get different vectors in the last bits, and a bank
        whose bytes depend on dict ordering is not reproducible.
        """
        if self._kokoro is None:
            self.load()
        assert self._kokoro is not None
        import numpy as np  # noqa: PLC0415 - rides with the tts group

        available = set(self._kokoro.get_voices())
        missing = [voice for voice, _ in role.weights if voice not in available]
        if missing:
            raise MissingInput(
                f"cast role {role.id!r} names {', '.join(missing)}, which the pinned "
                f"voice pack ({self.voices_path.name}) does not carry. Remedy: fix the "
                f"cast, or pin a release that has the voice — never substitute one, "
                f"because a substituted voice is a silent re-cast of a character."
            )
        blended = None
        for voice, weight in role.weights:
            vector = self._kokoro.get_voice_style(voice) * float(weight)
            blended = vector if blended is None else blended + vector
        return np.asarray(blended, dtype=np.float32)

    def synthesise(self, text: str, role: CastRole) -> tuple[Any, int]:
        """Render one line. Returns (float samples, sample rate)."""
        if self._kokoro is None:
            self.load()
        assert self._kokoro is not None
        espeak_lang = KOKORO_ESPEAK_LANG.get(self.lang)
        if espeak_lang is None:
            raise MissingInput(
                f"kokoro has no lang_code for {self.lang!r} "
                f"(it covers {', '.join(sorted(KOKORO_ESPEAK_LANG))}). German is "
                f"Piper's, at P7."
            )
        audio, rate = self._kokoro.create(
            text,
            voice=self.style_for(role),
            speed=role.rate,
            lang=espeak_lang,
        )
        if rate != KOKORO_SAMPLE_RATE:  # pragma: no cover - the model's rate is fixed
            raise MissingInput(
                f"kokoro returned {rate} Hz, not the pinned {KOKORO_SAMPLE_RATE}. "
                f"The weights are not the ones this bake declares."
            )
        return audio, rate


def _require_weights(model: Path, voices: Path) -> None:
    """Both files present, both digests matching the pin. Loud on either failure."""
    for path in (model, voices):
        if not path.exists():
            raise MissingInput(
                f"kokoro weights missing: {path}. Remedy: download the pinned release, "
                f"{KOKORO_RELEASE_URL.format(tag=KOKORO_RELEASE_TAG, filename=path.name)} "
                f"(or set {KOKORO_WEIGHTS_ENV_VAR} to a directory that has it). There is "
                f"no fallback voice by design."
            )
        expected_bytes = KOKORO_WEIGHTS_BYTES.get(path.name)
        actual_bytes = path.stat().st_size
        if expected_bytes is not None and actual_bytes != expected_bytes:
            raise MissingInput(
                f"{path.name} is {actual_bytes:,} bytes, the pin expects "
                f"{expected_bytes:,}. A partial download has the right name in the "
                f"right place; checked before the digest so a 325 MB file is not "
                f"hashed to learn it is half there."
            )
        expected = KOKORO_WEIGHTS_SHA256.get(path.name)
        if expected is None:  # pragma: no cover - both names are pinned
            continue
        digest = _sha256(path)
        if digest != expected:
            raise MissingInput(
                f"{path.name} hashes {digest}, the pin expects {expected}. A weights "
                f"swap that keeps the filename changes every clip in the bank and no "
                f"clip id, which is the one failure the manifest cannot show you."
            )


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


@register_voice("kokoro")
def build(lang: str) -> KokoroEngine:
    """Registry entry point: `TTS.get('kokoro')(lang)`."""
    root = weights_dir()
    return KokoroEngine(
        lang=lang,
        model_path=root / KOKORO_MODEL_FILENAME,
        voices_path=root / KOKORO_VOICES_FILENAME,
    )


def spanish_voices() -> tuple[str, ...]:
    """The three Spanish style vectors this cast was designed against.

    A function rather than a re-exported constant so `tests/test_cast.py` can compare
    it with the roster measured out of the real voice pack: the day Kokoro ships a
    fourth Spanish voice, D-CAST-ES-02 is re-opened by a failing test rather than by
    somebody happening to look.
    """
    return KOKORO_SPANISH_VOICES
