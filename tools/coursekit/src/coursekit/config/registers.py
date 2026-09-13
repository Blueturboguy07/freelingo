"""Declared unit registers — founder B19, 2026-09-12 (DECISIONS-LOG.md).

Spanish defaults to tuteo. The formal/informal-address concept (currently unit 23)
explicitly teaches ustedeo. `n/a` means no address contrast slot, not a neutral
exception to the course policy. Other languages need their own approved policy.
"""

from typing import Final

DEFAULT_REGISTER_BY_LANGUAGE: Final[dict[str, str]] = {"es": "tu"}
REGISTER_BY_CONCEPT: Final[dict[str, dict[str, str]]] = {
    "es": {"formal_informal_address": "usted"},
}
REGISTER_SLOT_BY_LANGUAGE: Final[dict[str, str]] = {"es": "binary_t_v"}
