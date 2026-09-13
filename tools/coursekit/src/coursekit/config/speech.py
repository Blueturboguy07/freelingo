"""Freelingo speaking policy, 2026-09-13 (INV-MOD-13 / EC-MOD-27).

These thresholds are declared policy, not measured Duolingo constants. Explicit
punctuation, fillers, token units and contextual readings remain source evidence.
"""

SPEECH_SCHEMA_VERSION = 1
SPEECH_ALGORITHMS = {
    "algorithm": "stored-unit-f1-v1",
    "threshold": 0.7,
    "fallback": "normalized-levenshtein-v1",
    "fallbackThreshold": 0.7,
}
