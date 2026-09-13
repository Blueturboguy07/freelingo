"""The frozen artefact contract, the provenance log, input resolution, and the fixture.

The three things worth failing over, in order:

1. `test_the_contract_digest_is_frozen` — a schema edit in wave 1 that nobody notices
   until wave 2 cannot parse its input.
2. `test_every_record_is_closed` — an `additionalProperties: true` schema is not a
   contract, it is a suggestion, and the next lane will depend on the extra field.
3. `test_the_fixture_derivations_recompute` — a fixture whose derived files were
   edited by hand is worse than no fixture, because eight lanes build on it.
"""

from __future__ import annotations

import base64
import json
import re
from collections import Counter
from collections.abc import Iterator
from pathlib import Path

import pytest
from conftest import ES_MINI, tokens

from coursekit.artifacts import (
    ARTIFACTS,
    ArtifactError,
    UnknownArtifact,
    artifact_path,
    contract_digest,
    dedup_hash,
    read_records,
    run_dir,
    sentence_id,
    stage_dir,
    validate_record,
    write_records,
)
from coursekit.config import (
    ARTIFACT_SCHEMA_VERSION,
    BUILD_STAGE_IDS,
    DATA_SOURCE_KINDS,
    INGEST_LICENCE_ALLOW_LIST,
    SOURCES,
)
from coursekit.inputs import (
    ForbiddenSource,
    MissingDependencyGroup,
    MissingInput,
    group_is_installed,
    licence_row,
    opus_pair,
    require_group,
    resolve,
    sources_for,
)
from coursekit.runlog import (
    LicenceRow,
    RunLog,
    RunLogError,
    UpstreamStageMissing,
    read_entries,
    require_successful,
)

# ---------------------------------------------------------------------------
# The contract
# ---------------------------------------------------------------------------

#: Frozen 2026-09-12 by `p2-deps-scaffold`, the phase's only dependency/contract lane.
#:
#: Changing a schema changes this. That is the mechanism, not an inconvenience: P2's
#: eight lanes agree on these shapes before most of them exist, so an edit has to be a
#: deliberate act with a failing test attached and a note to the other lanes, rather
#: than a diff in a 300-line file that nobody reviews.
#:
#: Re-pinned 2026-09-12 by `p2r3/deps-contract` (round 3's deps lane), once, for one
#: change: `candidate` gained a required, nullable `analysis` — B16's option 2, carrying
#: G1's analysis across the G5 -> G7 boundary so G7 stops resolving a distractor by
#: SURFACE. Previous value
#: `3e2f6a6849cdb5a8815a5bc18f13d751742438ee6596d5267da3031bf703d0f2`.
FROZEN_CONTRACT_DIGEST = "e7248ff99085195ca2781e272376bc906e1aa239630281d831f5d5cd2ebfab77"


def test_the_contract_digest_is_frozen() -> None:
    assert contract_digest() == FROZEN_CONTRACT_DIGEST, (
        "an inter-stage artefact schema changed. That is allowed, and it is not a "
        "quiet change: update FROZEN_CONTRACT_DIGEST in the same commit, and say so "
        "in docs/pipeline.md, because every other P2 lane reads these shapes."
    )


def test_every_g_stage_that_emits_a_record_is_covered() -> None:
    """Nine records over ten stages. G6 emits none, deliberately."""
    emitting = {art.stage for art in ARTIFACTS.values()}
    assert emitting == set(BUILD_STAGE_IDS) - {"g6"}
    assert len(ARTIFACTS) == 9


def test_every_record_is_closed() -> None:
    for kind, art in ARTIFACTS.items():
        assert art.schema["additionalProperties"] is False, kind
        assert sorted(art.schema["properties"]) == art.schema["required"], kind


def test_every_record_carries_the_schema_version() -> None:
    for kind, art in ARTIFACTS.items():
        assert art.schema["properties"]["schema_version"] == {"const": ARTIFACT_SCHEMA_VERSION}, (
            kind
        )


def _closed_objects(schema: object, path: str = "<root>") -> Iterator[tuple[str, dict]]:
    """Every object subschema that declares properties, anywhere in the contract."""
    if isinstance(schema, dict):
        if "properties" in schema:
            yield path, schema
        for key, value in schema.items():
            if key in {"title", "description", "$schema", "const", "enum"}:
                continue
            yield from _closed_objects(value, f"{path}/{key}")
    elif isinstance(schema, list):
        for index, value in enumerate(schema):
            yield from _closed_objects(value, f"{path}/{index}")


def test_every_object_in_the_contract_is_closed_all_the_way_down() -> None:
    """`test_every_record_is_closed` only reads the nine TOP-level records.

    Every record shape that matters now lives one or more levels down —
    `analysed_sentence.adapter`, `exercise.item_tags`, and as of B16
    `candidate.analysis` and its `tokens[]`. An open sub-object is the same hole as an
    open record: the next lane depends on a field the schema never promised. So the
    closedness property is asserted over the whole tree, and the walk is counted so it
    cannot pass by walking nothing.
    """
    walked = {}
    for kind, art in ARTIFACTS.items():
        for path, schema in _closed_objects(art.schema, kind):
            assert schema.get("additionalProperties") is False, f"{path} is open"
            assert sorted(schema["properties"]) == schema["required"], path
            walked[path] = schema.get("title")

    titles = set(walked.values())
    assert {"Token", "Adapter", "CandidateAnalysis", "ItemTags"} <= titles, titles
    # Nine records + every nested object. Fewer means the walk stopped early.
    assert len(walked) >= 14, sorted(walked)


def test_the_open_payload_is_the_only_object_the_contract_leaves_open() -> None:
    """`pack_row.payload` is `{"type": "object"}` on purpose — `packages/schema` owns
    the column shapes — and it is the ONE exemption, stated here so a second one cannot
    appear as "the existing pattern"."""
    open_objects = [
        f"{kind}/{name}"
        for kind, art in ARTIFACTS.items()
        for name, prop in art.schema["properties"].items()
        if isinstance(prop, dict) and prop.get("type") == "object" and "properties" not in prop
    ]
    assert open_objects == ["pack_row/payload"]


def test_an_unknown_record_kind_is_never_a_pass_through() -> None:
    with pytest.raises(UnknownArtifact):
        validate_record("not_a_record", {})
    with pytest.raises(UnknownArtifact):
        artifact_path("es", "not_a_record")


# ---------------------------------------------------------------------------
# Round trip
# ---------------------------------------------------------------------------


def _sentence(text: str = "La casa es blanca.") -> dict[str, object]:
    return {
        "schema_version": ARTIFACT_SCHEMA_VERSION,
        "sentence_id": sentence_id("es", text),
        "lang": "es",
        "l1": "en",
        "text": text,
        "translation": "The house is white.",
        "source_id": "freelingo-fixture",
        "corpus": "freelingo-es-mini",
        "corpus_version": "2026-09-12",
        "licence": "CC0-1.0",
        "licence_verdict": "shippable",
        "attribution_required": False,
        "attribution_owner": None,
        "token_count": 4,
        "dedup_hash": dedup_hash(text),
    }


def test_records_round_trip_through_the_run_directory() -> None:
    written = write_records("ingested_sentence", [_sentence()], lang="es")
    assert written == 1
    path = artifact_path("es", "ingested_sentence")
    assert path == stage_dir("es", "g0") / "ingested.jsonl"
    assert path.parent.parent == run_dir("es")
    assert list(read_records("ingested_sentence", lang="es")) == [_sentence()]


def test_an_extra_field_is_refused_on_write() -> None:
    bad = _sentence() | {"confidence": 0.9}
    with pytest.raises(ArtifactError, match="confidence"):
        write_records("ingested_sentence", [bad], lang="es")


def test_an_extra_field_is_refused_on_read(tmp_path: Path) -> None:
    """Reading is where a hand-edited file shows up, and writing cannot catch it.

    Validating only on write trusts that every writer went through this module, which
    is exactly the assumption that fails the first time somebody edits a `.jsonl` to
    debug something and forgets to undo it.
    """
    path = tmp_path / "ingested.jsonl"
    path.write_text(
        json.dumps(_sentence() | {"confidence": 0.9}, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    with pytest.raises(ArtifactError, match="confidence"):
        list(read_records("ingested_sentence", path=path))


def test_a_bad_batch_leaves_no_half_written_file() -> None:
    """Validation runs before the file is opened; the next stage never sees a stump."""
    with pytest.raises(ArtifactError):
        write_records("ingested_sentence", [_sentence(), {"schema_version": 1}], lang="es")
    assert not artifact_path("es", "ingested_sentence").exists()


def test_reading_a_stage_that_never_ran_names_the_stage() -> None:
    with pytest.raises(FileNotFoundError, match="g4"):
        list(read_records("selected_item", lang="es"))


def test_sentence_ids_are_content_addressed_and_language_scoped() -> None:
    assert sentence_id("es", "Hola") == sentence_id("es", "Hola")
    assert sentence_id("es", "Hola") != sentence_id("fr", "Hola")
    assert re.fullmatch(r"[0-9a-f]{16}", sentence_id("es", "Hola"))


def test_the_run_directory_is_under_the_ignored_build_root() -> None:
    """`build/` is in `.gitignore`; a run directory is output and is never committed."""
    assert run_dir("es").name == "es"
    assert run_dir("es").parent.name == "build"


# ---------------------------------------------------------------------------
# `candidate.analysis` — B16, the G5 -> G7 boundary
# ---------------------------------------------------------------------------
#
# G7 resolved a gap by the SURFACE at the gap index. On a corpus sentence that works by
# accident (a lowercase mid-sentence surface often equals its lemma); on an authored
# sentence there was no analysis at all, so POS was empty, the band was `unbanded`, and
# the stage stopped with `NotEnoughDistractors: … needed 3 distractors for 'tardes'
# (POS , band unbanded) and the rule core found 0` — `tardes` is a surface, `tarde` is
# the lemma, and over 490 authored items most gaps land on an inflected form.
#
# Founder ruling 2026-09-12, B16: option 2 — carry G1's analysis across the boundary,
# which changes the frozen contract, which is this lane's to change. Two wave-2 lanes
# code against these tests in parallel: gapfill WRITES the field from the analyser G5
# already runs (`stages/g5_gapfill.py` `_lemmas`), expand READS it and must fail by name
# when it is null for a row it is asked to expand.


def _analysis() -> dict[str, object]:
    return {
        "analyser": {
            "name": "spacy-es",
            "version": "3.8.0",
            "model": "es_core_news_md",
            "split_mode": None,
        },
        "tokens": [
            {
                "surface": "Buenas",
                "lemma": "bueno",
                "pos": "ADJ",
                "morph": "Gender=Fem|Number=Plur",
                "start": 0,
                "end": 6,
            },
            {
                "surface": "tardes",
                "lemma": "tarde",
                "pos": "NOUN",
                "morph": "Gender=Fem|Number=Plur",
                "start": 7,
                "end": 13,
            },
        ],
        "lemmas": ["bueno", "tarde"],
        "display_tokens": ["Buenas", "tardes"],
    }


def _candidate(**overrides: object) -> dict[str, object]:
    record = {
        "schema_version": ARTIFACT_SCHEMA_VERSION,
        "lang": "es",
        "candidate_id": sentence_id("es", "Buenas tardes"),
        "unit_index": 1,
        "lesson_index": 1,
        "slot_index": 0,
        "text": "Buenas tardes",
        "translation": "Good afternoon",
        "accepted_alternates": ["Muy buenas tardes"],
        "author": "agent:opus",
        "generated_at": "2026-09-12T00:00:00Z",
        "accepted": True,
        "reject_reason": None,
        "provenance": "llm",
        "analysis": _analysis(),
    }
    record.update(overrides)
    return record


def test_a_candidate_carries_its_analysis_across_the_boundary() -> None:
    """The whole point: what G5 writes is what G7 reads, lemma-for-lemma."""
    assert write_records("candidate", [_candidate()], lang="es") == 1
    (row,) = list(read_records("candidate", lang="es"))
    assert row["analysis"]["lemmas"] == ["bueno", "tarde"]
    # The lemma at the gap index, not the surface. This is the bug, in one assertion.
    assert row["analysis"]["tokens"][1]["lemma"] == "tarde"
    assert row["analysis"]["tokens"][1]["surface"] == "tardes"
    assert row["accepted_alternates"] == ["Muy buenas tardes"]


def test_INV_PACK_08_accepted_alternates_are_a_closed_unique_nonempty_set() -> None:
    """[INV-PACK-08] Every authored accepted answer has an explicit contract slot."""
    validate_record("candidate", _candidate(accepted_alternates=["Vivo en Madrid."]))
    with pytest.raises(ArtifactError):
        validate_record("candidate", _candidate(accepted_alternates=[""]))
    with pytest.raises(ArtifactError):
        validate_record(
            "candidate", _candidate(accepted_alternates=["Vivo en Madrid."] * 2)
        )


def test_the_analysis_is_the_g1_shape_and_cannot_drift_from_it() -> None:
    """Not "the same fields", the same OBJECT.

    A copy of G1's `Token` beside G1's `Token` is two shapes that agree today; the
    expand lane reads one function over both a corpus row and an authored row, so a
    field added to one and not the other is a crash in the lane that did nothing wrong.
    """
    analysed = ARTIFACTS["analysed_sentence"].schema["properties"]
    analysis = ARTIFACTS["candidate"].schema["properties"]["analysis"]
    shape = analysis["oneOf"][0]["properties"]

    assert shape["tokens"] == analysed["tokens"]
    assert shape["analyser"] == analysed["adapter"]
    assert shape["lemmas"] == analysed["lemmas"]
    assert shape["display_tokens"] == analysed["display_tokens"]
    assert sorted(shape) == ["analyser", "display_tokens", "lemmas", "tokens"]


def test_the_analysis_object_is_closed() -> None:
    """Stated directly as well as through the recursive walk, because this is the object
    two lanes are writing against this week."""
    branch = ARTIFACTS["candidate"].schema["properties"]["analysis"]["oneOf"][0]
    assert branch["additionalProperties"] is False
    assert branch["required"] == sorted(branch["properties"])
    token = branch["properties"]["tokens"]["items"]
    assert token["additionalProperties"] is False
    assert token["required"] == ["end", "lemma", "morph", "pos", "start", "surface"]


def test_an_unknown_key_inside_the_analysis_is_refused_on_write() -> None:
    bad = _candidate(analysis=_analysis() | {"confidence": 0.9})
    with pytest.raises(ArtifactError, match="confidence"):
        write_records("candidate", [bad], lang="es")


def test_an_unknown_key_inside_the_analysis_is_refused_on_read(tmp_path: Path) -> None:
    """Closedness one level down has to hold on the way OUT too.

    The field exists to be read by another stage, and a nested extra key is the easiest
    thing in the contract to smuggle: `additionalProperties: false` on the record says
    nothing about the inside of `analysis`, so this asserts the inside, through
    `read_records`, from a file this module never wrote.
    """
    path = tmp_path / "candidates.jsonl"
    for record in (
        _candidate(analysis=_analysis() | {"confidence": 0.9}),
        _candidate(
            analysis=_analysis() | {"tokens": [_analysis()["tokens"][0] | {"ner": "O"}]},  # type: ignore[index]
        ),
    ):
        path.write_text(json.dumps(record, ensure_ascii=False) + "\n", encoding="utf-8")
        with pytest.raises(ArtifactError):
            list(read_records("candidate", path=path))


def test_a_token_missing_its_offsets_is_refused_and_the_message_names_the_token() -> None:
    """`start`/`end` are why the field is `tokens` and not just `lemmas`: the gap span
    is computed from them.

    The message matters as much as the refusal. A nullable sub-object is a `oneOf`, and
    the plain jsonschema report for one is "analysis: {the whole object, inlined} is not
    valid under any of the given schemas" — no field named, one token bundle per word
    printed, for a stage streaming hundreds of rows. `validate_record` picks the
    best-matching branch instead, so the path is `analysis/tokens/0`.
    """
    token = dict(_analysis()["tokens"][0])  # type: ignore[index]
    del token["start"]
    bad = _candidate(analysis=_analysis() | {"tokens": [token]})
    with pytest.raises(ArtifactError) as raised:
        write_records("candidate", [bad], lang="es")
    assert "analysis/tokens/0: 'start' is a required property" in str(raised.value)
    assert "is not valid under any of the given schemas" not in str(raised.value)


def test_a_null_analysis_stays_legal() -> None:
    """A row can exist with no analysis and it is not a schema violation.

    A candidate rejected on `stale_ledger` is rejected before the analyser is reached,
    and the reject rate is the number that tells you the ledger window is too tight —
    so those rows are written, with nothing to carry. "Non-null exactly when G7 will
    read it" is not expressible as a schema keyword, which is why the expand lane
    enforces it in code and fails by name instead.
    """
    assert write_records("candidate", [_candidate(analysis=None)], lang="es") == 1
    (row,) = list(read_records("candidate", lang="es"))
    assert row["analysis"] is None


def test_the_analysis_key_is_required_even_when_it_is_null() -> None:
    """Nullable is not optional. An omitted key would let a writer that predates this
    change keep writing rows the expand lane cannot tell from "analysed, no tokens"."""
    partial = _candidate()
    del partial["analysis"]
    with pytest.raises(ArtifactError, match="analysis"):
        write_records("candidate", [partial], lang="es")
    assert "analysis" in ARTIFACTS["candidate"].schema["required"]


def test_the_analysis_must_be_an_object_or_null_and_nothing_else() -> None:
    for value in ("", "bueno tarde", [], 0, False):
        with pytest.raises(ArtifactError, match="analysis"):
            write_records("candidate", [_candidate(analysis=value)], lang="es")


# ---------------------------------------------------------------------------
# The provenance log
# ---------------------------------------------------------------------------


def test_a_stage_writes_its_entry_and_downstream_can_require_it() -> None:
    runlog = RunLog("es")
    with runlog.stage("g0", tool="coursekit", tool_version="0.1.0") as entry:
        entry.record_input("tatoeba")
        entry.record_output("ingested_sentence")
        entry.record_licence(
            LicenceRow("tatoeba", "CC-BY-2.0-FR", "shippable", True, "Tatoeba contributors")
        )
        entry.read = 200
        entry.written = 200
        entry.note(dedup_dropped=0)

    entries = read_entries("es")
    assert [entry["stage"] for entry in entries] == ["g0"]
    assert entries[0]["status"] == "ok"
    assert entries[0]["licences"][0]["attribution_owner"] == "Tatoeba contributors"
    assert require_successful("es", ["g0"])["g0"]["counts"]["written"] == 200


def test_a_missing_upstream_raises_rather_than_defaulting() -> None:
    """G7 over an empty ledger produces a pack that passes every row-level validator
    and is missing half its content. Raise at the first line instead."""
    RunLog("es")
    with pytest.raises(UpstreamStageMissing, match="g4"):
        require_successful("es", ["g4"])


def test_a_failed_stage_is_still_written() -> None:
    """A missing entry and a failed entry send a reader to different places."""
    runlog = RunLog("es")
    with (
        pytest.raises(RuntimeError, match="boom"),
        runlog.stage("g1", tool="coursekit", tool_version="0.1.0"),
    ):
        raise RuntimeError("boom")

    entries = read_entries("es")
    assert [(e["stage"], e["status"]) for e in entries] == [("g1", "failed")]
    with pytest.raises(UpstreamStageMissing):
        require_successful("es", ["g1"])


def test_no_runlog_is_an_empty_list_not_an_error() -> None:
    """ "Nobody has run anything for this language" is a state `doctor` reports."""
    assert read_entries("ja") == []


def test_an_entry_naming_an_unknown_artefact_is_refused() -> None:
    runlog = RunLog("es")
    with (
        pytest.raises(RunLogError, match="not an artefact record kind"),
        runlog.stage("g0", tool="coursekit", tool_version="0.1.0") as entry,
    ):
        entry.record_output("not_a_record")


def test_one_run_id_spans_the_stages_of_one_build() -> None:
    """A half-finished run has to be distinguishable from a mixture of two runs, which
    is exactly what re-running one stage over yesterday's output produces."""
    runlog = RunLog("es")
    for stage in ("g0", "g1"):
        with runlog.stage(stage, tool="coursekit", tool_version="0.1.0"):
            pass
    ids = {entry["run_id"] for entry in read_entries("es")}
    assert len(ids) == 1
    assert RunLog("es").run_id != runlog.run_id


# ---------------------------------------------------------------------------
# Input resolution — the ten corrected constants
# ---------------------------------------------------------------------------


def test_opus_pairs_are_alphabetical_which_is_the_common_build_script_bug() -> None:
    assert opus_pair("es") == "en-es"
    assert opus_pair("fr") == "en-fr"
    assert opus_pair("ja") == "en-ja"
    assert opus_pair("de") == "de-en"  # NOT en-de. The wrong spelling 404s.


def test_ted2020_is_forbidden_for_every_language() -> None:
    """CC BY-NC-ND: every exercise shape is a derivative, and an AGPL app can be forked
    commercially, so both clauses bite. Refused at ingest, not filtered at package."""
    for lang in ("es", "fr", "de", "ja"):
        with pytest.raises(ForbiddenSource, match="ted2020"):
            resolve("ted2020", lang)
    assert SOURCES["ted2020"].licence == "CC-BY-NC-ND-4.0"


def test_jparacrawl_is_forbidden_and_has_a_verdict_at_all() -> None:
    """R8: `deep/10` listed 25.7M ja pairs and gave the corpus no verdict anywhere,
    which is how a build script templated from that table picks it up. Its OPUS page
    says 'For commercial use, please contact NTT' — non-commercial by default, the same
    category that forced the TED2020 cut."""
    with pytest.raises(ForbiddenSource):
        resolve("jparacrawl", "ja")
    assert SOURCES["jparacrawl"].verdict == "forbidden"


def test_nllb_carries_odc_by_and_is_still_oracle_only() -> None:
    """R2: the NLLB legacy page states ODC-By 1.0, which the 'no licence at all'
    reading missed. ODC-By covers the database, not each crawled sentence's copyright,
    so the plan keeps it oracle-only pending the lawyer question (plan risk 2) and
    ships Tatoeba text."""
    nllb = resolve("nllb", "es")
    assert nllb.source.licence == "ODC-By-1.0"
    assert nllb.oracle_only
    assert not nllb.shippable


def test_oracle_only_corpora_are_not_shippable() -> None:
    for source_id in ("opensubtitles", "ccmatrix", "nllb"):
        assert not resolve(source_id, "es").shippable


def test_tatoeba_is_the_shippable_corpus_and_requires_attribution() -> None:
    tatoeba = resolve("tatoeba", "es")
    assert tatoeba.shippable
    assert tatoeba.source.attribution_required
    assert licence_row(tatoeba).attribution_owner == "Tatoeba contributors"


def test_the_cc0_route_is_french_only_and_the_filename_is_uppercase() -> None:
    """R3: the archive is `sentences_CC0.tar.bz2`; the lowercase spelling 404s.
    R4: the per-language CC0 exports are 228 B (jpn), 2,266 B (spa), 1,852 B (deu) —
    choosing CC0 to skip the credits screen eliminates three of the four languages."""
    assert resolve("tatoeba_cc0", "fr").url.endswith("fra_sentences_CC0.tsv.bz2")
    for lang in ("es", "de", "ja"):
        with pytest.raises(MissingInput, match="does not cover"):
            resolve("tatoeba_cc0", lang)


def test_hermitdave_has_no_japanese_and_that_is_a_hard_failure() -> None:
    """`ja_50k.txt` 404s and `ja/` holds only `ja_full.txt`, whose whitespace-split
    'words' are sentence fragments. A fallback to it makes V1 pass vacuously."""
    with pytest.raises(MissingInput, match="does not cover"):
        resolve("hermitdave", "ja")
    assert resolve("hermitdave", "es").url.endswith("es_50k.txt")
    assert resolve("ja_derived_frequency", "ja").url is None


def test_languagetool_japanese_has_grammar_rules_and_no_spellcheck() -> None:
    """R1: the spec read the live table's SPELL CHECK column as 'grammar checks', and
    the quoted 'spell checking only' sentence is about Norwegian. So the degradation
    V8 records for Japanese is `spellcheck_engine: none`, not `grammar_engine: none`."""
    note = SOURCES["languagetool"].note
    assert "735 XML GRAMMAR rules" in note
    assert "NO spell checker" in note
    assert "spellcheck_engine: none" in note
    assert resolve("languagetool", "ja").shippable


def test_piper_has_no_japanese_voice_and_kokoro_has_no_german() -> None:
    """R7: Piper's single ja voice is CC BY-NC-SA — the identical NC conflict that cut
    TED2020. Kokoro has no German. Between them the four languages are covered exactly
    once, and neither covers a language the other does."""
    with pytest.raises(MissingInput):
        resolve("piper", "ja")
    with pytest.raises(MissingInput):
        resolve("kokoro", "de")
    assert set(SOURCES["kokoro"].languages) | set(SOURCES["piper"].languages) == {
        "es",
        "fr",
        "de",
        "ja",
    }


def test_cefrlex_is_an_oracle_and_covers_only_es_and_fr() -> None:
    """NC, so it may be consulted on the build machine and never shipped under AGPL.
    German has no files at all and Japanese has no resource."""
    assert resolve("cefrlex", "es").oracle_only
    for lang in ("de", "ja"):
        with pytest.raises(MissingInput):
            resolve("cefrlex", lang)


def test_an_unregistered_source_is_refused_rather_than_assumed_shippable() -> None:
    with pytest.raises(MissingInput, match="no source registered"):
        resolve("some_corpus_someone_added", "es")


def test_every_shippable_data_source_licence_is_on_the_ingest_allow_list() -> None:
    """INV-PACK-13, checked against the table rather than at package time.

    Data kinds only. A build-time TOOL's own licence never travels with the pack, which
    is exactly why an LGPL KenLM and a GPL-3.0 Piper are usable at all; holding them to
    the shipped-content allow-list would either forbid the toolchain or force the
    allow-list open far enough to stop meaning anything.
    """
    checked = 0
    for source in SOURCES.values():
        if source.verdict == "shippable" and source.kind in DATA_SOURCE_KINDS:
            assert source.licence in INGEST_LICENCE_ALLOW_LIST, source.id
            checked += 1
    assert checked >= 4, "the allow-list assertion is not reaching any data source"


def test_a_voice_licence_rides_on_the_clip_not_on_the_engine() -> None:
    """R7's lesson, encoded. Piper is GPL-3.0 code whose one Japanese voice is
    CC BY-NC-SA, so no table-level claim about `piper` can stand in for the licence of
    a file it produced: every `baked_clip` carries its own."""
    assert "tts_voice" not in DATA_SOURCE_KINDS
    assert "licence" in ARTIFACTS["baked_clip"].schema["required"]


def test_every_attribution_requiring_source_names_an_owner() -> None:
    """INV-PACK-17 needs a string to render on S152; a required attribution with no
    owner is a credit that cannot be drawn."""
    for source in SOURCES.values():
        if source.attribution_required:
            assert source.attribution_owner, source.id


def test_sources_for_never_offers_a_forbidden_one() -> None:
    for lang in ("es", "fr", "de", "ja"):
        ids = {resolved.id for resolved in sources_for(lang)}
        assert "ted2020" not in ids
        assert "jparacrawl" not in ids


def test_a_missing_dependency_group_raises_with_the_install_command() -> None:
    """Never a degraded run: a fallback aligner produces word-bank hints that are wrong
    in a way V4 cannot catch, and a fallback voice ships audio that is not
    content-addressed."""
    for group in ("align", "tts"):
        if group_is_installed(group):
            continue
        with pytest.raises(MissingDependencyGroup, match=f"uv sync --group {group}"):
            require_group(group, needed_by="G7 expand")


def test_the_groups_ci_carries_are_importable_here() -> None:
    """`nlp` and `lm` are synced by CI, so a stage that needs them must work today."""
    assert group_is_installed("nlp")
    assert group_is_installed("lm")


# ---------------------------------------------------------------------------
# The es-mini fixture
# ---------------------------------------------------------------------------


def _fixture_sentences() -> list[dict]:
    return list(read_records("ingested_sentence", path=ES_MINI / "sentences.jsonl"))


def test_the_fixture_is_two_hundred_valid_ingested_sentences() -> None:
    records = _fixture_sentences()
    assert len(records) == 200
    assert len({record["sentence_id"] for record in records}) == 200
    assert len({record["text"] for record in records}) == 200


def test_every_fixture_row_carries_a_licence_and_an_owner_where_required() -> None:
    attributed = 0
    for record in _fixture_sentences():
        assert record["licence"] in INGEST_LICENCE_ALLOW_LIST
        assert record["licence_verdict"] == "shippable"
        if record["attribution_required"]:
            attributed += 1
            assert record["attribution_owner"] == "Freelingo contributors"
        else:
            assert record["attribution_owner"] is None
    # Both shapes exist on purpose: a uniformly CC0 fixture would let an INV-PACK-17
    # attribution bug pass every test in the suite.
    assert attributed == 40


def test_the_fixture_is_not_a_registered_source() -> None:
    """No build path can reach it, so a fixture sentence cannot end up in a pack."""
    assert _fixture_sentences()[0]["source_id"] not in SOURCES
    with pytest.raises(MissingInput):
        resolve("freelingo-fixture", "es")


def test_fixture_ids_recompute_from_the_text() -> None:
    for record in _fixture_sentences():
        assert record["sentence_id"] == sentence_id("es", record["text"])
        assert record["dedup_hash"] == dedup_hash(record["text"])
        assert record["token_count"] == len(tokens(record["text"]))


def test_the_frequency_list_recomputes_from_the_sentences() -> None:
    counts: Counter[str] = Counter()
    for record in _fixture_sentences():
        counts.update(tokens(record["text"]))
    expected = "".join(
        f"{word}\t{count}\n"
        for word, count in sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))
    )
    assert (ES_MINI / "frequency.tsv").read_text(encoding="utf-8") == expected


def test_the_band_table_recomputes_from_the_frequency_list_and_the_lemma_map() -> None:
    """The whole G2 derivation, in plain Python, with no model loaded."""
    surface_counts = {
        line.split("\t")[0]: int(line.split("\t")[1])
        for line in (ES_MINI / "frequency.tsv").read_text(encoding="utf-8").splitlines()
    }
    lemma_map = {
        parts[0]: (parts[1], parts[2])
        for parts in (
            line.split("\t")
            for line in (ES_MINI / "lemma-map.tsv").read_text(encoding="utf-8").splitlines()
        )
    }
    assert set(surface_counts) <= set(lemma_map)

    lemma_counts: Counter[tuple[str, str]] = Counter()
    for surface, count in surface_counts.items():
        lemma_counts[lemma_map[surface]] += count

    banded = list(read_records("banded_lemma", path=ES_MINI / "banded.jsonl"))
    assert len(banded) == len(lemma_counts)

    total = len(banded)
    for position, row in enumerate(banded):
        assert row["rank"] == position + 1
        assert row["frequency"] == lemma_counts[(row["lemma"], row["pos"])]
        assert row["decile"] == min(10, (position * 10) // total + 1)
        assert row["band"] == _band_for(row["decile"])
        # Nothing here came from CEFRLex, so nothing carries its NC licence.
        assert row["band_source"] == "frequency_decile"
        assert row["band_source_licence"] is None


def _band_for(decile: int) -> str:
    if decile <= 4:
        return "A1"
    if decile <= 7:
        return "A2"
    if decile <= 9:
        return "B1"
    return "B2"


def test_the_band_table_is_monotone_in_frequency() -> None:
    """V11's shape, asserted on the fixture so a lane building V11 has a green case."""
    banded = list(read_records("banded_lemma", path=ES_MINI / "banded.jsonl"))
    frequencies = [row["frequency"] for row in banded]
    assert frequencies == sorted(frequencies, reverse=True)


def test_the_fixture_manifest_matches_the_files() -> None:
    manifest = json.loads((ES_MINI / "manifest.json").read_text(encoding="utf-8"))
    records = _fixture_sentences()
    assert manifest["sentences"] == len(records)
    assert manifest["licences"]["CC0-1.0"] == sum(1 for r in records if r["licence"] == "CC0-1.0")
    assert manifest["licences"]["CC-BY-4.0"] == sum(
        1 for r in records if r["licence"] == "CC-BY-4.0"
    )
    assert manifest["lemmas"] == sum(
        1 for _ in (ES_MINI / "banded.jsonl").read_text(encoding="utf-8").splitlines()
    )


def test_fixture_sentences_are_a1_sized() -> None:
    """3-12 tokens is G0's A1 length window; a fixture outside it exercises nothing."""
    for record in _fixture_sentences():
        assert 3 <= record["token_count"] <= 12, record["text"]


@pytest.mark.skipif(not group_is_installed("nlp"), reason="the nlp group is not installed")
def test_the_lemma_map_is_what_the_pinned_lemmatiser_produces() -> None:
    """If somebody bumps the spaCy model, the fixture goes red here rather than quietly
    re-partitioning the ledger under every lane that builds on it — which is the exact
    V1 hazard the wheel-URL pin exists for, at fixture scale."""
    import spacy

    nlp = spacy.load("es_core_news_md", disable=["ner", "parser"])
    word = re.compile(r"[^\W\d_]+", re.UNICODE)

    expected: dict[str, tuple[str, str]] = {}
    for record in _fixture_sentences():
        for token in nlp(record["text"]):
            if not word.fullmatch(token.text):
                continue
            expected.setdefault(token.text.lower(), (token.lemma_.lower(), token.pos_))

    actual = {
        parts[0]: (parts[1], parts[2])
        for parts in (
            line.split("\t")
            for line in (ES_MINI / "lemma-map.tsv").read_text(encoding="utf-8").splitlines()
        )
    }
    assert actual == expected


# ---------------------------------------------------------------------------
# pynacl against the app's key contract
# ---------------------------------------------------------------------------

#: The 12-byte DER prefix of an ed25519 SubjectPublicKeyInfo, byte for byte the constant
#: in `packages/schema/src/signing.ts`. An ed25519 SPKI is exactly 44 bytes.
_ED25519_SPKI_PREFIX = bytes(
    [0x30, 0x2A, 0x30, 0x05, 0x06, 0x03, 0x2B, 0x65, 0x70, 0x03, 0x21, 0x00]
)
_ED25519_SPKI_LENGTH = 44


def test_pynacl_produces_the_spki_the_app_parses() -> None:
    """`coursekit sign` and the app have to agree on the key format before either
    exists. `packages/schema/src/signing.ts` parses a 44-byte ed25519 SPKI and refuses
    anything else — including an RSA or P-256 key, which is the substitution that would
    otherwise pass silently — so this is the Python half of that contract, asserted
    here rather than discovered at the first pack install."""
    from nacl.signing import SigningKey

    verify_key = bytes(SigningKey.generate().verify_key)
    assert len(verify_key) == 32
    spki = _ED25519_SPKI_PREFIX + verify_key
    assert len(spki) == _ED25519_SPKI_LENGTH


def test_the_committed_public_key_is_a_44_byte_ed25519_spki() -> None:
    repo = Path(__file__).resolve().parents[3]
    pem = (repo / "packages" / "schema" / "keys" / "pack-signing.pub").read_text()
    body = re.search(r"-----BEGIN PUBLIC KEY-----(.*?)-----END PUBLIC KEY-----", pem, re.S).group(1)
    spki = base64.b64decode(re.sub(r"\s+", "", body))
    assert len(spki) == _ED25519_SPKI_LENGTH
    assert spki[: len(_ED25519_SPKI_PREFIX)] == _ED25519_SPKI_PREFIX
