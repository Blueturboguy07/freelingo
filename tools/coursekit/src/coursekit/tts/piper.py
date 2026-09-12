"""Piper: the German engine, reserved for P7, and the place review R7 is enforced.

Piper is a **build-time tool and nothing more**. It is GPL-3.0 at `OHF-Voice/piper1-gpl`
and its synthesiser never links into the app, which is what keeps it compatible with an
AGPL codebase and a CC BY-NC-SA pack.

This module exists at P2, before the German kit, for one reason: R7. `deep/10` listed
Piper as reproducibility insurance "covering ja", and its single Japanese voice
`ja/ja_JA/hi_fi_captain/medium` carries a MODEL_CARD stating **CC BY-NC-SA 4.0** —
derived from NICT's Hi-Fi-CAPTAIN corpus. That is the identical NC conflict that cut
TED2020 from the corpora, and the HF repo card's `license: mit` was never asserted over
the Japanese tree at all (whose path is `ja/ja_JA`; `ja/ja_JP` 404s). A voice engine's
code licence is not its voices' licence.

So the refusal is code, not a comment. `build('ja')` raises. The alternative — a note in
a spec file — is how the Japanese row got into `deep/10` in the first place, and the
failure mode is a shipped pack that cannot be relicensed after release.

Synthesis itself is P7's. This module resolves and refuses; it does not yet render.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from ..config.g8 import (
    BAKE_ENGINE_BY_LANGUAGE,
    PIPER_LANGUAGES,
    PIPER_VOICE_URL,
)
from ..inputs import ForbiddenSource, MissingInput
from . import register_voice

__all__ = ["PiperEngine", "build"]


@dataclass(slots=True)
class PiperEngine:
    """A resolved Piper voice. Rendering lands with the German kit at P7."""

    lang: str
    voice: str
    quality: str

    engine_id: str = "piper"

    @property
    def pin(self) -> str:
        """Piper voices are pinned per file, not per release: the HF tree has no tags
        and per-voice MODEL_CARD licences are not uniform, so G9 records one licence per
        voice file exactly as it records one per sentence."""
        return f"{self.voice}/{self.quality}"

    @property
    def url(self) -> str:
        return PIPER_VOICE_URL.format(voice=self.voice, quality=self.quality)

    def synthesise(self, text: str, role: object) -> tuple[object, int]:
        raise MissingInput(
            "piper synthesis lands with the German kit at P7. G8 resolves and refuses "
            "voices today; it does not render German. Baking de now would produce a "
            "bank no validator in this phase covers."
        )


@register_voice("piper")
def build(lang: str, *, voice: str = "thorsten", quality: str = "medium") -> PiperEngine:
    """Resolve a Piper voice for `lang`, or refuse.

    Japanese is refused with `ForbiddenSource`, the same exception the ingest
    allow-list raises for TED2020, because it is the same decision: an NC asset cannot
    ride in something a commercial fork may redistribute, and filtering it later leaves
    it in every intermediate artefact.
    """
    if lang == "ja":
        raise ForbiddenSource(
            "piper has no shippable Japanese voice. Its only one, "
            "ja/ja_JA/hi_fi_captain/medium, carries a MODEL_CARD stating "
            "CC BY-NC-SA 4.0 (review R7) — the NC conflict that cut TED2020. The "
            "Japanese bank is Kokoro's (Apache-2.0 code and weights). The repo-level "
            "'license: mit' tag was never asserted over the ja tree."
        )
    if lang not in PIPER_LANGUAGES:
        raise MissingInput(
            f"piper is the {', '.join(PIPER_LANGUAGES)} engine here; {lang!r} bakes on "
            f"{BAKE_ENGINE_BY_LANGUAGE.get(lang, 'no registered engine')!r}. Kokoro has "
            f"no German, which is the only reason Piper is in this pipeline at all."
        )
    return PiperEngine(lang=lang, voice=voice, quality=quality)


def voice_licence_path(root: Path, voice: str, quality: str) -> Path:
    """Where the per-voice MODEL_CARD lands. G9 reads the licence out of this file.

    A path helper rather than a licence constant on purpose: per-voice licences are not
    uniform across the Piper tree, so there is no correct value to hard-code — only a
    file to read, per voice, at bake time.
    """
    return root / voice / quality / "MODEL_CARD"
