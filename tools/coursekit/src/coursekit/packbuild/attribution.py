"""INV-PACK-17: an attribution-requiring asset with no reachable credit fails the build.

Three kinds of thing in a pack can carry a licence that requires attribution, and the
invariant names all three because each one would otherwise be forgotten by a different
person:

- **a sentence.** Tatoeba is CC BY 2.0 FR — attribution-only — and its CC0 subset
  measures 2,266 bytes for Spanish against 313,297 for French, so "just ship CC0" is not
  available for three of the four v1 languages. Every shipped Spanish sentence needs a
  credit.
- **a voice.** A voice engine's code licence is not its voices' licence: Piper is GPL-3.0
  code whose one Japanese voice is CC BY-NC-SA (review R7). The licence rides per clip.
- **a derived list.** The frequency ordering is derived from hermitdave's CC BY-SA-4.0
  data and reaches the learner as *the order the units are taught in*. It is not a
  sentence and not a voice; it has no row of its own anywhere else in the pack; and it is
  share-alike, which the manifest has to declare.

"Reachable" is the operative word. A licence that requires attribution and has no
rendered credit is a licence violation, not a missing UI nicety — so this is a gate that
fails the build, and the credit rows it emits are written into the pack's `meta` table
where the credits surface (S152) reads them.

S152 is **not in `deep/00-PRODUCT-MAP.md`**: the map stops at S151 and this screen exists
only in the plan and in the invariant's own text. The map owes a row before P4 renders
it; the pack carries the data either way.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any

from ..config import ISO3_BY_LANGUAGE, LOCALE_BY_LANGUAGE, SOURCES
from ..config.g9 import (
    AUTHORED_SOURCE_ID,
    AUTHORED_SOURCE_URL,
    DERIVED_LIST_KINDS,
    SHARE_ALIKE_LICENCES,
    UNRESOLVED_LICENCE,
    VOICE_SOURCE_PREFIX,
)

if TYPE_CHECKING:  # pragma: no cover - typing only
    from .sqlite import PackInputs

__all__ = [
    "attribution_violations",
    "credit_rows",
    "derived_list_sources",
    "is_share_alike",
    "licence_for_source",
    "source_url",
]


def shipped_sentences(inputs: PackInputs) -> list[Mapping[str, Any]]:
    """Re-exported so this module reads the same set the pack writes, never the ledger."""
    from .sqlite import shipped_sentences as _shipped

    return _shipped(inputs)


def is_share_alike(licence: str) -> bool:
    """Whether the licence's share-alike clause must be declared."""
    return licence in SHARE_ALIKE_LICENCES


def source_url(source_id: str, lang: str) -> str | None:
    """A source's URL with its placeholders filled in for this language.

    `SOURCES` stores `{lang}`, `{iso3}` and `{locale}` unsubstituted because one row
    serves four courses. A credits surface must not render a brace: the learner is being
    shown where the text came from, and `{lang}_50k.txt` is not an answer.

    Two ids are not corpus ids and are resolved before the lookup: a voice arrives as
    `voice:<engine>`, and `freelingo_authored` has no corpus at all — its destination is
    the pack's own licence, because a credits row that points nowhere is not a credit.
    """
    if source_id == AUTHORED_SOURCE_ID:
        return AUTHORED_SOURCE_URL
    if source_id.startswith(VOICE_SOURCE_PREFIX):
        source_id = source_id[len(VOICE_SOURCE_PREFIX) :]
    source = SOURCES.get(source_id)
    if source is None or source.url is None:
        return None
    return (
        source.url.replace("{lang}", lang)
        .replace("{iso3}", ISO3_BY_LANGUAGE.get(lang, lang))
        .replace("{locale}", LOCALE_BY_LANGUAGE.get(lang, lang))
    )


def _licence_row(inputs: PackInputs, source_id: str) -> Mapping[str, Any] | None:
    """The run's own resolved licence row for a source, if the runlog carried one.

    Preferred over `config.SOURCES` because it is what *this run* actually read. The
    static table is the fallback and the OPUS legacy page is the authority behind both:
    OPUS grants no blanket licence and its API returns no licence field, so a manifest
    that recorded "OPUS" would be recording nothing.
    """
    for row in inputs.licences:
        if str(row.get("source_id")) == source_id:
            return row
    return None


def licence_for_source(inputs: PackInputs, source_id: str, licence: str) -> tuple[str | None, bool]:
    """`(owner, attribution_required)` for one source id.

    A voice row arrives as `voice:<engine>`; a sentence row as the corpus id. Unknown
    sources are treated as requiring attribution with **no owner**, which is what makes
    them fail `attribution_violations` rather than ship uncredited: the safe default for
    a licence question is "stop", never "assume CC0".
    """
    row = _licence_row(inputs, source_id)
    if row is not None:
        owner = row.get("attribution_owner")
        return (str(owner) if owner else None, bool(row.get("attribution_required", True)))

    probe = source_id.split(":", 1)[-1] if source_id.startswith("voice:") else source_id
    source = SOURCES.get(probe)
    if source is not None:
        return (source.attribution_owner, source.attribution_required)

    # Not a source anybody declared. If the licence itself is public-domain we still say
    # so, because CC0 genuinely requires nothing; everything else needs a human.
    if licence == "CC0-1.0":
        return (None, False)
    return (None, True)


def credit_rows(inputs: PackInputs) -> list[dict[str, Any]]:
    """The rows the credits surface renders, one per attributed source.

    Sentences and voices are grouped by source, because a credits screen listing 1,200
    identical Tatoeba lines is not a credits screen. Derived lists are listed one each.
    Every row carries its own item count so the surface can say what it covers.
    """
    credits: dict[str, dict[str, Any]] = {}

    def add(kind: str, source_id: str, licence: str, owner: str | None, url: str | None) -> None:
        existing = credits.get(source_id)
        if existing is None:
            credits[source_id] = {
                "kind": kind,
                "source_id": source_id,
                "owner": owner or "",
                "licence": licence,
                "share_alike": is_share_alike(licence),
                "url": url,
                "items": 1,
            }
            return
        existing["items"] += 1

    for sentence in shipped_sentences(inputs):
        source_id = str(sentence["source_id"])
        owner, required = licence_for_source(inputs, source_id, str(sentence["licence"]))
        if sentence.get("attribution_owner"):
            owner = str(sentence["attribution_owner"])
        if "attribution_required" in sentence:
            required = bool(sentence["attribution_required"])
        if not required:
            continue
        add(
            "sentence",
            source_id,
            str(sentence["licence"]),
            owner,
            source_url(source_id, inputs.lang),
        )

    for clip in inputs.clips:
        source_id = f"{VOICE_SOURCE_PREFIX}{clip['engine']}"
        owner, required = licence_for_source(inputs, source_id, str(clip["licence"]))
        if not required:
            continue
        add("voice", source_id, str(clip["licence"]), owner, source_url(source_id, inputs.lang))

    # Derived lists: everything this run read whose data reaches the learner as a derived
    # artefact rather than as text — the frequency ordering that becomes the teaching
    # order, the CEFR lexicon that becomes the band on every `lexeme` row. The rule is per
    # licence row and per source KIND, never a hard-coded source id.
    for source_id, row in derived_list_sources(inputs):
        if source_id in credits:
            continue
        owner = row.get("attribution_owner")
        credits[source_id] = {
            "kind": "derived-list",
            "source_id": source_id,
            "owner": str(owner) if owner else "",
            "licence": str(row.get("licence", UNRESOLVED_LICENCE)),
            "share_alike": is_share_alike(str(row.get("licence", ""))),
            "url": source_url(source_id, inputs.lang),
            "items": 1,
        }

    return [credits[key] for key in sorted(credits)]


def derived_list_sources(inputs: PackInputs) -> list[tuple[str, Mapping[str, Any]]]:
    """Every licence row whose data ships as a derived artefact and needs a credit.

    Walked from `inputs.licences` — the run's own resolved licence table — rather than
    from the credits it produces, so `attribution_violations` has something independent
    to compare against. Two defaults here are the safe ones and both were once the unsafe
    ones:

    - `attribution_required` defaults to **True**. It used to default to False here while
      `licence_for_source` defaulted to True, so a licence row that simply omitted the
      flag produced neither a credit nor a violation. Silence is the one outcome a
      licence gate may not have.
    - membership is decided by the source's `kind`, not by its `verdict`. `verdict` says
      whether a source's own TEXT may ship; CEFRLex is `oracle_only` and its bands ship
      on every `lexeme` row regardless, which is exactly the case the verdict filter used
      to drop.
    """
    out: list[tuple[str, Mapping[str, Any]]] = []
    for row in inputs.licences:
        source_id = str(row.get("source_id", ""))
        if not source_id or not row.get("attribution_required", True):
            continue
        source = SOURCES.get(source_id)
        if source is None or source.kind not in DERIVED_LIST_KINDS:
            continue
        out.append((source_id, row))
    return out


def attribution_violations(inputs: PackInputs) -> list[str]:
    """Every asset that requires attribution and has no reachable credit.

    Returned as a list, not raised: a pack that is wrong in four ways should say so once.
    `g9_package` turns a non-empty list into a failed stage, and nothing is written.
    """
    violations: list[str] = []
    credits = {row["source_id"]: row for row in credit_rows(inputs)}
    credited_owners = {
        str(row["owner"]) for row in credits.values() if str(row["owner"]).strip() != ""
    }

    for sentence in shipped_sentences(inputs):
        source_id = str(sentence["source_id"])
        licence = str(sentence["licence"])
        owner, required = licence_for_source(inputs, source_id, licence)
        if sentence.get("attribution_owner"):
            owner = str(sentence["attribution_owner"])
        if "attribution_required" in sentence:
            required = bool(sentence["attribution_required"])
        if licence == UNRESOLVED_LICENCE:
            violations.append(
                f"sentence {sentence['sentence_id']} carries an UNRESOLVED licence; the "
                f"per-corpus row comes from the OPUS legacy page, never from the API"
            )
            continue
        if not required:
            continue
        if owner is None or owner.strip() == "":
            violations.append(
                f"sentence {sentence['sentence_id']} is {licence} (attribution required) "
                f"and names no owner"
            )
        elif source_id not in credits:
            violations.append(
                f"sentence {sentence['sentence_id']} is attributed to {owner}, which no "
                f"credits row renders"
            )

    for clip in inputs.clips:
        source_id = f"{VOICE_SOURCE_PREFIX}{clip['engine']}"
        licence = str(clip["licence"])
        owner, required = licence_for_source(inputs, source_id, licence)
        if not required:
            continue
        if owner is None or owner.strip() == "":
            violations.append(
                f"voice clip {clip['clip_id']} ({clip['engine']}/{clip['voice_id']}) is "
                f"{licence} (attribution required) and names no owner"
            )
        elif owner not in credited_owners:
            violations.append(
                f"voice clip {clip['clip_id']} is attributed to {owner}, which no credits "
                f"row renders"
            )

    # Derived lists, walked from the run's licence table rather than from `credits`. This
    # is the only walk in this function whose input `credit_rows` does not also produce,
    # and it is the one that catches a derived list dropped from the credits for any
    # reason at all — a missing flag, an unknown kind, a filter added later. A frequency
    # ordering that ships uncredited is a share-alike violation nobody would ever see.
    for source_id, row in derived_list_sources(inputs):
        licence = str(row.get("licence", UNRESOLVED_LICENCE))
        owner = row.get("attribution_owner")
        if licence == UNRESOLVED_LICENCE:
            violations.append(
                f"derived list {source_id} carries an UNRESOLVED licence; the per-corpus "
                f"row comes from the OPUS legacy page, never from the API"
            )
            continue
        if owner is None or str(owner).strip() == "":
            violations.append(
                f"derived list {source_id} is {licence} (attribution required) and names "
                f"no owner"
            )
        elif source_id not in credits:
            violations.append(
                f"derived list {source_id} is attributed to {owner}, which no credits row "
                f"renders"
            )

    # And a licence row nobody can classify. `SOURCES` is where a source declares what
    # kind of thing it is; a row that requires attribution, is not a source we know, and
    # is credited by neither a sentence nor a voice is a licence question with no answer,
    # which stops the build rather than shipping on the assumption that it was harmless.
    for row in inputs.licences:
        source_id = str(row.get("source_id", ""))
        if not source_id or source_id in credits:
            continue
        if not row.get("attribution_required", True):
            continue
        if SOURCES.get(source_id) is not None:
            continue
        violations.append(
            f"licence row {source_id} requires attribution but declares no known source "
            f"kind, so the build cannot tell whether anything derived from it ships"
        )

    for row in credits.values():
        if str(row["owner"]).strip() == "":
            violations.append(f"credits row {row['source_id']} ({row['licence']}) renders no owner")

    return sorted(violations)
