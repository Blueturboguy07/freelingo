"""The read-only pack database: one DDL, twelve writers, one INSERT path.

The DDL is **not here**. It lives in `packages/schema/src/pack-schema.ts` and is read out
of that file at build time by `pack_schema_ddl()`. That is unusual enough to be worth the
paragraph: a pack is written by this Python and read by TypeScript on a device, and the
two have to agree on every column name in twelve tables. A second copy in Python would
be correct on the day it was written, and the way it would later be wrong is the
expensive way — a pack that builds green, signs green, installs green, and returns no
rows for one query on somebody's phone, with no test anywhere able to see it. Parsing
one file is a smaller price than that.

Each table has a writer registered under its own name (`packbuild.register_writer`), so
the per-table mapping from artefact records to rows is readable in one place and the
insert path is generic. Nothing here validates the *shape* of a payload against the
schema by hand: the schema is created first and the column list is read back out of
SQLite, so a payload key that is not a column fails loudly at build time.

Regenerating the loader fixture (`packages/core/src/packs/__fixtures__/es-mini`):

    uv run python -c "from coursekit.packbuild.sqlite import build_fixture_pack as b; print(b())"

`-c` rather than `-m`: `python -m` imports this file as `__main__`, the writer registry
then discovers it again under its real name, and every writer registers twice — which
`Registry.add` correctly refuses. The import-once form is the one that works.
"""

from __future__ import annotations

import json
import sqlite3
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from ..config import PACK_LICENCE, PACK_TABLES
from ..config.g9 import (
    AUDIO_DIRNAME,
    AUTHORED_ATTRIBUTION_OWNER,
    AUTHORED_SOURCE_ID,
    CREDITS_META_PREFIX,
    DDL_ARRAY_NAME,
    FIXTURE_PACK_RELPATH,
    FIXTURE_SEED_FILENAME,
    PACK_DB_FILENAME,
    PACK_INSERT_ORDER,
    PACK_ROW_ID_COLUMNS,
    PACK_SCHEMA_TS_RELPATH,
    PACK_SCHEMA_VERSION,
    PACK_TABLES_EMPTY_AT_V0,
    PROVENANCE_BY_ARTEFACT,
)
from ..config.validate import RTL_LANGUAGES, RTL_META_ROW_ID
from . import register_writer

__all__ = [
    "PackInputs",
    "build_rows",
    "create_pack_schema",
    "pack_columns",
    "pack_schema_ddl",
    "read_ts_string_array",
    "repo_root",
    "row_id_for",
    "shipped_sentences",
    "strip_ts_comments",
    "write_pack",
]


def repo_root() -> Path:
    """The repository root.

    `tools/coursekit/src/coursekit/packbuild/sqlite.py` — six parents up. A `.git` probe
    would break inside a worktree (where `.git` is a file) and inside a source
    distribution; the path shape is fixed by the monorepo layout, and moving the package
    is a change somebody notices.
    """
    return Path(__file__).resolve().parents[5]


# ---------------------------------------------------------------------------
# Reading the one copy of the schema
# ---------------------------------------------------------------------------


def strip_ts_comments(source: str) -> str:
    """Remove `//` and `/* */` comments, leaving string literals alone.

    String-aware rather than a regex, because the comments in `pack-schema.ts` contain
    backticks (`` `attribution:<source_id>` ``) and apostrophes, and the DDL contains
    `'` inside CHECK constraints. A regex that got either wrong would silently return a
    short DDL, and a short DDL is a pack with a missing table.
    """
    out: list[str] = []
    index = 0
    length = len(source)
    while index < length:
        char = source[index]
        if char in "'\"`":
            delimiter = char
            out.append(char)
            index += 1
            while index < length:
                if source[index] == "\\" and index + 1 < length:
                    out.append(source[index])
                    out.append(source[index + 1])
                    index += 2
                    continue
                out.append(source[index])
                if source[index] == delimiter:
                    index += 1
                    break
                index += 1
            continue
        if char == "/" and index + 1 < length and source[index + 1] == "/":
            while index < length and source[index] != "\n":
                index += 1
            continue
        if char == "/" and index + 1 < length and source[index + 1] == "*":
            end = source.find("*/", index + 2)
            index = length if end == -1 else end + 2
            continue
        out.append(char)
        index += 1
    return "".join(out)


def read_ts_string_array(path: Path, name: str) -> tuple[str, ...]:
    """Every string literal of the exported array `name` in a TypeScript file.

    The contract the TypeScript side must keep (pinned by `pack-schema.test.ts`): the
    array is `export const <name>...= [ ... ]`, and every element is one string literal.
    A concatenation or a computed element would read as an empty slot here.
    """
    source = strip_ts_comments(path.read_text(encoding="utf-8"))
    anchor = source.find(f"const {name}")
    if anchor == -1:
        raise ValueError(f"{path} declares no `const {name}`")
    # After the `=`, never after the name: the declaration is
    # `const PACK_SCHEMA_DDL: readonly string[] = [`, and the first `[` in that line
    # belongs to the TYPE. Opening the scan there reads `string[]` as an empty array and
    # returns a zero-statement DDL — a pack with no tables, built without an error.
    assignment = source.find("=", anchor)
    start = source.find("[", assignment) if assignment != -1 else -1
    if assignment == -1 or start == -1:
        raise ValueError(f"{path}: `const {name}` is not an array literal")

    values: list[str] = []
    depth = 0
    index = start
    length = len(source)
    while index < length:
        char = source[index]
        if char == "[":
            depth += 1
            index += 1
            continue
        if char == "]":
            depth -= 1
            if depth == 0:
                break
            index += 1
            continue
        if char in "'\"`":
            delimiter = char
            index += 1
            buffer: list[str] = []
            while index < length and source[index] != delimiter:
                if source[index] == "\\" and index + 1 < length:
                    buffer.append(source[index + 1])
                    index += 2
                    continue
                buffer.append(source[index])
                index += 1
            index += 1
            values.append("".join(buffer))
            continue
        index += 1

    if not values:
        raise ValueError(f"{path}: `const {name}` yielded no string literals")
    return tuple(values)


def pack_schema_ddl() -> tuple[str, ...]:
    """The pack DDL, as `packages/schema/src/pack-schema.ts` declares it."""
    return read_ts_string_array(repo_root() / PACK_SCHEMA_TS_RELPATH, DDL_ARRAY_NAME)


def create_pack_schema(connection: sqlite3.Connection) -> None:
    """Execute the DDL. The only place a pack's tables are created on this side."""
    for statement in pack_schema_ddl():
        connection.execute(statement)


def pack_columns(connection: sqlite3.Connection) -> dict[str, tuple[str, ...]]:
    """Column names per table, read back out of the database that was just built."""
    tables = [
        row[0]
        for row in connection.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"
        )
        if not str(row[0]).startswith("sqlite_")
    ]
    return {
        table: tuple(str(row[1]) for row in connection.execute(f'PRAGMA table_info("{table}")'))
        for table in tables
    }


# ---------------------------------------------------------------------------
# What the writers are handed
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class PackInputs:
    """Every artefact record G9 reads, already in memory.

    A pack is tens of thousands of rows, not millions: the ledger a language ships is
    bounded by the curriculum, and holding it is what lets the writers cross-reference
    freely (an exercise needs its sentence's licence, a sentence needs its clip's bytes).
    The streaming discipline belongs upstream, at G0, where the input is 250k candidates.
    """

    lang: str
    pack_id: str
    course_id: str
    major: int
    version: str
    sentences: tuple[Mapping[str, Any], ...] = ()
    lemmas: tuple[Mapping[str, Any], ...] = ()
    units: tuple[Mapping[str, Any], ...] = ()
    selected: tuple[Mapping[str, Any], ...] = ()
    candidates: tuple[Mapping[str, Any], ...] = ()
    exercises: tuple[Mapping[str, Any], ...] = ()
    clips: tuple[Mapping[str, Any], ...] = ()
    #: Per-source licence rows, as the run resolved them (`runlog.licences_seen`).
    licences: tuple[Mapping[str, Any], ...] = ()
    #: The complete current validator-report.json, including hard gate and engine evidence.
    validator_report: Mapping[str, Any] = field(default_factory=dict)
    #: The measured native-reviewer wrong-item rate, or None before the sample lands.
    defect_rate: float | None = None
    #: The validated sample summary, or None before a sheet has been scored.
    review: Mapping[str, Any] | None = None
    meta_extra: Mapping[str, str] = field(default_factory=dict)


def shipped_sentences(inputs: PackInputs) -> list[Mapping[str, Any]]:
    """The sentences that actually go in the pack, corpus and authored, in id order.

    **Not** every sentence G0 ingested. G0's ledger is a quarter of a million candidate
    pairs; G4 picks the few thousand that fill lesson slots. Shipping the ledger would
    put text in the pack that no exercise references, inflate the attribution table with
    corpora the learner never meets, and — because a licence obligation attaches to what
    you distribute — create obligations for nothing.

    An unfilled slot (`gap: true`, `sentence_id: null`) is filled by an **accepted** G5
    candidate. Those carry no corpus: their licence is the pack's own CC BY-NC-SA 4.0,
    whose BY clause still requires a credit, and they are what the `{{n}}%
    machine-authored` figure on S001 counts.
    """
    from ..artifacts import first_accepted_candidates

    if not inputs.selected:
        raise ValueError(
            "no selected_item records: a pack ships what G4 selected, never the whole "
            "G0 ingest ledger"
        )

    by_id = {str(record["sentence_id"]): record for record in inputs.sentences}
    shipped: dict[str, dict[str, Any]] = {}

    for slot in inputs.selected:
        raw = slot.get("sentence_id")
        if not raw:
            continue
        record = by_id.get(str(raw))
        if record is None:
            raise LookupError(
                f"selected sentence {raw} is not in the ingest ledger; G4 and G0 disagree"
            )
        shipped[str(raw)] = {**record, "provenance": "corpus"}

    chosen = first_accepted_candidates(inputs.candidates, lang=inputs.lang)
    for slot in inputs.selected:
        if slot.get("sentence_id"):
            continue
        coordinate = (slot["unit_index"], slot["lesson_index"], slot["slot_index"])
        candidate = chosen.get(coordinate)
        if candidate is None:
            raise LookupError(f"selected gap {coordinate} has no accepted candidate")
        text = str(candidate["text"])
        identifier = str(candidate["candidate_id"])
        if identifier in shipped:
            raise ValueError(f"conflicting shipped source identity {identifier}")
        shipped[identifier] = {
            "sentence_id": identifier,
            "text": text,
            "translation": str(candidate["translation"]),
            "provenance": "llm",
            "source_id": AUTHORED_SOURCE_ID,
            "corpus": None,
            "corpus_version": None,
            "licence": PACK_LICENCE,
            "attribution_required": True,
            "attribution_owner": AUTHORED_ATTRIBUTION_OWNER,
        }

    return [shipped[key] for key in sorted(shipped)]


def _unit_id(record: Mapping[str, Any]) -> str:
    return f"u{int(record['unit_index']):03d}"


def _concept_id(name: str) -> str:
    return f"gc:{name}"


def _lexeme_id(record: Mapping[str, Any]) -> str:
    return f"lx:{record['lemma']}:{record['pos']}"


def _clip_id(record: Mapping[str, Any]) -> str:
    return str(record["clip_id"])


# ---------------------------------------------------------------------------
# The writers, one per table
# ---------------------------------------------------------------------------


@register_writer("meta")
def meta_rows(inputs: PackInputs) -> list[dict[str, Any]]:
    """`meta` carries what the app must know without its manifest, plus the credits.

    The manifest is the signed document, but a pack that is opened after install is
    opened on its own — so the facts S001, S137 and S151 render (provenance, defect rate,
    the CEFR claim, the ledger unit) are in the database too. `attribution:` rows are
    built by `packbuild.attribution`, which is the module INV-PACK-17 lives in.
    """
    from .attribution import credit_rows  # local import: one direction, no cycle

    corpus, machine = provenance_split(inputs)
    rows: list[dict[str, Any]] = [
        {"key": "pack_id", "value": inputs.pack_id},
        {"key": "course_id", "value": inputs.course_id},
        {"key": "lang", "value": inputs.lang},
        {"key": "major", "value": str(inputs.major)},
        {"key": "version", "value": inputs.version},
        {"key": "schema_version", "value": str(PACK_SCHEMA_VERSION)},
        {"key": "ledger_unit", "value": ledger_unit(inputs.lang)},
        {"key": "provenance_corpus_pct", "value": f"{corpus:.2f}"},
        {"key": "provenance_machine_authored_pct", "value": f"{machine:.2f}"},
        {"key": "defect_rate", "value": f"{inputs.defect_rate or 0.0:.4f}"},
        {"key": "cefr_claim", "value": cefr_claim(inputs.lang)},
        {"key": "cefr_checked", "value": "1" if cefr_checked(inputs.lang) else "0"},
        # The direction flag, DECIDED rather than absent. V12: "an absent direction flag
        # is not 'false', it is nobody having decided — and the first pack that needs
        # true would ship without it", and it blocked every pack this lane built until
        # the row existed. A real bool because that is what V12 compares against
        # (`value is not expected_rtl`); the column's TEXT affinity stores it as 0/1 and
        # the `pack_row` artefact keeps the boolean. `config/validate.py::RTL_LANGUAGES`
        # is the list, and no v1 language is in it — es/fr/de/ja are all LTR, and
        # INV-I18N-01 pins the app's layout to LTR besides.
        {"key": RTL_META_ROW_ID, "value": inputs.lang in RTL_LANGUAGES},
    ]
    for credit in credit_rows(inputs):
        rows.append(
            {
                "key": f"{CREDITS_META_PREFIX}{credit['source_id']}",
                "value": json.dumps(credit, sort_keys=True, ensure_ascii=False),
            }
        )
    for key, value in sorted(inputs.meta_extra.items()):
        rows.append({"key": key, "value": value})
    return rows


@register_writer("audio")
def audio_rows(inputs: PackInputs) -> list[dict[str, Any]]:
    """One row per baked clip. `path` is relative to the pack root, never absolute."""
    from .attribution import licence_for_source

    rows = []
    for clip in sorted(inputs.clips, key=lambda record: str(record["clip_id"])):
        owner, required = licence_for_source(inputs, f"voice:{clip['engine']}", clip["licence"])
        rows.append(
            {
                "audio_id": _clip_id(clip),
                "clip_hash": str(clip["clip_id"]),
                "path": f"{AUDIO_DIRNAME}/{clip['clip_id']}.opus",
                "voice_id": str(clip["voice_id"]),
                "engine": str(clip["engine"]),
                "codec": str(clip["codec"]),
                "bitrate_kbps": int(clip["bitrate_kbps"]),
                "duration_ms": int(clip["duration_ms"]),
                "bytes": int(clip["bytes"]),
                "pipeline": str(clip["pipeline"]),
                "licence": str(clip["licence"]),
                "attribution_required": 1 if required else 0,
                "attribution_owner": owner,
            }
        )
    return rows


@register_writer("lexeme")
def lexeme_rows(inputs: PackInputs) -> list[dict[str, Any]]:
    return [
        {
            "lexeme_id": _lexeme_id(lemma),
            "lemma": str(lemma["lemma"]),
            "pos": str(lemma["pos"]),
            "rank": int(lemma["rank"]),
            "frequency": int(lemma["frequency"]),
            "decile": int(lemma["decile"]),
            "band": str(lemma["band"]),
            "band_source": str(lemma["band_source"]),
            "band_source_licence": lemma.get("band_source_licence"),
            "gloss": lemma.get("gloss"),
        }
        for lemma in sorted(inputs.lemmas, key=lambda record: int(record["rank"]))
    ]


@register_writer("grammar_concept")
def grammar_concept_rows(inputs: PackInputs) -> list[dict[str, Any]]:
    """Derived from the curriculum, which is where grammar concepts are authored."""
    seen: dict[str, dict[str, Any]] = {}
    for unit in inputs.units:
        name = str(unit["grammar_concept"])
        seen.setdefault(
            _concept_id(name),
            {
                "concept_id": _concept_id(name),
                "name": name,
                "description": str(unit["function"]),
                "register_slot": str(unit["register_slot"]),
            },
        )
    return [seen[key] for key in sorted(seen)]


@register_writer("sentence")
def sentence_rows(inputs: PackInputs) -> list[dict[str, Any]]:
    """Shipped text, with the licence row and the owner INV-PACK-17 needs.

    `attribution_owner` is written even where the build could have looked it up later:
    the pack is what the device has, and a credits surface that had to resolve a source
    id against a table the app does not ship would render nothing at all.
    """
    from .attribution import licence_for_source

    clip_by_text = {str(clip["text"]): _clip_id(clip) for clip in inputs.clips}
    rows = []
    for sentence in shipped_sentences(inputs):
        provenance = PROVENANCE_BY_ARTEFACT[str(sentence.get("provenance", "corpus"))]
        owner, required = licence_for_source(
            inputs, str(sentence["source_id"]), str(sentence["licence"])
        )
        if sentence.get("attribution_owner"):
            owner = str(sentence["attribution_owner"])
        if "attribution_required" in sentence:
            required = bool(sentence["attribution_required"])
        rows.append(
            {
                "sentence_id": str(sentence["sentence_id"]),
                "lang": inputs.lang,
                "text": str(sentence["text"]),
                "translation": str(sentence["translation"]),
                "provenance": provenance,
                "source_id": str(sentence["source_id"]),
                "corpus": sentence.get("corpus"),
                "corpus_version": sentence.get("corpus_version"),
                "licence": str(sentence["licence"]),
                "attribution_required": 1 if required else 0,
                "attribution_owner": owner,
                "audio_id": clip_by_text.get(str(sentence["text"])),
            }
        )
    return rows


@register_writer("unit")
def unit_rows(inputs: PackInputs) -> list[dict[str, Any]]:
    return [
        {
            "unit_id": _unit_id(unit),
            "section_index": int(unit["section_index"]),
            "section_cefr": str(unit["section_cefr"]),
            "unit_index": int(unit["unit_index"]),
            "title": str(unit["unit_title"]),
            "function": str(unit["function"]),
            "grammar_concept": _concept_id(str(unit["grammar_concept"])),
            "register_slot": str(unit["register_slot"]),
            "level_count": int(unit["level_count"]),
        }
        for unit in sorted(inputs.units, key=lambda record: int(record["unit_index"]))
    ]


@register_writer("unit_item")
def unit_item_rows(inputs: PackInputs) -> list[dict[str, Any]]:
    """The introduction schedule V1 is checked against: order stored, never inferred."""
    rows = []
    for unit in sorted(inputs.units, key=lambda record: int(record["unit_index"])):
        order = 0
        for lemma in unit["target_lemmas"]:
            order += 1
            rows.append(
                {
                    "unit_id": _unit_id(unit),
                    "item_kind": "lexeme",
                    "item_ref": str(lemma),
                    "introduction_order": order,
                }
            )
        order += 1
        rows.append(
            {
                "unit_id": _unit_id(unit),
                "item_kind": "grammar_concept",
                "item_ref": _concept_id(str(unit["grammar_concept"])),
                "introduction_order": order,
            }
        )
    return rows


def _slot_indices(exercises: Sequence[Mapping[str, Any]]) -> dict[str, int]:
    """Position within a lesson, derived — because the artefact contract has no slot.

    The frozen `exercise` record (G7's, `artifacts.EXERCISE`) carries unit and lesson but
    no slot index, and that contract is another lane's to change. So the order is derived
    from the CONTENT-ADDRESSED exercise id, which makes it stable across rebuilds: a
    rebuild that adds an exercise to a lesson may renumber the slots around it, and
    nothing depends on a slot number — `item_id` is what an FSRS row resolves through
    (INV-PACK-41), never a position.

    Recorded as an escalation rather than hidden: a pack cannot express an AUTHORED
    order until the artefact grows a `slot_index`.
    """
    ordered: dict[str, int] = {}
    grouped: dict[tuple[int, int], list[str]] = {}
    for exercise in exercises:
        key = (int(exercise["unit_index"]), int(exercise["lesson_index"]))
        grouped.setdefault(key, []).append(str(exercise["exercise_id"]))
    for key in sorted(grouped):
        for slot, exercise_id in enumerate(sorted(grouped[key])):
            ordered[exercise_id] = slot
    return ordered


@register_writer("exercise")
def exercise_rows(inputs: PackInputs) -> list[dict[str, Any]]:
    """Every exercise, carrying the item id the learner's FSRS row hangs off.

    The id comes from `packbuild.itemid` over the semantic fields only — which is why
    `distractors_json`, `ruby_json`, `illustration_ref` and `audio_id` can all change in
    a rebuild without a single FSRS row moving (INV-PACK-41).
    """
    from .itemid import item_id

    unit_by_index = {int(unit["unit_index"]): _unit_id(unit) for unit in inputs.units}
    slots = _slot_indices(inputs.exercises)
    rows = []
    for exercise in sorted(inputs.exercises, key=lambda record: str(record["exercise_id"])):
        tags = exercise["item_tags"]
        semantic = {
            "prompt": str(exercise["prompt"]),
            "preferredSurface": str(exercise["accepted_answers"][0]),
            "register": str(exercise["register"]),
            "lexemes": list(tags["lemmas"]),
            "grammarConcepts": list(tags.get("grammar_concepts", [])),
            "graphemes": list(tags.get("graphemes", [])),
        }
        rows.append(
            {
                "exercise_id": str(exercise["exercise_id"]),
                "item_id": item_id(semantic),
                "unit_id": unit_by_index[int(exercise["unit_index"])],
                "lesson_index": int(exercise["lesson_index"]),
                "slot_index": slots[str(exercise["exercise_id"])],
                "type": str(exercise["type"]),
                "prompt": str(exercise["prompt"]),
                "preferred_surface": str(exercise["accepted_answers"][0]),
                "register": str(exercise["register"]),
                "accepted_answers_json": json.dumps(
                    list(exercise["accepted_answers"]), ensure_ascii=False
                ),
                "distractors_json": json.dumps(
                    list(exercise.get("distractors", [])), ensure_ascii=False
                ),
                "alignment_json": json.dumps(
                    [list(pair) for pair in exercise.get("alignment", [])], ensure_ascii=False
                ),
                "ruby_json": exercise.get("ruby_json"),
                "illustration_ref": exercise.get("illustration_ref"),
                "audio_id": exercise.get("audio_ref"),
                "source_sentence_id": exercise.get("source_sentence_id"),
            }
        )
    return rows


@register_writer("exercise_item_tag")
def exercise_item_tag_rows(inputs: PackInputs) -> list[dict[str, Any]]:
    """D1's join. A wrong row here silently corrupts the memory model — hence V4.

    ONE ROW PER (exercise, kind, ref), because the table's key says so and a sentence
    does not. `item_tags.lemmas` is the token-aligned lemma list of the sentence — `El
    libro está sobre la mesa.` carries `el` twice, and `Hola, hola, hola.` carries
    `hola` three times — which is the artefact being faithful to the text. The JOIN is a
    set: "this exercise tags this lexeme" is true once. Measured on the real course,
    2026-09-12: G9 refused the pack with `UNIQUE constraint failed:
    exercise_item_tag.exercise_id, exercise_item_tag.item_kind,
    exercise_item_tag.item_ref` — after a bake, which is the expensive place to find out.
    Deduplicated here rather than in the artefact so `item_tags.lemmas` stays the list
    V4 checks against the analysis.
    """
    introduced: set[tuple[str, str]] = set()
    rows = []

    def ordered(record: Mapping[str, Any]) -> tuple[int, int, str]:
        return (
            int(record["unit_index"]),
            int(record["lesson_index"]),
            str(record["exercise_id"]),
        )

    for exercise in sorted(inputs.exercises, key=ordered):
        tags = exercise["item_tags"]
        pairs = [("lexeme", str(lemma)) for lemma in tags["lemmas"]]
        pairs += [
            ("grammar_concept", _concept_id(str(concept)))
            for concept in tags.get("grammar_concepts", [])
        ]
        pairs += [("grapheme", str(glyph)) for glyph in tags.get("graphemes", [])]
        seen_here: set[tuple[str, str]] = set()
        for kind, ref in pairs:
            if (kind, ref) in seen_here:
                continue
            seen_here.add((kind, ref))
            is_new = (kind, ref) not in introduced
            introduced.add((kind, ref))
            rows.append(
                {
                    "exercise_id": str(exercise["exercise_id"]),
                    "item_kind": kind,
                    "item_ref": ref,
                    "is_new": 1 if is_new else 0,
                }
            )
    return rows


@register_writer("story")
def story_rows(_inputs: PackInputs) -> list[dict[str, Any]]:
    """Empty at v0: Stories are P6. The table exists so P6 is not a schema migration."""
    return []


@register_writer("radio_episode")
def radio_episode_rows(_inputs: PackInputs) -> list[dict[str, Any]]:
    """Empty at v0: Radio is P6."""
    return []


@register_writer("character_lesson")
def character_lesson_rows(_inputs: PackInputs) -> list[dict[str, Any]]:
    """Empty at v0: the Japanese characters stage is P7 (INV-PACK-16)."""
    return []


# ---------------------------------------------------------------------------
# Shared derivations the writers and the manifest both need
# ---------------------------------------------------------------------------


def ledger_unit(lang: str) -> str:
    """INV-PACK-40: declared exactly once per pack, read by every token consumer.

    Re-exported from `coursekit.ledger` rather than looked up here, so the pack writer and
    the manifest writer read the same declaration the length filter and V1/V2 read.
    """
    from ..ledger import ledger_unit as declared

    return declared(lang)


def cefr_checked(lang: str) -> bool:
    """Whether a CEFR lexicon backed this language's grading (Q8 ruling).

    The machine-readable half of `cefr_claim`, and the one the app should branch on:
    `CourseManifest.cefrChecked` in `packages/core` is a boolean, and the path lane
    renders its own section-card chip from it. Both halves are derived from this one
    predicate so the sentence and the boolean cannot disagree.
    """
    from ..config import CEFR_LANGUAGES

    return lang in CEFR_LANGUAGES


def cefr_claim(lang: str) -> str:
    """The Q8 ruling: a CEFR claim only where there is a lexicon to check it against."""
    from ..config.g9 import CEFR_CLAIM_CHECKED, CEFR_CLAIM_FREQUENCY

    return CEFR_CLAIM_CHECKED if cefr_checked(lang) else CEFR_CLAIM_FREQUENCY


def provenance_split(inputs: PackInputs) -> tuple[float, float]:
    """(corpus %, machine-authored %) over the shipped sentences, to two decimals.

    S001 renders `{{n}}% machine-authored` on the course card and S137 repeats it. It is
    computed over the sentences that actually ship, not over everything G5 generated —
    a rejected candidate is not in the pack and must not flatter the number.
    """
    shipped = shipped_sentences(inputs)
    total = len(shipped)
    if total == 0:
        return (0.0, 0.0)
    machine = sum(
        1
        for sentence in shipped
        if PROVENANCE_BY_ARTEFACT[str(sentence.get("provenance", "corpus"))] == "machine_authored"
    )
    machine_pct = round(machine * 100 / total, 2)
    return (round(100.0 - machine_pct, 2), machine_pct)


# ---------------------------------------------------------------------------
# Building and writing
# ---------------------------------------------------------------------------


def row_id_for(table: str, row: Mapping[str, Any]) -> str:
    """The `pack_row` artefact's id: the table's identifying columns, joined by `/`."""
    return "/".join(str(row[column]) for column in PACK_ROW_ID_COLUMNS[table])


def build_rows(inputs: PackInputs) -> dict[str, list[dict[str, Any]]]:
    """Run every registered writer, in table order. Missing writer = hard failure."""
    from . import PACKBUILD

    missing = [table for table in PACK_TABLES if PACKBUILD.get(table) is None]
    if missing:
        raise LookupError(
            f"no pack writer for {', '.join(missing)}; a pack missing a table is not a "
            f"pack, so this never degrades to a partial build"
        )
    return {table: list(PACKBUILD.get(table)(inputs)) for table in PACK_TABLES}


def write_pack(destination: Path, rows_by_table: Mapping[str, Sequence[Mapping[str, Any]]]) -> Path:
    """Create the pack database at `destination` and insert every row.

    Foreign keys are ON for the insert, so a dangling `unit_id` or `audio_id` fails here
    rather than becoming an empty screen on a device. The file is then written once and
    never opened for writing again — the app opens it read-only.
    """
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.exists():
        destination.unlink()

    connection = sqlite3.connect(destination)
    try:
        connection.execute("PRAGMA foreign_keys = ON")
        create_pack_schema(connection)
        columns = pack_columns(connection)
        for table in PACK_INSERT_ORDER:
            rows = rows_by_table.get(table, [])
            if table in PACK_TABLES_EMPTY_AT_V0 and rows:
                raise ValueError(f"{table} is empty at v0 but {len(rows)} rows were built")
            for row in rows:
                unknown = sorted(set(row) - set(columns[table]))
                if unknown:
                    raise ValueError(
                        f"{table} has no column(s) {', '.join(unknown)}; the schema is "
                        f"{PACK_SCHEMA_TS_RELPATH} and this build must follow it"
                    )
                names = list(row)
                placeholders = ", ".join("?" for _ in names)
                quoted = ", ".join(f'"{name}"' for name in names)
                connection.execute(
                    f'INSERT INTO "{table}" ({quoted}) VALUES ({placeholders})',
                    [row[name] for name in names],
                )
        connection.commit()
    finally:
        connection.close()
    return destination


def dump_pack(path: Path) -> dict[str, list[dict[str, Any]]]:
    """Every row of every table, ordered deterministically. Used to compare two builds.

    Two SQLite builds of the same content are not byte-identical across library
    versions, so a fixture is compared by CONTENT. Comparing bytes would turn a Homebrew
    upgrade into a red test and teach everybody to regenerate the fixture without reading
    the diff.
    """
    connection = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    try:
        connection.row_factory = sqlite3.Row
        out: dict[str, list[dict[str, Any]]] = {}
        for table in PACK_TABLES:
            rows = [dict(row) for row in connection.execute(f'SELECT * FROM "{table}"')]
            rows.sort(key=lambda row: json.dumps(row, sort_keys=True, ensure_ascii=False))
            out[table] = rows
        return out
    finally:
        connection.close()


# ---------------------------------------------------------------------------
# The committed loader fixture
# ---------------------------------------------------------------------------


def fixture_dir() -> Path:
    return repo_root() / FIXTURE_PACK_RELPATH


def fixture_inputs() -> PackInputs:
    """Read the committed seed into `PackInputs`.

    The seed is the reviewable artefact — six sentences of Spanish, two voices, one unit
    — and the pack beside it is built from it by this module, so what `packages/core`
    tests against is real G9 output rather than a hand-written database that agrees with
    the loader by construction.
    """
    seed = json.loads((fixture_dir() / FIXTURE_SEED_FILENAME).read_text(encoding="utf-8"))
    return PackInputs(
        lang=seed["lang"],
        pack_id=seed["pack_id"],
        course_id=seed["course_id"],
        major=int(seed["major"]),
        version=seed["version"],
        sentences=tuple(seed["sentences"]),
        selected=tuple(seed["selected"]),
        candidates=tuple(seed.get("candidates", ())),
        lemmas=tuple(seed["lemmas"]),
        units=tuple(seed["units"]),
        exercises=tuple(seed["exercises"]),
        clips=tuple(seed["clips"]),
        licences=tuple(seed["licences"]),
        validator_report=seed["validator_report"],
        defect_rate=seed["defect_rate"],
    )


def build_fixture_pack() -> Path:
    """Rebuild the committed fixture pack in place. Run by hand, reviewed as a diff."""
    from .manifest import build_manifest, write_manifest

    inputs = fixture_inputs()
    target = fixture_dir()
    database = write_pack(target / PACK_DB_FILENAME, build_rows(inputs))
    manifest = build_manifest(inputs, database, audio_dir=target / AUDIO_DIRNAME)
    write_manifest(target, manifest)
    return database
