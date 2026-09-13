"""Bound Japanese script evidence, approved P7 contract on 2026-09-13.

These are build evidence constants, not UI observations or pronunciation approvals.
"""

from typing import Final

SCRIPT_SCHEMA_VERSION: Final[int] = 1
READING_REVIEW_STATUS: Final[str] = "unreviewed"
SCRIPT_FIELDS: Final = frozenset(
    {
        "schema_version",
        "lang",
        "sentence_id",
        "text",
        "text_sha256",
        "adapter",
        "analysis_sha256",
        "mode_c_tokens",
        "mode_a_surface_readings",
        "tts_reading",
        "reading_review_status",
    }
)
MODE_C_FIELDS: Final = frozenset({"surface", "start", "end", "reading"})
MODE_A_READING_FIELDS: Final = MODE_C_FIELDS | {"token_index"}
# Kana with punctuation/whitespace and Unicode combining marks; kanji/Latin/digits
# are forbidden. This is a script check, not a claim of correct pronunciation.
KANA_ALLOWED_PATTERN: Final[str] = r"[\p{Hiragana}\p{Katakana}\p{P}\p{M}\sー]+"
KANA_REQUIRED_PATTERN: Final[str] = r"[\p{Hiragana}\p{Katakana}]"
