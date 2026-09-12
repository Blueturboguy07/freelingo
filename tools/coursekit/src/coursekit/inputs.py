"""The single place a per-language data source is resolved — and the single place a
missing one is refused.

`scope2/00` §2.1 lists six required inputs per language and writes "**None.** This is a
hard gate" in the fallback column for four of them. This module is that gate. Every
failure it raises is loud, names the source, names the remedy, and returns nothing
usable, because every interesting bug in a content pipeline is a silent degradation:

- `ja_50k.txt` 404s, and a loop that falls back to `ja_full.txt` gets whitespace-split
  Japanese "words" that are sentence fragments. V1 then passes vacuously over a ledger
  that means nothing.
- `align` is not installed, and an aligner that degrades to a fast_align-quality
  heuristic produces word-bank hints that are wrong in a way V4 cannot catch.
- `tts` is not installed, and a bake that falls back to the device system voice ships a
  pack whose audio is not content-addressed and not reproducible.
- A corpus with no licence verdict gets treated as shippable, and INV-PACK-13 — "the
  only invariant whose failure cannot be fixed after release" — is gone.

So: `resolve()` returns a resolved source or raises. `require_group()` raises on an
absent dependency group rather than letting a stage pick a worse tool. `shippable()`
and `forbid_unshippable()` refuse at ingest rather than at package time, because
filtering at package time leaves the forbidden text in every intermediate artefact.

The data — urls, licences, verdicts — lives in `config/base.py`. This file holds no
constants at all, which is what lets `tests/test_cli.py` enforce "no literal outside
config/" as an executable rule.
"""

from __future__ import annotations

import importlib.util
from dataclasses import dataclass
from pathlib import Path

from .config import (
    DEPENDENCY_GROUP_PROBES,
    GROUP_INSTALL_COMMAND,
    ISO3_BY_LANGUAGE,
    LANGUAGES,
    LOCALE_BY_LANGUAGE,
    SOURCES,
    Source,
)
from .runlog import LicenceRow

__all__ = [
    "ForbiddenSource",
    "MissingDependencyGroup",
    "MissingInput",
    "ResolvedSource",
    "group_is_installed",
    "licence_row",
    "opus_pair",
    "require_group",
    "resolve",
    "sources_for",
]


class MissingInput(RuntimeError):
    """A per-language source this language needs does not exist or does not apply.

    Carries the remedy verbatim from the source registry so the message is the fix,
    not a hint that a fix exists.
    """


class MissingDependencyGroup(RuntimeError):
    """An optional dependency group a stage needs is not installed.

    Separate from `MissingInput` so the CLI can say "install this" rather than "find
    this data", and so a stage can never catch one while meaning the other.
    """


class ForbiddenSource(RuntimeError):
    """A source whose licence forbids it was named. Refused at ingest, not at package."""


@dataclass(frozen=True, slots=True)
class ResolvedSource:
    """A source, a language, and the concrete URL for that pair."""

    source: Source
    lang: str
    url: str | None

    @property
    def id(self) -> str:
        return self.source.id

    @property
    def shippable(self) -> bool:
        """May a sentence from this source appear verbatim in a pack?"""
        return self.source.verdict == "shippable"

    @property
    def oracle_only(self) -> bool:
        """May it inform frequency, perplexity and alignment but never be shipped?"""
        return self.source.verdict == "oracle_only"


# ---------------------------------------------------------------------------
# Dependency groups
# ---------------------------------------------------------------------------


def group_is_installed(group: str) -> bool:
    """Is this optional dependency group importable in the current environment?

    A group is not "installed" because `pyproject.toml` declares it; it is installed
    when the interpreter can import its probe module (`config.DEPENDENCY_GROUP_PROBES`).
    """
    probe = DEPENDENCY_GROUP_PROBES.get(group)
    if probe is None:
        raise ValueError(f"unknown dependency group {group!r}")
    return importlib.util.find_spec(probe) is not None


def require_group(group: str, *, needed_by: str) -> None:
    """Raise `MissingDependencyGroup` unless the group is importable.

    Every stage that needs `align` or `tts` calls this FIRST, before it reads a row.
    CI syncs `nlp` and `lm` only — torch, transformers and onnxruntime are gigabytes
    and would not fit a 20-minute ubuntu job — so on a CI runner this is the line that
    turns "the aligner is missing" into a failure with a name instead of a stage that
    quietly does something worse. See `docs/pipeline.md`.
    """
    if group_is_installed(group):
        return
    raise MissingDependencyGroup(
        f"{needed_by} needs the {group!r} dependency group and it is not installed. "
        f"Install it with `{GROUP_INSTALL_COMMAND.format(group=group)}` "
        f"(run from tools/coursekit). "
        f"There is deliberately no fallback: a degraded {group} run produces a pack that "
        f"passes every row-level validator and is wrong."
    )


# ---------------------------------------------------------------------------
# Resolution
# ---------------------------------------------------------------------------


def resolve(source_id: str, lang: str, *, allow_forbidden: bool = False) -> ResolvedSource:
    """Resolve one source for one language, or raise.

    `allow_forbidden` exists for exactly one caller: the validator that proves a
    forbidden corpus is still classified (rather than quietly dropped from the table,
    which is how JParaCrawl ended up in `deep/10`'s corpus table with no verdict
    anywhere). Nothing in the build path passes it.
    """
    if lang not in LANGUAGES:
        raise MissingInput(f"unknown language {lang!r}; expected one of {', '.join(LANGUAGES)}")
    source = SOURCES.get(source_id)
    if source is None:
        raise MissingInput(
            f"no source registered as {source_id!r}. "
            f"Registered: {', '.join(sorted(SOURCES))}. "
            f"An unregistered source has no licence verdict, and a source with no "
            f"verdict must never be read (INV-PACK-13)."
        )
    if source.verdict == "forbidden" and not allow_forbidden:
        raise ForbiddenSource(
            f"{source.id} is forbidden for every language: licence {source.licence}. "
            f"{source.note} Remedy: {source.remedy}"
        )
    if lang not in source.languages:
        raise MissingInput(
            f"{source.id} does not cover {lang!r} (it covers "
            f"{', '.join(source.languages)}). {source.note} Remedy: {source.remedy}"
        )
    return ResolvedSource(source=source, lang=lang, url=_url_for(source, lang))


def _url_for(source: Source, lang: str) -> str | None:
    if source.url is None:
        return None
    return source.url.format(
        lang=lang,
        iso3=ISO3_BY_LANGUAGE[lang],
        locale=LOCALE_BY_LANGUAGE[lang],
        pair=opus_pair(lang),
    )


def opus_pair(lang: str) -> str:
    """The OPUS pair segment for `<lang>`-en, ISO-639-1 sorted ALPHABETICALLY.

    `en-es`, `en-fr`, `en-ja` — but `de-en`, never `en-de`. `deep/10` calls this "the
    single most common build-script bug", and it is silent in the worst way: the wrong
    spelling 404s, and a fetcher with a fallback then quietly uses another corpus.
    """
    return "-".join(sorted((lang, "en")))


def sources_for(lang: str, kind: str | None = None) -> tuple[ResolvedSource, ...]:
    """Every non-forbidden source that covers this language, optionally of one kind."""
    out: list[ResolvedSource] = []
    for source in SOURCES.values():
        if source.verdict == "forbidden" or lang not in source.languages:
            continue
        if kind is not None and source.kind != kind:
            continue
        out.append(ResolvedSource(source=source, lang=lang, url=_url_for(source, lang)))
    return tuple(out)


def licence_row(resolved: ResolvedSource) -> LicenceRow:
    """The runlog licence row for a resolved source. V10 and INV-PACK-13 read these."""
    return LicenceRow(
        source_id=resolved.source.id,
        licence=resolved.source.licence,
        verdict=resolved.source.verdict,
        attribution_required=resolved.source.attribution_required,
        attribution_owner=resolved.source.attribution_owner,
    )


def forbid_unshippable(resolved: ResolvedSource) -> None:
    """Refuse to ship text from a source that may only be an oracle.

    G4 calls this on every candidate's source. OpenSubtitles and CCMatrix may inform
    frequency, KenLM and alignment priors; a sentence from either must never reach a
    lesson slot, and NLLB stays here too while the ODC-By crawl-text question is open
    (plan risk 2).
    """
    if resolved.shippable:
        return
    raise ForbiddenSource(
        f"{resolved.id} is {resolved.source.verdict} for {resolved.lang}: its text may "
        f"inform statistics and may never be shipped verbatim. {resolved.source.note}"
    )


def missing_local_file(resolved: ResolvedSource, path: Path) -> MissingInput:
    """The error a fetcher raises when a source's local file is absent.

    A constructor rather than a raise so a caller can add context, and a single place
    so every "I could not find the corpus" message carries the same remedy.
    """
    return MissingInput(
        f"{resolved.id} for {resolved.lang} is not at {path}. "
        f"Remedy: {resolved.source.remedy} "
        f"URL: {resolved.url or '(no downloadable URL — this source is derived or built)'}"
    )
