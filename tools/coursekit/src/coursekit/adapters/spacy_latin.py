"""French/German adapters reuse the exact existing spaCy analysis boundary.

No Spanish normalization table is copied. Real G1 requires a nonempty measured
self-test corpus for the language, so the registry alone cannot certify readiness.
"""

from __future__ import annotations

from ..config.g1 import ADAPTER_SELFTEST
from ..inputs import MissingInput
from .spacy_es import AdapterSelfTestFailed, SpacyEsAdapter


class SpacyLatinAdapter(SpacyEsAdapter):
    """Same token/lemma/span contract; language-specific model and frozen corpus."""

    def self_test(self) -> list[str]:
        if not ADAPTER_SELFTEST.get(self.lang):
            raise MissingInput(
                f"{self.lang} has no measured nonempty adapter self-test corpus. "
                "Freeze the pinned model's original probe output before G1."
            )
        return super().self_test()

    def require_self_test(self) -> None:
        failures = self.self_test()
        if failures:
            raise AdapterSelfTestFailed(
                f"{self.model}-{self.model_version} differs from the frozen {self.lang} "
                "self-test corpus; no G1 rows may be written:\n  " + "\n  ".join(failures)
            )
