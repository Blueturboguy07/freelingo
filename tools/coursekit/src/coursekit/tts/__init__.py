"""The voice registry, keyed by engine id.

A text-to-speech engine, build time only (D3: never at runtime).

This environment has no API keys, so the shipping path is open weights: **Kokoro**
(Apache-2.0 code and weights, `kokoro-onnx`) for es/fr/ja, and **Piper** (GPL-3.0, a
build-time tool and nothing more) for de, which Kokoro does not cover.

Piper's single Japanese voice is deliberately absent: `ja/ja_JA/hi_fi_captain/medium`
carries a MODEL_CARD stating CC BY-NC-SA 4.0 (review R7), the identical NC conflict
that cut TED2020 from the corpora. Per-voice licences are not uniform, so G9 records
one licence per voice file exactly as it records one per sentence.

Needs the `tts` group, which CI does not sync. `inputs.require_group` is called
first: a bake that falls back to a system voice ships audio that is neither
content-addressed nor reproducible.

## Registering

    # coursekit/tts/<yours>.py
    from ..tts import register_voice

    @register_voice("<engine id>")
    def build(...):
        ...

Discovery imports every module in this package at first lookup, so adding one is the
whole of the wiring. `p2-deps-scaffold` owns this file and nothing else in the package;
the implementations are p2-g8-bake's.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any, TypeVar

from .. import Registry

__all__ = ["TTS", "register_voice"]

TTS: Registry[Any] = Registry(__name__, "voice")

F = TypeVar("F", bound=Callable[..., Any])


def register_voice(key: str) -> Callable[[F], F]:
    """Register a voice under `key`. Returns the function unchanged.

    A duplicate key raises rather than overwriting: a voice silently shadowing
    another lane's reads as "my code isn't running" for an afternoon.
    """

    def decorate(fn: F) -> F:
        TTS.add(key, fn)
        return fn

    return decorate
