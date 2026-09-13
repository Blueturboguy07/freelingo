"""Registered fr adapter; the installed model and self-test are hard gates."""

from ..adapters import register_adapter
from ..config.g1 import ADAPTER_BY_LANGUAGE, SPACY_MODEL_BY_LANGUAGE, SPACY_MODEL_VERSION
from .spacy_latin import SpacyLatinAdapter


@register_adapter("fr")
def build() -> SpacyLatinAdapter:
    return SpacyLatinAdapter(
        lang="fr",
        name=ADAPTER_BY_LANGUAGE["fr"],
        model=SPACY_MODEL_BY_LANGUAGE["fr"],
        model_version=SPACY_MODEL_VERSION,
    )
