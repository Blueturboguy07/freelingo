"""Conversation role evidence, declared 2026-09-13; no reference-app A/B constant.

Build-only approvals reuse existing language and repetition limits. Signed metadata
uses the existing pack meta table, without adding an exercise or database field.
"""

from typing import Final

CONVERSATION_EVIDENCE_VERSION: Final[int] = 1
CONVERSATION_EVIDENCE_PATH: Final[str] = "authoring/conversations.jsonl"
CONVERSATION_APPROVAL_PATH: Final[str] = "g6/conversation-approval.json"
CONVERSATION_EVIDENCE_LICENCE: Final[str] = "CC-BY-NC-SA-4.0"
CONVERSATION_META_PREFIX: Final[str] = "conversation:"
CONVERSATION_ROLES: Final[tuple[str, ...]] = ("first_turn", "correct_reply", "wrong_reply")
CONVERSATION_SHAPE: Final[str] = "complete_the_chat"
