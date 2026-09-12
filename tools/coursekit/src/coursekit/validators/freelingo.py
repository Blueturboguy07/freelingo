"""F1, F3, F4, F5 — the four Freelingo validators no single lane could write.

F2 lives in `validators/audio.py`, beside the bank it measures. These four do not belong
to one lane, which is why they were missing when eight P2 branches met in one tree:

* **F1** is about what G0 did *before* it read anything, and the only record of that is
  the runlog the ingest lane writes. The ingest lane cannot run a validator over a run
  it is part of, and the validator lane had no runlog to read.
* **F3** re-checks G9's own attribution gate from outside the stage. G9 refuses to write
  a pack with an unreachable credit; F3 exists because a pack can also arrive from a
  release, a cache, or a build whose gate was edited.
* **F4** verifies the signature `coursekit sign` writes — a different command, run in a
  different job, with a key the build job does not have.
* **F5** is the Japanese characters stage, which lands at P7. It is registered now and
  it is registered honestly: `es` reports *not applicable* with the reason, and `ja`
  reports **blocking** until the stage exists.

`pipeline-ready` in `pack-ci.yml` refuses to build a pack while any id in
`config.VALIDATOR_IDS` is unregistered, so all five had to exist for `build-es` to run at
all. That gate is right, and the temptation it creates is the thing to name: four
validators that return `[]` would have turned the workflow green in ten minutes and made
`scope2/00` §2.4's "hard CI gate" into a list of function names. Every one below fails on
a real defect, and `tests/test_validators_freelingo.py` plants that defect for each.

Owner: P2 integration.
"""

from __future__ import annotations

import json
from collections.abc import Mapping
from pathlib import Path
from typing import Any

from ..artifacts import read_records, stage_dir
from ..config import LANGUAGES, PACK_STAGE_ID
from ..config.g0 import INGEST_CORPORA_BY_LANGUAGE, UNRESOLVED_LICENCE
from ..config.g9 import MANIFEST_FILENAME
from ..runlog import licences_seen, read_entries
from ..signing import (
    SignatureInvalid,
    trusted_public_key_spki,
    verify_manifest,
)
from . import Finding, ValidatorContext, register_validator

__all__ = [
    "attribution_reachable",
    "characters_cover_every_taught_glyph",
    "ingest_licence_allow_list",
    "manifest_signature_verifies",
]

#: Verdicts a licence row may carry and still have been read. `forbidden` may not.
#:
#: Two, not one, and the distinction is `sources/licences.py`'s: `oracle_only` (NLLB under
#: ODC-By, OpenSubtitles, CCMatrix) MAY be ingested — capped — to inform frequency, KenLM
#: and alignment priors, and may never fill a lesson slot. Conflating "may not be
#: ingested" with "may not be shipped" would make F1 refuse a run the plan asks for; not
#: distinguishing them at all is how crawl-derived text ships verbatim. So the read gate
#: takes both and the ship gate below takes only `shippable`.
_READABLE_VERDICTS = frozenset({"shippable", "oracle_only"})
#: The verdict a source's TEXT must carry to appear verbatim in a pack.
_SHIPPABLE_VERDICT = "shippable"
#: Languages that declare a character syllabus, and therefore have an F5 to answer.
#: `ja` only, and that is the invariant: INV-PACK-16 is about kana and kanji.
_CHARACTER_LANGUAGES = ("ja",)


def _blocking(validator_id: str, message: str, subject: str, **detail: Any) -> Finding:
    return Finding(
        validator_id=validator_id,
        severity="blocking",
        message=message,
        subject=subject,
        detail=detail,
    )


# ---------------------------------------------------------------------------
# F1 — INV-PACK-13, the ingest licence allow-list
# ---------------------------------------------------------------------------


@register_validator("F1")
def ingest_licence_allow_list(ctx: ValidatorContext) -> list[Finding]:
    """Every corpus this run read was permitted before it was read, and is on record.

    INV-PACK-13 says NC and ND sources are excluded **at ingest, not at package time**,
    and the difference is the whole invariant: a pipeline that downloads TED2020, parses
    it and drops the rows at the end passes every output check while having written
    CC BY-NC-ND text into each intermediate artefact and onto the build machine's disk.

    An output check therefore cannot answer this and the validator does not try. It reads
    the **runlog** — the only record of what G0 did before it opened a socket — and asks
    four questions whose failures have four different fixes:

    1. is there a G0 entry at all, and did it succeed? (no entry is not "clean";
       `require_successful` exists for the same reason)
    2. does every source G0 OPENED carry a licence row, and does every recorded row carry
       a readable verdict and a resolved licence? (a corpus the table configures and this
       run did not read is a `warning`, not a violation: the invariant is about what was
       ingested, and a capped ingest is a legitimate thing to do)
    3. does every `source_id` that reached the ledger appear in those rows? A corpus that
       shipped sentences without a recorded permit is one that walked around the gate.
    4. does every attribution-required row name a non-empty owner? (INV-PACK-17's input;
       V10 asks the same of the shipped join, F1 asks it of the ingest record, and a
       disagreement between the two is itself the finding)

    The run's own rows are read, never `config.SOURCES`: the table says what should have
    happened and the log says what did.
    """
    findings: list[Finding] = []
    lang = ctx.lang

    entries = {entry["stage"]: entry for entry in read_entries(lang)}
    g0 = entries.get("g0")
    if g0 is None:
        return [
            _blocking(
                "F1",
                f"no g0 entry in the runlog for {lang}: this run has no record of which "
                f"corpora were read or under what licence. INV-PACK-13 is a property of "
                f"the ingest, so a missing record is a failure, never a clean bill.",
                lang,
            )
        ]
    if str(g0.get("status")) != "ok":
        findings.append(
            _blocking(
                "F1",
                f"the g0 entry reports status {g0.get('status')!r}; a failed ingest's "
                f"licence record is not evidence that the allow-list held.",
                lang,
                status=g0.get("status"),
            )
        )

    rows = list(licences_seen(lang))
    if not rows:
        return [
            *findings,
            _blocking(
                "F1",
                f"g0 ran for {lang} and recorded no licence rows. A validator that "
                f"passes over an empty ledger checks nothing — this is the "
                f"`maestro test` over an empty directory of licence gates.",
                lang,
            ),
        ]

    by_source: dict[str, Mapping[str, Any]] = {str(row["source_id"]): row for row in rows}

    # Every source G0 actually OPENED must be on the licence record. `record_input` is
    # called on the same line as `record_licence`, so a source in `inputs` with no row is
    # a source read outside the gate.
    opened = [str(source) for source in (g0.get("inputs") or [])]
    for source_id in opened:
        if source_id not in by_source:
            findings.append(
                _blocking(
                    "F1",
                    f"g0 opened {source_id!r} for {lang} and recorded no licence for it. "
                    f"`permit()` is what returns the row, so a source read without one was "
                    f"read without a permit.",
                    source_id,
                )
            )

    # A corpus the table configures and this run did not read is NOT a licence failure.
    # The invariant is about what was read; a capped or partial ingest is a legitimate
    # thing to do and reporting it as a violation would train a reader to ignore F1.
    unread = [
        corpus
        for corpus in INGEST_CORPORA_BY_LANGUAGE.get(lang, ())
        if corpus not in by_source and corpus not in opened
    ]
    if unread:
        findings.append(
            Finding(
                validator_id="F1",
                severity="warning",
                message=(
                    f"{', '.join(unread)} configured for {lang} and not read by this run. "
                    f"Not a licence violation — INV-PACK-13 is about what was ingested — "
                    f"but a pack built from fewer corpora than the table declares is a "
                    f"different pack, and the report should say so."
                ),
                subject=lang,
                detail={"unread": unread},
            )
        )

    for corpus, row in sorted(by_source.items()):
        verdict = str(row.get("verdict", "")).lower()
        if verdict not in _READABLE_VERDICTS:
            findings.append(
                _blocking(
                    "F1",
                    f"{corpus!r} was read for {lang} under verdict {verdict!r}. Only "
                    f"{', '.join(sorted(_READABLE_VERDICTS))} may be ingested at all; a "
                    f"forbidden source is refused at resolve(), so a row like this means "
                    f"the gate was bypassed rather than that the corpus was filtered.",
                    corpus,
                    verdict=verdict,
                    licence=row.get("licence"),
                )
            )
        if str(row.get("licence", "")).upper() in {"", UNRESOLVED_LICENCE.upper()}:
            findings.append(
                _blocking(
                    "F1",
                    f"{corpus!r} reached the ledger with an unresolved licence. "
                    f"INV-PACK-13's allow-list is an ALLOW-list: anything unclassified "
                    f"fails, because 'we could not tell' and 'it is fine' are the two "
                    f"things a licence gate must never confuse.",
                    corpus,
                    licence=row.get("licence"),
                )
            )

    try:
        sentences = list(read_records("ingested_sentence", lang=lang))
    except FileNotFoundError:
        sentences = []
        findings.append(
            _blocking(
                "F1",
                f"g0 reports success for {lang} and wrote no ingested_sentence artefact; "
                f"the source ids that reached the ledger cannot be checked against the "
                f"licence rows.",
                lang,
            )
        )

    unrecorded = sorted(
        {
            str(row["source_id"])
            for row in sentences
            if str(row.get("source_id", "")) not in by_source
        }
    )
    for source_id in unrecorded:
        findings.append(
            _blocking(
                "F1",
                f"sentences from {source_id!r} reached the ledger and the runlog holds no "
                f"licence row for that source. A corpus with no recorded permit is a "
                f"corpus that was read without one.",
                source_id,
            )
        )

    oracle_shipped = sorted(
        {
            str(row["sentence_id"])
            for row in sentences
            if str(by_source.get(str(row.get("source_id", "")), {}).get("verdict", ""))
            not in {"", _SHIPPABLE_VERDICT}
        }
    )
    if oracle_shipped:
        findings.append(
            _blocking(
                "F1",
                f"{len(oracle_shipped)} ingested row(s) carry text from an `oracle_only` "
                f"source (first: {oracle_shipped[0]}). NLLB and the crawl corpora may "
                f"inform frequency, KenLM and alignment priors and may never appear "
                f"verbatim in a pack while the ODC-By crawl-text question is open "
                f"(plan risk 2); `inputs.forbid_unshippable` is what should have stopped "
                f"this at G4.",
                lang,
                count=len(oracle_shipped),
                first=oracle_shipped[0],
            )
        )

    ownerless = sorted(
        {
            str(row["sentence_id"])
            for row in sentences
            if bool(row.get("attribution_required")) and not str(row.get("attribution_owner") or "")
        }
    )
    if ownerless:
        findings.append(
            _blocking(
                "F1",
                f"{len(ownerless)} ingested row(s) require attribution and name no owner "
                f"(first: {ownerless[0]}). The credits surface S152 has nothing to render "
                f"for them, which is INV-PACK-17 failing at the source rather than at the "
                f"screen.",
                lang,
                count=len(ownerless),
                first=ownerless[0],
            )
        )

    ctx.entry.note(
        licence_rows=len(rows),
        corpora_configured=list(INGEST_CORPORA_BY_LANGUAGE.get(lang, ())),
        corpora_opened=opened,
        corpora_recorded=sorted(by_source),
        corpora_configured_but_unread=unread,
        sentences_checked=len(sentences),
        sources_without_a_permit=unrecorded,
        oracle_only_text_shipped=len(oracle_shipped),
        attribution_required_without_owner=len(ownerless),
    )
    return findings


# ---------------------------------------------------------------------------
# F3 — INV-PACK-17, credits reachability
# ---------------------------------------------------------------------------


def _pack_inputs(lang: str):  # noqa: ANN202 — PackInputs, imported lazily to avoid a cycle
    from ..packbuild.sqlite import PackInputs

    def collect(kind: str) -> tuple[Mapping[str, Any], ...]:
        try:
            return tuple(read_records(kind, lang=lang))
        except FileNotFoundError:
            return ()

    return PackInputs(
        lang=lang,
        pack_id=f"freelingo-{lang}",
        course_id=f"en-{lang}",
        major=0,
        version="0.0.0",
        sentences=collect("ingested_sentence"),
        lemmas=collect("banded_lemma"),
        units=collect("unit_assignment"),
        selected=collect("selected_item"),
        candidates=collect("candidate"),
        exercises=collect("exercise"),
        clips=collect("baked_clip"),
        licences=tuple(licences_seen(lang)),
    )


@register_validator("F3")
def attribution_reachable(ctx: ValidatorContext) -> list[Finding]:
    """Every attribution-requiring asset has a credit row the S152 surface renders.

    G9 runs `attribution_violations` as gate 1 and refuses to write a pack when it is
    non-empty, so on a clean build this validator agrees with the stage. That is not a
    duplicate: G9's gate protects the *build*, and a pack also arrives from a GitHub
    release, from a device cache, and from a build whose gate somebody edited. INV-PACK-17
    is a property of the artefact, so something has to ask it of the artefact.

    Two ways this could pass without earning it, both refused here:

    * **Nothing to check.** No sentences, no clips, no violations, green. So the inputs
      are counted first and an empty ledger is a blocking finding.
    * **Nothing requires attribution.** A run whose every row is CC0 makes the credits
      table trivially complete. Measured in `deps-scaffold`'s fixture work: the real
      Tatoeba CC0 subset for Spanish is 2,266 bytes, so attribution is the shipping path
      and a pack with zero attributed sources is far more likely to have lost the flag
      than to have earned it. That case is reported as a **warning** naming the count,
      not silently passed.
    """
    from ..packbuild.attribution import (
        attribution_violations,
        credit_rows,
        derived_list_sources,
    )

    lang = ctx.lang
    inputs = _pack_inputs(lang)

    if not inputs.sentences:
        return [
            _blocking(
                "F3",
                f"no ingested_sentence records for {lang}: there is no pack to check the "
                f"credits of, and 'no violations over nothing' is not a pass.",
                lang,
            )
        ]

    findings = [
        _blocking("F3", violation, lang) for violation in attribution_violations(inputs)
    ]

    credits = credit_rows(inputs)
    derived = derived_list_sources(inputs)
    attributed = sum(1 for row in inputs.sentences if bool(row.get("attribution_required")))

    if attributed == 0:
        findings.append(
            Finding(
                validator_id="F3",
                severity="warning",
                message=(
                    f"no sentence in the {lang} ledger requires attribution, so the "
                    f"credits check is trivially satisfied. That is possible and it is "
                    f"unlikely: the CC0 route is fr-only (spa 2,266 B, deu 1,852 B, "
                    f"jpn 228 B), so a pack with no attributed source has probably lost "
                    f"the flag rather than earned the exemption."
                ),
                subject=lang,
            )
        )
    elif not credits:
        findings.append(
            _blocking(
                "F3",
                f"{attributed} sentence(s) require attribution and the credits surface "
                f"renders no rows at all. S152 would show an empty screen while the pack "
                f"ships text somebody must be credited for.",
                lang,
                attributed=attributed,
            )
        )

    credited = {str(row["source_id"]) for row in credits}
    for source_id, _row in derived:
        if source_id not in credited:
            findings.append(
                _blocking(
                    "F3",
                    f"the derived list from {source_id!r} ships in the pack and no credits "
                    f"row renders it. A frequency ordering derived from a CC BY-SA list is "
                    f"share-alike data, not an implementation detail.",
                    source_id,
                )
            )

    ctx.entry.note(
        sentences=len(inputs.sentences),
        clips=len(inputs.clips),
        attribution_required=attributed,
        credit_rows=len(credits),
        derived_list_sources=[source_id for source_id, _ in derived],
    )
    return findings


# ---------------------------------------------------------------------------
# F4 — INV-PACK-18, the manifest signature
# ---------------------------------------------------------------------------


def _manifest_path(lang: str) -> Path:
    return stage_dir(lang, PACK_STAGE_ID) / MANIFEST_FILENAME


@register_validator("F4")
def manifest_signature_verifies(ctx: ValidatorContext) -> list[Finding]:
    """A signed manifest verifies against the COMMITTED public key, or it is refused.

    Three outcomes, and the middle one is why this is not a boolean:

    * **signed and valid** — no findings.
    * **unsigned** — a `warning`, never blocking. `PACK_SIGNING_KEY` is a repository
      secret and GitHub does not expose it to a pull request from a fork, so
      `pack-ci.yml` builds unsigned there on purpose. The plan's six-value pack state
      calls that `unverified`, never `corrupt`, and a device refuses to install it; a
      blocking finding here would make every fork's CI red for a reason that is not a
      defect in the pack.
    * **signed and invalid** — blocking. That includes a manifest signed by a key that is
      not the one shipping inside the app, which `verify_manifest` checks first: a
      manifest carrying its own public key and verifying against it proves somebody owned
      *a* key, which is exactly what an attacker who re-signed a modified pack has.

    The outcome is written to the runlog either way, so "F4: 0 findings" can be told apart
    from "F4 had no key and said so" — the same distinction INV-PACK-14 forces on V8.
    """
    lang = ctx.lang
    path = _manifest_path(lang)
    if not path.exists():
        return [
            _blocking(
                "F4",
                f"no manifest at {path}: G9 is what writes it, and a signature check with "
                f"no manifest to check is not a pass.",
                lang,
            )
        ]

    try:
        manifest = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        return [_blocking("F4", f"the manifest at {path} is not valid JSON: {exc}", lang)]

    if "signature" not in manifest:
        ctx.entry.note(signature="absent", signature_state="unverified", manifest=str(path))
        return [
            Finding(
                validator_id="F4",
                severity="warning",
                message=(
                    f"the {lang} manifest carries no signature block. A device reports "
                    f"this pack as `unverified` and refuses to install it (INV-PACK-18). "
                    f"This is a warning rather than a failure because PACK_SIGNING_KEY is "
                    f"not exposed to a pull request from a fork, so an unsigned build is "
                    f"an expected CI state — but it is never a shippable one."
                ),
                subject=lang,
            )
        ]

    try:
        verify_manifest(manifest, trusted_spki=trusted_public_key_spki())
    except SignatureInvalid as exc:
        ctx.entry.note(signature="present", signature_state="invalid", reason=str(exc))
        return [
            _blocking(
                "F4",
                f"the {lang} manifest is signed and the signature does not verify against "
                f"the committed public key: {exc}",
                lang,
            )
        ]
    except FileNotFoundError as exc:
        ctx.entry.note(signature="present", signature_state="no-trusted-key")
        return [
            _blocking(
                "F4",
                f"the committed public key is missing, so a signature cannot be checked "
                f"against anything: {exc}. The app ships this key; without it in the "
                f"repository, every pack is unverifiable.",
                lang,
            )
        ]

    ctx.entry.note(signature="present", signature_state="verified", manifest=str(path))
    return []


# ---------------------------------------------------------------------------
# F5 — INV-PACK-16, the characters stage
# ---------------------------------------------------------------------------


@register_validator("F5")
def characters_cover_every_taught_glyph(ctx: ValidatorContext) -> list[Finding]:
    """Japanese only: every glyph an exercise teaches is in the character syllabus.

    INV-PACK-16 is about kana and kanji. The characters stage G3b, `content/ja/
    characters.yaml`, KanjiVG stroke order and JmdictFurigana are all P7 work, and none of
    it exists yet. That leaves two honest things to say and this validator says both:

    * for a language with no character syllabus — `es`, `fr`, `de` — the invariant has no
      subject. Reported as `info` with the reason, so the report distinguishes it from a
      validator that ran and found nothing, and from one that was skipped.
    * for `ja` — **blocking**, until the stage lands. A `ja` pack built today would teach
      kanji with no syllabus behind them, and the validator whose whole job is to notice
      that must not be the thing that passes it. P7 replaces this branch with the real
      cover check; the test beside it asserts the refusal so the replacement cannot be
      quietly skipped instead.
    """
    lang = ctx.lang
    if lang not in _CHARACTER_LANGUAGES:
        ctx.entry.note(
            applicable=False,
            reason=(
                f"{lang} declares no character syllabus; INV-PACK-16 is a property of the "
                f"Japanese kana/kanji curriculum"
            ),
            character_languages=list(_CHARACTER_LANGUAGES),
        )
        return [
            Finding(
                validator_id="F5",
                severity="info",
                message=(
                    f"not applicable to {lang}: INV-PACK-16 covers the ja character "
                    f"syllabus, and only {', '.join(_CHARACTER_LANGUAGES)} declares one. "
                    f"Recorded rather than silently skipped, so the report says which of "
                    f"'clean', 'nothing to check' and 'never ran' this is."
                ),
                subject=lang,
            )
        ]

    ctx.entry.note(applicable=True, characters_stage="absent", phase="P7")
    return [
        _blocking(
            "F5",
            f"{lang} teaches kana and kanji and there is no characters stage to cover "
            f"them: content/{lang}/characters.yaml, the KanjiVG stroke order and the "
            f"JmdictFurigana readings all land at P7. Until then a ja pack cannot satisfy "
            f"INV-PACK-16, and a validator that reported otherwise would be the only "
            f"thing standing between an uncovered glyph and a learner.",
            lang,
        )
    ]


assert set(LANGUAGES) >= set(_CHARACTER_LANGUAGES), (
    "_CHARACTER_LANGUAGES names a language the pipeline does not build"
)
