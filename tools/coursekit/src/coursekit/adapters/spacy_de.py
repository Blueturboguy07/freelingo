"""Registered de adapter; the installed model and self-test are hard gates."""

from ..adapters import register_adapter
from ..config.g1 import ADAPTER_BY_LANGUAGE, SPACY_MODEL_BY_LANGUAGE, SPACY_MODEL_VERSION
from .spacy_latin import SpacyLatinAdapter


@register_adapter("de")
def build() -> SpacyLatinAdapter:
    return SpacyLatinAdapter(
        lang="de",
        name=ADAPTER_BY_LANGUAGE["de"],
        model=SPACY_MODEL_BY_LANGUAGE["de"],
        model_version=SPACY_MODEL_VERSION,
    )
