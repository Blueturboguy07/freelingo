"""P2 answer-review boundary, declared 2026-09-13; no reference-app A/B constant.

The record is original authoring evidence and a build-only G6 approval sidecar. It
adds no exercise/database field and changes no defect-rate or language threshold.
"""

from typing import Final

ANSWER_EVIDENCE_VERSION: Final[int] = 1
ANSWER_EVIDENCE_PATH: Final[str] = "authoring/answers.jsonl"
ANSWER_APPROVAL_PATH: Final[str] = "g6/answer-approval.json"
ANSWER_EVIDENCE_LICENCE: Final[str] = "CC-BY-NC-SA-4.0"
