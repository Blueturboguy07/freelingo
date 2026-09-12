"""The frozen inter-stage artefact contract.

P2 runs as two waves and eight lanes. A lane in wave 2 cannot watch another lane's
stage run and discover what it emits, so the boundary between two stages has to be a
written contract before either side exists. This module is that contract: one
JSON-Schema'd record per G-stage boundary, one file per record kind, and a run
directory layout that says where each file lives.

Nine record kinds over ten stages. G6 is the one stage that emits none: it *validates*
G5 candidates in place and writes a runlog entry (`coursekit.runlog`), which is what a
downstream validator reads to know G6 ran and what it concluded.

    G0  ingest      -> ingested_sentence
    G1  analyze     -> analysed_sentence
    G2  band        -> banded_lemma
    G3  curriculum  -> unit_assignment
    G4  select      -> selected_item
    G5  gap-fill    -> candidate
    G6  validate    -> (no record; runlog only)
    G7  expand      -> exercise
    G8  bake        -> baked_clip
    G9  package     -> pack_row

Three properties make this a contract rather than a suggestion:

1. Every schema sets `additionalProperties: false`. A lane cannot smuggle a field past
   the boundary and have the next lane quietly depend on it.
2. Records are validated on WRITE and on READ. Validating only on write trusts that
   every writer went through this module, which is exactly the assumption that fails
   the first time somebody hand-edits a `.jsonl` to debug something.
3. `contract_digest()` hashes the whole schema set, and `tests/test_artifacts.py` pins
   it. Changing a schema is then a deliberate, reviewed act with a failing test
   attached, not a diff nobody reads.

Files are JSON Lines: append-friendly, diffable, and streamable, so a 250k-row ledger
never has to be held in memory to be validated.
"""

from __future__ import annotations

import hashlib
import json
import os
from collections.abc import Iterable, Iterator, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator
from jsonschema import ValidationError as _JsonSchemaValidationError

from .config import (
    ARTIFACT_SCHEMA_VERSION,
    ARTIFACT_SUFFIX,
    AUDIO_PIPELINES,
    BUILD_ROOT_DIRNAME,
    BUILD_ROOT_ENV_VAR,
    EXERCISE_TYPES,
    LANGUAGES,
    PACK_TABLES,
)

__all__ = [
    "ARTIFACTS",
    "Artifact",
    "ArtifactError",
    "UnknownArtifact",
    "artifact_path",
    "build_root",
    "contract_digest",
    "dedup_hash",
    "read_records",
    "run_dir",
    "sentence_id",
    "stage_dir",
    "validate_record",
    "write_records",
]


class ArtifactError(ValueError):
    """A record does not match its schema, on the way in or on the way out."""


class UnknownArtifact(KeyError):
    """A record kind nobody declared. Never a silent pass-through."""


# ---------------------------------------------------------------------------
# Shared schema fragments
# ---------------------------------------------------------------------------

_LANG = {"type": "string", "enum": list(LANGUAGES)}
_SCHEMA_VERSION = {"const": ARTIFACT_SCHEMA_VERSION}
_ID16 = {"type": "string", "pattern": "^[0-9a-f]{16}$"}
_HASH32 = {"type": "string", "pattern": "^[0-9a-f]{32}$"}
_NONEMPTY = {"type": "string", "minLength": 1}
_VERDICT = {"type": "string", "enum": ["shippable", "oracle_only", "forbidden"]}


def _object(properties: Mapping[str, Any], title: str, description: str) -> dict[str, Any]:
    """A closed object schema. Every declared property is required."""
    return {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "title": title,
        "description": description,
        "type": "object",
        "additionalProperties": False,
        "required": sorted(properties),
        "properties": dict(properties),
    }


# ---------------------------------------------------------------------------
# The nine records
# ---------------------------------------------------------------------------

INGESTED_SENTENCE = _object(
    {
        "schema_version": _SCHEMA_VERSION,
        "sentence_id": _ID16,
        "lang": _LANG,
        "l1": {"const": "en"},
        "text": _NONEMPTY,
        "translation": _NONEMPTY,
        "source_id": _NONEMPTY,
        "corpus": _NONEMPTY,
        "corpus_version": _NONEMPTY,
        "licence": _NONEMPTY,
        "licence_verdict": _VERDICT,
        "attribution_required": {"type": "boolean"},
        "attribution_owner": {"type": ["string", "null"], "minLength": 1},
        "token_count": {"type": "integer", "minimum": 1},
        "dedup_hash": _HASH32,
    },
    "IngestedSentence",
    (
        "G0. One candidate pair, already deduplicated, length-filtered and "
        "script-normalised, carrying the licence row V10/INV-PACK-13 checks. "
        "`licence_verdict` is resolved AT INGEST, not at package time: filtering later "
        "leaves forbidden text in every intermediate artefact. `attribution_owner` is "
        "what INV-PACK-17 needs to reach a rendered credits surface, and it may only be "
        "null when `attribution_required` is false."
    ),
)

ANALYSED_SENTENCE = _object(
    {
        "schema_version": _SCHEMA_VERSION,
        "sentence_id": _ID16,
        "lang": _LANG,
        "adapter": _object(
            {
                "name": _NONEMPTY,
                "version": _NONEMPTY,
                "model": {"type": ["string", "null"], "minLength": 1},
                "split_mode": {"type": ["string", "null"], "enum": ["A", "B", "C", None]},
            },
            "Adapter",
            (
                "Which analyser produced this, pinned. A lemmatiser change "
                "re-partitions the ledger and can retro-introduce a lemma before its "
                "unit, so the version rides on every row rather than on the run."
            ),
        ),
        "tokens": {
            "type": "array",
            "minItems": 1,
            "items": _object(
                {
                    "surface": _NONEMPTY,
                    "lemma": _NONEMPTY,
                    "pos": _NONEMPTY,
                    "morph": {"type": "string"},
                    "start": {"type": "integer", "minimum": 0},
                    "end": {"type": "integer", "minimum": 1},
                },
                "Token",
                "One morpheme-or-word with its UD POS tag and morph feature bundle.",
            ),
        },
        "lemmas": {"type": "array", "minItems": 1, "items": _NONEMPTY},
        "display_tokens": {"type": "array", "minItems": 1, "items": _NONEMPTY},
    },
    "AnalysedSentence",
    (
        "G1. `lemmas` is the ledger key set and is the ONLY thing V1 and V2 may read — "
        "surface tokens break inflected and agglutinative languages silently. For "
        "Japanese `lemmas` comes from SudachiPy Mode A so a compound cannot smuggle "
        "unseen morphemes past V1, while `display_tokens` carries Mode C, which is what "
        "the learner sees and what the audio unit is."
    ),
)

BANDED_LEMMA = _object(
    {
        "schema_version": _SCHEMA_VERSION,
        "lang": _LANG,
        "lemma": _NONEMPTY,
        "pos": _NONEMPTY,
        "rank": {"type": "integer", "minimum": 1},
        "frequency": {"type": "integer", "minimum": 0},
        "decile": {"type": "integer", "minimum": 1, "maximum": 10},
        "band": {"type": "string", "enum": ["A1", "A2", "B1", "B2", "C1", "C2", "unbanded"]},
        "band_source": {"type": "string", "enum": ["cefrlex", "frequency_decile"]},
        "band_source_licence": {"type": ["string", "null"], "minLength": 1},
    },
    "BandedLemma",
    (
        "G2. `band_source` records which of the two produced this row, because they "
        "have different licences and different standing: CEFRLex is CC BY-NC-SA and may "
        "only be consulted on the build machine, and the review (R23) found the "
        "shipped SECTION label is a G3 curriculum output, not a per-lemma lookup. A row "
        "banded by decile carries a null `band_source_licence`; a row banded by CEFRLex "
        "does not, and G9 asserts that."
    ),
)

UNIT_ASSIGNMENT = _object(
    {
        "schema_version": _SCHEMA_VERSION,
        "lang": _LANG,
        "section_index": {"type": "integer", "minimum": 1, "maximum": 8},
        "section_cefr": {"type": "string", "enum": ["Intro", "A1", "A2", "B1", "B2"]},
        "unit_index": {"type": "integer", "minimum": 1},
        "unit_title": _NONEMPTY,
        "function": _NONEMPTY,
        "grammar_concept": _NONEMPTY,
        "register_slot": {
            "type": "string",
            "enum": ["n/a", "binary_t_v", "graded_honorific"],
        },
        "target_lemmas": {"type": "array", "minItems": 1, "items": _NONEMPTY},
        "recycled_lemmas": {"type": "array", "items": _NONEMPTY},
        "level_count": {"type": "integer", "minimum": 1},
    },
    "UnitAssignment",
    (
        "G3. The output of a constraint solver, not an LLM. `target_lemmas` + "
        "`grammar_concept` are the D1 tagging contract every generated exercise "
        "inherits, so a mis-tagged exercise is a template violation V4 can catch — the "
        "failure mode D1 names is 'a wrong tag silently corrupts the memory model'. "
        "`section_cefr` is the shipped CEFR claim (R23) and is only rendered for the "
        "languages with a lexicon to check it against."
    ),
)

SELECTED_ITEM = _object(
    {
        "schema_version": _SCHEMA_VERSION,
        "lang": _LANG,
        "unit_index": {"type": "integer", "minimum": 1},
        "lesson_index": {"type": "integer", "minimum": 1},
        "slot_index": {"type": "integer", "minimum": 0},
        "sentence_id": {"oneOf": [_ID16, {"type": "null"}]},
        "provenance": {"type": "string", "enum": ["corpus", "llm"]},
        "gap": {"type": "boolean"},
        "new_lemmas": {"type": "array", "items": _NONEMPTY},
        "known_lemmas": {"type": "array", "items": _NONEMPTY},
        "grammar_concept": _NONEMPTY,
    },
    "SelectedItem",
    (
        "G4. One lesson slot, either filled from the corpus or marked `gap` for G5. A "
        "gap carries `sentence_id: null`, which is why the field is nullable and "
        "`gap` is separate rather than inferred — an unfilled slot and a slot whose "
        "sentence was dropped are different bugs. Selection reads only sources whose "
        "verdict is `shippable`; oracle-only corpora inform statistics and never fill a "
        "slot."
    ),
)

CANDIDATE = _object(
    {
        "schema_version": _SCHEMA_VERSION,
        "lang": _LANG,
        "candidate_id": _ID16,
        "unit_index": {"type": "integer", "minimum": 1},
        "lesson_index": {"type": "integer", "minimum": 1},
        "slot_index": {"type": "integer", "minimum": 0},
        "text": _NONEMPTY,
        "translation": _NONEMPTY,
        "author": _NONEMPTY,
        "generated_at": _NONEMPTY,
        "accepted": {"type": "boolean"},
        "reject_reason": {"type": ["string", "null"], "minLength": 1},
        "provenance": {"const": "llm"},
    },
    "Candidate",
    (
        "G5, the only authoring stage. Over-generate, then generate-and-reject against "
        "the ledger: closed-vocabulary constrained decoding is not available against a "
        "hosted API (OpenAI is JSON-schema only, Anthropic documents no regex/CFG "
        "types), so the constraint is enforced after generation, not during it. "
        "Rejected candidates are WRITTEN, not dropped — the reject rate is the number "
        "that tells you the ledger window is too tight. `author` is a model id or, in "
        "an environment with no API keys, the agent that wrote the candidates file."
    ),
)

EXERCISE = _object(
    {
        "schema_version": _SCHEMA_VERSION,
        "lang": _LANG,
        "exercise_id": _ID16,
        "unit_index": {"type": "integer", "minimum": 1},
        "lesson_index": {"type": "integer", "minimum": 1},
        "type": {"type": "string", "enum": list(EXERCISE_TYPES)},
        "prompt": _NONEMPTY,
        "accepted_answers": {"type": "array", "minItems": 1, "items": _NONEMPTY},
        "distractors": {"type": "array", "items": _NONEMPTY},
        "alignment": {
            "type": "array",
            "items": {
                "type": "array",
                "minItems": 2,
                "maxItems": 2,
                "items": {"type": "integer", "minimum": 0},
            },
        },
        "item_tags": _object(
            {
                "lemmas": {"type": "array", "minItems": 1, "items": _NONEMPTY},
                "grammar_concepts": {"type": "array", "items": _NONEMPTY},
            },
            "ItemTags",
            "D1's join. V4 checks these against the lemmas actually present.",
        ),
        "audio_ref": {"oneOf": [_ID16, {"type": "null"}]},
        "register": _NONEMPTY,
        "source_sentence_id": {"oneOf": [_ID16, {"type": "null"}]},
    },
    "Exercise",
    (
        "G7. `accepted_answers` is a SET, minimum one, and for Japanese it must "
        "enumerate kanji+okurigana, all-kana and taught katakana forms. The review "
        "(R24) measured why: the reference product marks a one-character typo fully "
        "wrong with no grace, so in a parity build the enumerated set IS the entire "
        "tolerance budget and an omission is an unrecoverable wrong answer, not a "
        "degraded one. `alignment` is index pairs from SimAlign, and its Japanese "
        "quality is unmeasured — no eng-jpn F1 is published."
    ),
)

BAKED_CLIP = _object(
    {
        "schema_version": _SCHEMA_VERSION,
        "lang": _LANG,
        "clip_id": _ID16,
        "text": _NONEMPTY,
        "voice_id": _NONEMPTY,
        "engine": {"type": "string", "enum": ["kokoro", "piper", "azure", "polly"]},
        "codec": {"const": "opus"},
        "bitrate_kbps": {"type": "integer", "minimum": 1},
        "duration_ms": {"type": "integer", "minimum": 1},
        "bytes": {"type": "integer", "minimum": 1},
        "path": _NONEMPTY,
        "licence": _NONEMPTY,
        "pipeline": {"type": "string", "enum": list(AUDIO_PIPELINES)},
    },
    "BakedClip",
    (
        "G8. Content-addressed, so a line edit re-renders one file. `codec`, "
        "`bitrate_kbps` and `bytes` exist because INV-PACK-15 asserts the shipped size "
        "against a declared budget and the review (R13) found the inherited 35-40 MB "
        "figure arithmetically impossible — 8,000 utterances at any intelligible "
        "bitrate is ~120 MB, and no codec or transcode step appeared anywhere in the "
        "spec. `pipeline` exists because the same review (R14) found the cost and size "
        "model counted lessons only, while Stories and Radio ride the same budget."
    ),
)

PACK_ROW = _object(
    {
        "schema_version": _SCHEMA_VERSION,
        "lang": _LANG,
        "table": {"type": "string", "enum": list(PACK_TABLES)},
        "row_id": _NONEMPTY,
        "payload": {"type": "object"},
    },
    "PackRow",
    (
        "G9. The last artefact before SQLite. `payload` is deliberately open: the "
        "column shapes belong to `packages/schema`, which owns the pack DB and its "
        "migrations, and duplicating them here would give the project two sources of "
        "truth that drift. What this record pins is the table name and the row id, "
        "which is what the manifest, the attribution table and the signature are "
        "computed over."
    ),
)


@dataclass(frozen=True, slots=True)
class Artifact:
    """One record kind: which stage writes it, where it lands, what shape it is."""

    kind: str
    stage: str
    filename: str
    schema: dict[str, Any]

    @property
    def validator(self) -> Draft202012Validator:
        return _validator_for(self.kind)


def _artifact(kind: str, stage: str, filename: str, schema: dict[str, Any]) -> Artifact:
    return Artifact(kind=kind, stage=stage, filename=filename + ARTIFACT_SUFFIX, schema=schema)


#: The contract. Ordered by stage; `tests/test_artifacts.py` pins its digest.
ARTIFACTS: dict[str, Artifact] = {
    art.kind: art
    for art in (
        _artifact("ingested_sentence", "g0", "ingested", INGESTED_SENTENCE),
        _artifact("analysed_sentence", "g1", "analysed", ANALYSED_SENTENCE),
        _artifact("banded_lemma", "g2", "banded", BANDED_LEMMA),
        _artifact("unit_assignment", "g3", "units", UNIT_ASSIGNMENT),
        _artifact("selected_item", "g4", "selected", SELECTED_ITEM),
        _artifact("candidate", "g5", "candidates", CANDIDATE),
        _artifact("exercise", "g7", "exercises", EXERCISE),
        _artifact("baked_clip", "g8", "clips", BAKED_CLIP),
        _artifact("pack_row", "g9", "pack-rows", PACK_ROW),
    )
}

_VALIDATORS: dict[str, Draft202012Validator] = {}


def _validator_for(kind: str) -> Draft202012Validator:
    if kind not in ARTIFACTS:
        raise UnknownArtifact(
            f"no artefact record named {kind!r}; the contract declares "
            f"{', '.join(sorted(ARTIFACTS))}"
        )
    if kind not in _VALIDATORS:
        schema = ARTIFACTS[kind].schema
        Draft202012Validator.check_schema(schema)
        _VALIDATORS[kind] = Draft202012Validator(schema)
    return _VALIDATORS[kind]


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------


def validate_record(kind: str, record: Mapping[str, Any], *, where: str = "") -> None:
    """Raise `ArtifactError` unless `record` matches the contract for `kind`.

    The message names the record kind, the failing path and the file, because the
    caller is usually a stage halfway through a 250k-row stream and "additional
    properties are not allowed" on its own identifies nothing.
    """
    try:
        _validator_for(kind).validate(dict(record))
    except _JsonSchemaValidationError as exc:
        location = "/".join(str(part) for part in exc.absolute_path) or "<root>"
        suffix = f" in {where}" if where else ""
        raise ArtifactError(f"{kind}{suffix}: {location}: {exc.message}") from exc


# ---------------------------------------------------------------------------
# Run directory layout
# ---------------------------------------------------------------------------


def build_root() -> Path:
    """Where run directories live: `$COURSEKIT_BUILD_ROOT` or `<repo>/build`.

    `build/` is in `.gitignore`, which is the point — a run directory is reproducible
    output and is never committed.
    """
    override = os.environ.get(BUILD_ROOT_ENV_VAR)
    if override:
        return Path(override)
    return _repo_root() / BUILD_ROOT_DIRNAME


def _repo_root() -> Path:
    """The repository root, found by walking up from this file.

    `tools/coursekit/src/coursekit/artifacts.py` -> five parents is the repo root. A
    `.git` probe would be prettier and would break inside a worktree's `.git` FILE and
    inside a source distribution; the path shape is fixed by the monorepo layout and
    changes only when somebody moves the package, which is a change they will notice.
    """
    return Path(__file__).resolve().parents[4]


def run_dir(lang: str) -> Path:
    """`<build root>/<lang>/` — one per language, all stages underneath."""
    if lang not in LANGUAGES:
        raise ValueError(f"unknown language {lang!r}; expected one of {', '.join(LANGUAGES)}")
    return build_root() / lang


def stage_dir(lang: str, stage: str) -> Path:
    """`<build root>/<lang>/<stage>/`."""
    return run_dir(lang) / stage


def artifact_path(lang: str, kind: str) -> Path:
    """Where a record kind's file lives. The single answer, for every lane."""
    if kind not in ARTIFACTS:
        raise UnknownArtifact(
            f"no artefact record named {kind!r}; the contract declares "
            f"{', '.join(sorted(ARTIFACTS))}"
        )
    art = ARTIFACTS[kind]
    return stage_dir(lang, art.stage) / art.filename


# ---------------------------------------------------------------------------
# Reading and writing
# ---------------------------------------------------------------------------


def write_records(
    kind: str,
    records: Iterable[Mapping[str, Any]],
    *,
    lang: str | None = None,
    path: Path | None = None,
) -> int:
    """Validate and write every record as JSON Lines. Returns the count.

    Exactly one of `lang` (the standard run directory) or `path` (a fixture, a scratch
    file) must be given. Validation happens BEFORE the file is opened, so a bad batch
    leaves no half-written artefact for the next stage to read.
    """
    target = _target(kind, lang=lang, path=path)
    validated = []
    for index, record in enumerate(records):
        validate_record(kind, record, where=f"{target.name} line {index + 1}")
        validated.append(dict(record))

    target.parent.mkdir(parents=True, exist_ok=True)
    with target.open("w", encoding="utf-8") as handle:
        for record in validated:
            handle.write(json.dumps(record, ensure_ascii=False, sort_keys=True) + "\n")
    return len(validated)


def read_records(
    kind: str,
    *,
    lang: str | None = None,
    path: Path | None = None,
) -> Iterator[dict[str, Any]]:
    """Stream a record file, validating every row on the way out.

    Validating on read as well as on write is not belt and braces. Writing is the only
    path this module controls; reading is where a hand-edited file, a partial run or a
    schema bump shows up, and a stage that trusts an unvalidated row fails somewhere
    else entirely.
    """
    target = _target(kind, lang=lang, path=path)
    if not target.exists():
        raise FileNotFoundError(
            f"no {kind} artefact at {target}; the stage that writes it "
            f"({ARTIFACTS[kind].stage}) has not run"
        )
    with target.open(encoding="utf-8") as handle:
        for number, line in enumerate(handle, start=1):
            if not line.strip():
                continue
            try:
                record = json.loads(line)
            except json.JSONDecodeError as exc:
                raise ArtifactError(f"{kind} in {target.name} line {number}: {exc}") from exc
            validate_record(kind, record, where=f"{target.name} line {number}")
            yield record


def _target(kind: str, *, lang: str | None, path: Path | None) -> Path:
    if (lang is None) == (path is None):
        raise ValueError("pass exactly one of lang= (a run directory) or path= (an explicit file)")
    if path is not None:
        if kind not in ARTIFACTS:
            raise UnknownArtifact(
                f"no artefact record named {kind!r}; the contract declares "
                f"{', '.join(sorted(ARTIFACTS))}"
            )
        return path
    assert lang is not None
    return artifact_path(lang, kind)


# ---------------------------------------------------------------------------
# Identity
# ---------------------------------------------------------------------------


def sentence_id(lang: str, text: str) -> str:
    """The content-addressed id of a sentence: 16 hex of sha256 over `lang\\x1ftext`.

    Content-addressed so the same sentence gets the same id across runs and across
    machines, which is what makes the FSRS item ids in `packages/core` stable when a
    pack is rebuilt. The separator is a unit separator rather than a space so two
    different (lang, text) pairs cannot collide by concatenation.
    """
    digest = hashlib.sha256(f"{lang}\x1f{text}".encode())
    return digest.hexdigest()[:16]


def dedup_hash(text: str) -> str:
    """The 32-hex dedup key for a normalised sentence (G0's exact-duplicate check)."""
    return hashlib.sha256(text.encode()).hexdigest()[:32]


def contract_digest() -> str:
    """A sha256 over every schema, its stage and its filename.

    Pinned by `tests/test_artifacts.py`. A lane that changes a boundary gets a failing
    test naming this function, which is the whole mechanism: the alternative is a
    schema edit that lands in wave 1 and is discovered in wave 2 as a lane whose input
    no longer parses.
    """
    payload = json.dumps(
        {
            kind: {
                "stage": art.stage,
                "filename": art.filename,
                "schema": art.schema,
            }
            for kind, art in sorted(ARTIFACTS.items())
        },
        sort_keys=True,
        ensure_ascii=False,
    )
    return hashlib.sha256(payload.encode()).hexdigest()
