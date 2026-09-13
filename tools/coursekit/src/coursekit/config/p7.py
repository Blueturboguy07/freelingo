"""P7 preparation declarations from the approved phase brief, 2026-09-13.

These labels declare the intended claim; actual packs still need their complete gates.
No A/B experiment: content input requirements, not observed interface measurements.
"""

from typing import Final

KIT_SCHEMA_VERSION: Final[int] = 1
KIT_CLAIM_BY_LANGUAGE: Final = {
    "fr": "cefr_checked",
    "de": "frequency_ordered",
    "ja": "frequency_ordered",
}
KIT_LABEL_BY_LANGUAGE: Final = {
    "fr": "A1 · CEFR-checked",
    "de": "Beginner · frequency-ordered",
    "ja": "Beginner · frequency-ordered · beta",
}
KIT_REQUIRED_INPUTS: Final = {
    "fr": ("curriculum", "cast"),
    "de": ("curriculum", "cast"),
    "ja": (
        "curriculum",
        "cast",
        "characters",
        "furigana",
        "strokes",
        "romanization",
        "alignment_gold",
    ),
}
KIT_FIELDS: Final = frozenset({"schema_version", "language", "title", "beta", "claim", "inputs"})
KIT_INPUT_FIELDS: Final = frozenset({"path", "sha256"})
KIT_HASH_PATTERN: Final[str] = r"[0-9a-f]{64}"
