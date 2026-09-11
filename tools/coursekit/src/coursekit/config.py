"""Named constants for the pipeline. No literal is written anywhere else."""

from __future__ import annotations

from typing import Final

#: Languages with a v1 course, in ship order (plan P2, P7).
LANGUAGES: Final[tuple[str, ...]] = ("es", "fr", "de", "ja")

#: One locale per course (EC-PACK-17 ruling).
LOCALE_BY_LANGUAGE: Final[dict[str, str]] = {
    "es": "es-ES",
    "fr": "fr-FR",
    "de": "de-DE",
    "ja": "ja-JP",
}

#: Audio budget per language, including Stories and Radio (plan, re-declared).
AUDIO_BUDGET_MB: Final[int] = 120

#: Opus bitrate the bank is transcoded to in G9.
OPUS_BITRATE_KBPS: Final[int] = 20

#: The reviewer-sample gate: a pack ships only at or below this wrong-item rate.
MAX_DEFECT_RATE: Final[float] = 0.02

#: Reviewer sample size per language.
REVIEWER_SAMPLE_ITEMS: Final[int] = 300

#: CEFR grading is claimed only where a CEFRLex resource exists (Q8 ruling).
CEFR_LANGUAGES: Final[tuple[str, ...]] = ("es", "fr")

#: Content packs are CC BY-NC-SA 4.0; NC/ND data is allowed into packs, never into code.
PACK_LICENCE: Final[str] = "CC-BY-NC-SA-4.0"
CODE_LICENCE: Final[str] = "AGPL-3.0-only"

#: INV-PACK-13: the ingest allow-list exists before G0 reads a byte. P2 fills it in.
INGEST_LICENCE_ALLOW_LIST: Final[tuple[str, ...]] = ()
