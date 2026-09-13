"""P6 authoring format policy, 2026-09-13, from deep/06 and the current core players.

These are source-shape limits, not measured episode durations or language thresholds.
The Radio duration/language ramp remains explicitly authored in each source.
"""

RADIO_SCHEMA_VERSION = 1
RADIO_PREPARATION_REQUIREMENTS = ("review", "target-bindings", "curriculum-validation", "audio")
RADIO_LANGUAGES_IMPLEMENTED = frozenset({"es"})
RADIO_MIN_CONTENT_TILES = 2  # INV-STO-10 / EC-STO-27, not the requested answer count.
RADIO_MAX_MATCH_PAIRS = 5  # Current shared MATCH renderer displays at most five.
RADIO_MIN_OPTIONS = 2
RADIO_MAX_OPTIONS = 4
RADIO_LISTEN_PROMPT = "Select {count} words you hear"

RADIO_MATCH_PROMPT = "Match the pairs"
RADIO_SOURCE_REMAINING = (
    "exact-pack-targets",
    "independent-review",
    "combined-pack-validation",
    "measured-audio",
)
