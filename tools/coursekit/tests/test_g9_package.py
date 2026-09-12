"""G9 end to end: `coursekit pack es` over a real ledger, and the schema it writes into.

Three things are being protected here, in rough order of how expensive they are to get
wrong:

1. **One DDL.** The pack's columns are declared in `packages/schema/src/pack-schema.ts`
   and parsed out of it at build time. A second copy in Python would drift into a pack
   that builds, signs and installs green and then returns no rows for one query on a
   device. So the parser is tested on its failure modes, not just on the happy path.
2. **The committed loader fixture is real G9 output.** `packages/core`'s loader tests run
   against `__fixtures__/es-mini`, and a fixture hand-written to agree with the loader
   would prove that the loader agrees with itself.
3. **The gates fail the stage.** Exit 4, nothing written, and the reason named.
"""

from __future__ import annotations

import importlib
import json
import re
import sqlite3
from pathlib import Path
from typing import Any

import pytest
from typer.testing import CliRunner

from coursekit.artifacts import artifact_path, read_records, stage_dir, write_records
from coursekit.cli import app
from coursekit.config import (
    EXIT_FAILED,
    EXIT_OK,
    PACK_STAGE_ID,
    PACK_TABLES,
    TOOL_NAME,
    VALIDATOR_IDS,
)
from coursekit.config.g9 import (
    AUDIO_DIRNAME,
    CREDITS_META_PREFIX,
    DDL_ARRAY_NAME,
    FIXTURE_PACK_RELPATH,
    MANIFEST_FILENAME,
    PACK_DB_FILENAME,
    PACK_INSERT_ORDER,
    PACK_SCHEMA_TS_RELPATH,
    PACK_SCHEMA_VERSION,
    PACK_TABLES_EMPTY_AT_V0,
    UNRESOLVED_LICENCE,
)
from coursekit.packbuild import PACKBUILD
from coursekit.packbuild.sqlite import (
    build_rows,
    dump_pack,
    fixture_inputs,
    pack_schema_ddl,
    read_ts_string_array,
    repo_root,
    strip_ts_comments,
    write_pack,
)
from coursekit.runlog import LicenceRow, RunLog
from coursekit.stages import STAGES

runner = CliRunner()


@pytest.fixture(autouse=True)
def _g9_is_registered() -> None:
    """Re-register G9 if a previous test cleared the registry.

    `conftest.empty_registry` calls `STAGES.reset_for_tests()`, which clears the entries
    AND the "discovery ran" flag — but discovery re-imports modules that are already in
    `sys.modules`, so the decorators never run again and the registry stays empty for the
    rest of the process. Before P2 that was invisible (nothing was registered anyway);
    now it makes `coursekit pack es` exit 2 in a full-suite run and 0 when this file runs
    alone, which is the worst shape a test failure can have.

    The real fix belongs in `conftest.py`, which this lane does not own — recorded as a
    blocker for the integrate task. Reloading the module here re-runs the decorator.
    """
    if STAGES.get(PACK_STAGE_ID) is None:
        import coursekit.stages.g9_package as stage_module

        importlib.reload(stage_module)


SEED = json.loads((repo_root() / FIXTURE_PACK_RELPATH / "seed.json").read_text(encoding="utf-8"))

#: The record kinds the seed replays, and the stage each belongs to.
_SEED_RECORDS = {
    "ingested_sentence": "sentences",
    "banded_lemma": "lemmas",
    "unit_assignment": "units",
    "selected_item": "selected",
    "candidate": "candidates",
    "exercise": "exercises",
    "baked_clip": "clips",
}


def _replay_seed(lang: str = "es", *, licences: list[dict[str, Any]] | None = None) -> RunLog:
    """Write the seed's records into the isolated build root as real artefacts.

    Through `write_records`, so every row is validated against the frozen inter-stage
    contract: a seed that drifted from the artefact schemas would otherwise test G9
    against records no upstream stage could produce.
    """
    for kind, key in _SEED_RECORDS.items():
        write_records(kind, SEED[key], lang=lang)
    write_records("analysed_sentence", _analysed(lang), lang=lang)
    _replay_bank(lang)

    runlog = RunLog(lang, run_id="0" * 32)
    for stage_id in ("g0", "g1", "g2", "g3", "g4", "g5", "g6", "g7", "g8"):
        with runlog.stage(stage_id, tool=TOOL_NAME, tool_version="test") as entry:
            for row in licences if licences is not None else SEED["licences"]:
                entry.record_licence(LicenceRow(**row))
    for validator_id in VALIDATOR_IDS:
        with runlog.stage(validator_id, tool=TOOL_NAME, tool_version="test") as entry:
            entry.note(findings=0)
    return runlog


def _replay_bank(lang: str) -> None:
    """Put the fixture's committed clip stubs where a real G8 leaves its bank.

    `baked_clip.path` is `bank/<clip_id>.opus`, RELATIVE TO G8's STAGE DIRECTORY, and G9
    copies from there into the pack. Without this the replay declared three clips and
    left the pack's `audio/` empty — which is the defect G9 now refuses, so the fixture
    has to be as honest as the gate: the bytes are the committed stubs', copied, never
    invented.
    """
    bank = stage_dir(lang, "g8")
    for clip in SEED["clips"]:
        target = bank / str(clip["path"])
        target.parent.mkdir(parents=True, exist_ok=True)
        stub = repo_root() / FIXTURE_PACK_RELPATH / "audio" / f"{clip['clip_id']}.opus"
        target.write_bytes(stub.read_bytes())


def _analysed(lang: str) -> list[dict[str, Any]]:
    """G1 records, synthesised from the seed.

    G9 does not read them — the stage used to DECLARE `analysed_sentence` in `reads`
    while `_pack_inputs` collected seven other kinds and never touched it, which is a
    declaration a reader would believe. They are still written here because a realistic
    build root has them, and because `require_successful` checks that G1 ran.
    """
    return [
        {
            "schema_version": 1,
            "sentence_id": sentence["sentence_id"],
            "lang": lang,
            "adapter": {
                "name": "spacy",
                "version": "3.8.0",
                "model": "es_core_news_md",
                "split_mode": None,
            },
            "tokens": [
                {
                    "surface": word,
                    "lemma": word.lower(),
                    "pos": "X",
                    "morph": "",
                    "start": 0,
                    "end": 1,
                }
                for word in sentence["text"].split()
            ],
            "lemmas": [word.lower() for word in sentence["text"].split()],
            "display_tokens": sentence["text"].split(),
        }
        for sentence in SEED["sentences"]
    ]


def _pack_dir(build_root: Path, lang: str = "es") -> Path:
    return build_root / lang / "g9"


# ---------------------------------------------------------------------------
# One DDL, read from the TypeScript that also ships it
# ---------------------------------------------------------------------------


def test_the_ddl_comes_from_packages_schema() -> None:
    ddl = pack_schema_ddl()
    created = {
        statement.split("CREATE TABLE ")[1].split(" ")[0]
        for statement in ddl
        if statement.startswith("CREATE TABLE ")
    }
    assert created == set(PACK_TABLES)
    assert any(statement.startswith("PRAGMA user_version") for statement in ddl)


def test_the_extractor_survives_the_comments_the_schema_actually_has() -> None:
    """`pack-schema.ts` has backticks and apostrophes inside its comments.

    This is the parser's real failure mode: a regex that stopped at the first backtick in
    a comment returns a short DDL, and a short DDL is a pack with a missing table built
    without an error.
    """
    source = "// a `backtick` and SQLite's apostrophe\nconst X = [`kept`];\n/* `also` */\n"
    assert strip_ts_comments(source) == "\nconst X = [`kept`];\n\n"
    assert "backtick" not in strip_ts_comments(source)


def test_the_extractor_does_not_read_the_type_annotation_as_the_array(tmp_path: Path) -> None:
    """`const X: readonly string[] = [...]` — the first `[` belongs to the TYPE.

    Scanning from it yields an empty array and a zero-statement DDL: a pack with no
    tables at all, built silently. This is a bug this parser actually had.
    """
    planted = tmp_path / "planted.ts"
    planted.write_text("export const X: readonly string[] = [`a`, `b`];\n", encoding="utf-8")
    assert read_ts_string_array(planted, "X") == ("a", "b")


def test_the_extractor_refuses_a_missing_or_empty_array(tmp_path: Path) -> None:
    planted = tmp_path / "planted.ts"
    planted.write_text("export const X: readonly string[] = [];\n", encoding="utf-8")
    with pytest.raises(ValueError, match="no string literals"):
        read_ts_string_array(planted, "X")
    with pytest.raises(ValueError, match="declares no"):
        read_ts_string_array(planted, "NOPE")


def test_the_insert_order_is_a_permutation_of_the_tables() -> None:
    """Insert order follows the foreign keys; the table list follows `scope2/00` §2.5."""
    assert set(PACK_INSERT_ORDER) == set(PACK_TABLES)
    assert len(PACK_INSERT_ORDER) == len(PACK_TABLES)


def test_every_table_has_a_writer() -> None:
    assert PACKBUILD.missing(PACK_TABLES) == ()


def test_a_payload_key_that_is_not_a_column_fails_the_build(tmp_path: Path) -> None:
    """The schema is read back out of SQLite, never restated here."""
    with pytest.raises(ValueError, match="has no column"):
        write_pack(tmp_path / "x.sqlite", {"meta": [{"key": "k", "value": "v", "extra": 1}]})


def test_INV_PACK_51_a_repeated_lemma_is_one_join_row(tmp_path: Path) -> None:
    """[INV-PACK-51] the join is a SET, and a sentence is not.

    `item_tags.lemmas` is the token-aligned lemma list, so `El libro está sobre la
    mesa.` carries `el` twice and `Hola, hola, hola.` carries `hola` three times — the
    artefact being faithful to the text. `exercise_item_tag`'s key is `(exercise_id,
    item_kind, item_ref)`, so the same pair twice is the same row twice. Measured on the
    real course, 2026-09-12: G9 refused the pack with `UNIQUE constraint failed:
    exercise_item_tag.exercise_id, exercise_item_tag.item_kind,
    exercise_item_tag.item_ref` — AFTER the bake, which is the expensive place to learn
    it. And `is_new` must be set by the FIRST row only, or a repeat marks the lexeme new
    twice and S032's pill logic sees two introductions.
    """
    inputs = fixture_inputs()
    first = dict(inputs.exercises[0])
    lemma = first["item_tags"]["lemmas"][0]
    first["item_tags"] = {**first["item_tags"], "lemmas": [lemma, lemma, lemma]}
    from dataclasses import replace

    grown = replace(inputs, exercises=(first, *inputs.exercises[1:]))
    rows = build_rows(grown)
    joined = [
        row
        for row in rows["exercise_item_tag"]
        if row["exercise_id"] == first["exercise_id"] and row["item_ref"] == lemma
    ]
    assert len(joined) == 1, joined
    assert joined[0]["is_new"] == 1
    # And the pack is writable, which is the property the UNIQUE key expresses.
    write_pack(tmp_path / "deduped.sqlite", rows)


def test_a_dangling_reference_fails_the_build(tmp_path: Path) -> None:
    """Foreign keys are ON: a bad `unit_id` fails here, not as an empty screen."""
    rows = build_rows(fixture_inputs())
    rows["exercise"][0] = {**rows["exercise"][0], "unit_id": "u999"}
    with pytest.raises(sqlite3.IntegrityError):
        write_pack(tmp_path / "x.sqlite", rows)


# ---------------------------------------------------------------------------
# The stage
# ---------------------------------------------------------------------------


def test_coursekit_pack_builds_a_pack(isolated_build_root: Path) -> None:
    _replay_seed()
    result = runner.invoke(app, ["pack", "es"])
    assert result.exit_code == EXIT_OK, result.output

    pack_dir = _pack_dir(isolated_build_root)
    assert (pack_dir / PACK_DB_FILENAME).exists()
    assert (pack_dir / MANIFEST_FILENAME).exists()

    rows = list(read_records("pack_row", lang="es"))
    assert {row["table"] for row in rows} <= set(PACK_TABLES)
    assert artifact_path("es", "pack_row").exists()


def test_the_pack_is_readable_and_carries_what_the_surfaces_need(
    isolated_build_root: Path,
) -> None:
    """S001 (provenance, size, CEFR claim), S002 (item count), S137, S151."""
    _replay_seed()
    assert runner.invoke(app, ["pack", "es"]).exit_code == EXIT_OK

    connection = sqlite3.connect(_pack_dir(isolated_build_root) / PACK_DB_FILENAME)
    meta = dict(connection.execute("SELECT key, value FROM meta"))
    assert meta["pack_id"] == "freelingo-es"
    assert meta["ledger_unit"] == "lemma"
    assert meta["cefr_claim"] == "A1 · CEFR-checked"
    assert float(meta["provenance_machine_authored_pct"]) > 0
    assert connection.execute("PRAGMA user_version").fetchone()[0] == PACK_SCHEMA_VERSION
    assert [key for key in meta if key.startswith(CREDITS_META_PREFIX)]
    for table in PACK_TABLES_EMPTY_AT_V0:
        assert connection.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0] == 0
    connection.close()


def test_INV_PACK_17_fails_the_stage_and_writes_nothing(isolated_build_root: Path) -> None:
    """[INV-PACK-17] an attribution-requiring sentence with no owner fails the build.

    Through the CLI, because the invariant is about the *build* refusing — a gate that
    only exists as a function somebody remembers to call is not a gate. Exit 4, and no
    pack on disk: the point of refusing is that the thing does not exist afterwards.
    """
    # Nobody ever resolved an owner for Tatoeba: not on the sentence rows, and not on the
    # run's own licence row either. A per-sentence owner missing while the SOURCE row has
    # one is not a violation — the pack writes the resolved owner into every row — so the
    # falsifier has to remove it in both places, which is the state a real build reaches
    # by reading a corpus whose terms nobody looked up.
    orphaned = [
        {**row, "attribution_owner": None} if row["source_id"] == "tatoeba" else row
        for row in SEED["licences"]
    ]
    _replay_seed(licences=orphaned)
    stripped = [
        {**sentence, "attribution_owner": None, "attribution_required": True}
        for sentence in SEED["sentences"]
    ]
    write_records("ingested_sentence", stripped, lang="es")

    result = runner.invoke(app, ["pack", "es"])
    assert result.exit_code == EXIT_FAILED, result.output
    assert "INV-PACK-17" in result.output
    assert not (_pack_dir(isolated_build_root) / PACK_DB_FILENAME).exists()


def test_the_stage_refuses_to_run_over_a_ledger_that_never_ran(
    isolated_build_root: Path,
) -> None:
    """A pack assembled from a partial ledger passes every row-level validator."""
    result = runner.invoke(app, ["pack", "es"])
    assert result.exit_code == EXIT_FAILED, result.output
    assert "no successful run" in result.output


def test_the_runlog_records_what_the_pack_contains(isolated_build_root: Path) -> None:
    """A validator downstream reads the log, not the pack."""
    _replay_seed()
    assert runner.invoke(app, ["pack", "es"]).exit_code == EXIT_OK

    from coursekit.runlog import read_entries

    entry = [row for row in read_entries("es", stage="g9") if row["status"] == "ok"][-1]
    assert entry["outputs"] == ["pack_row"]
    assert entry["notes"]["ledger_unit"] == "lemma"
    assert entry["notes"]["item_ids"] == 7
    assert entry["notes"]["tables"]["sentence"] == 6


# ---------------------------------------------------------------------------
# The committed loader fixture
# ---------------------------------------------------------------------------


def test_the_committed_fixture_is_what_this_build_produces(tmp_path: Path) -> None:
    """Rebuild the fixture from its seed and compare CONTENT, row by row.

    Content rather than bytes: two SQLite builds of the same rows are not byte-identical
    across library versions, and a byte comparison would turn a Homebrew upgrade into a
    red test and teach everybody to regenerate the fixture without reading the diff.

    Regenerate with:
        uv run python -c "from coursekit.packbuild.sqlite import build_fixture_pack as b; b()"
    """
    committed = repo_root() / FIXTURE_PACK_RELPATH / PACK_DB_FILENAME
    rebuilt = write_pack(tmp_path / PACK_DB_FILENAME, build_rows(fixture_inputs()))
    assert dump_pack(rebuilt) == dump_pack(committed)


def test_the_committed_fixture_manifest_matches_its_pack() -> None:
    """A fixture whose manifest and database disagree would fail install, not the test."""
    import hashlib

    fixture = repo_root() / FIXTURE_PACK_RELPATH
    manifest = json.loads((fixture / MANIFEST_FILENAME).read_text(encoding="utf-8"))
    payload = (fixture / PACK_DB_FILENAME).read_bytes()
    assert manifest["payloadSha256"] == hashlib.sha256(payload).hexdigest()
    assert manifest["payloadBytes"] == len(payload)

    audio = sorted(path.name for path in (fixture / "audio").iterdir() if path.is_file())
    assert len(audio) == 3
    assert manifest["audioBytes"] == sum(
        (fixture / "audio" / name).stat().st_size for name in audio
    )


def test_the_schema_file_the_fixture_was_built_from_is_the_shipped_one() -> None:
    """The fixture is only evidence while it was built from the DDL the app reads."""
    assert (repo_root() / PACK_SCHEMA_TS_RELPATH).exists()
    assert DDL_ARRAY_NAME in (repo_root() / PACK_SCHEMA_TS_RELPATH).read_text(encoding="utf-8")


# ---------------------------------------------------------------------------
# A refused build leaves nothing behind — all three gates, not just the first
# ---------------------------------------------------------------------------


def _pack_artefacts(build_root: Path) -> list[str]:
    """Everything a half-finished G9 would leave on disk, as a list of names."""
    pack_dir = _pack_dir(build_root)
    found = []
    if (pack_dir / PACK_DB_FILENAME).exists():
        found.append(PACK_DB_FILENAME)
    if (pack_dir / MANIFEST_FILENAME).exists():
        found.append(MANIFEST_FILENAME)
    audio = pack_dir / AUDIO_DIRNAME
    if audio.exists() and any(audio.iterdir()):
        found.append(f"{AUDIO_DIRNAME}/")
    if artifact_path("es", "pack_row").exists():
        found.append("pack_row")
    # A staging directory that outlived the stage is also something left behind.
    found += [entry.name for entry in pack_dir.parent.glob(f".{PACK_STAGE_ID}-*")]
    return sorted(found)


def test_the_manifest_gate_fails_the_stage_and_also_writes_nothing(
    isolated_build_root: Path,
) -> None:
    """Gate 3 refuses, and no pack survives it.

    The docstring used to say "returns ok=False on any gate, having written nothing" while
    only gate 1 ran before anything was written: `pack.sqlite`, the audio bank and the
    `pack_row` artefact were all on disk by the time the manifest was checked, so a
    refused build left a plausible pack with no manifest for the next command to find.

    The trigger is an UNRESOLVED licence on `nllb`, which gate 1 cannot see: NLLB is
    oracle-only, no shipped sentence cites it, and it is not a derived-list kind. It is
    exactly the shape `deep/10` edge case 4 names — OPUS grants no blanket licence and its
    API returns no licence field, so a row nobody resolved must never reach a manifest.
    """
    unresolved = [
        {**row, "licence": UNRESOLVED_LICENCE} if row["source_id"] == "nllb" else row
        for row in SEED["licences"]
    ]
    _replay_seed(licences=unresolved)

    result = runner.invoke(app, ["pack", "es"])
    assert result.exit_code == EXIT_FAILED, result.output
    assert "UNRESOLVED" in result.output
    assert _pack_artefacts(isolated_build_root) == []


def test_inv_pack_15_a_pack_that_declares_a_clip_it_does_not_carry_fails_the_stage(
    isolated_build_root: Path,
) -> None:
    """[INV-PACK-15] the audio gate: a declared clip with no file refuses the pack.

    This is a MEASURED field defect, not a hypothetical. Over units 1-3 of the real
    Spanish course G9 built a pack that declared 125 clips at `audio/<id>.opus`, whose
    `audio/` directory was empty, and whose manifest said `audioBytes: 0` — because G7
    named clips with one function and G8 baked them under another (D-AUDIO-ID-FUNCTION),
    so `_stage_audio_bank` found nothing to copy and copied nothing, quietly. Every
    listening exercise in that pack resolves to no file on a device, and INV-PACK-15's
    budget assertion passes trivially at zero bytes: the budget is about what a learner
    downloads, and a pack that downloads nothing is inside every budget.

    So the gate is the one that has to be pinned, and the falsifier is the state a real
    bake reaches: the bank is there, the records are there, and ONE clip is gone. One
    rather than all, so the assertion can be that the message names the missing id — a
    gate that reported only a count would leave the operator re-running the bake to find
    out which. Exit 4, and `_pack_artefacts` empty: gate 1 refuses before `_publish`, so
    no `pack.sqlite`, no manifest, no `audio/`, no `pack_row` and no staging directory
    outlives the refusal.
    """
    _replay_seed()
    orphaned = SEED["clips"][0]
    missing = stage_dir("es", "g8") / str(orphaned["path"])
    assert missing.exists(), "the replay has to put a real bank there first"
    missing.unlink()

    result = runner.invoke(app, ["pack", "es"])
    assert result.exit_code == EXIT_FAILED, result.output
    assert "INV-PACK-15" in result.output
    assert orphaned["clip_id"] in result.output, result.output
    assert _pack_artefacts(isolated_build_root) == []

    # And the runlog says which clips, so the next command does not have to guess.
    from coursekit.runlog import read_entries

    entry = [row for row in read_entries("es", stage="g9")][-1]
    assert entry["status"] != "ok"
    assert orphaned["clip_id"] in str(entry["notes"]["audio_clips_missing"])


def test_the_schema_gate_fails_the_stage_and_also_writes_nothing(
    isolated_build_root: Path,
) -> None:
    """Gate 2 refuses, and no pack survives it either.

    A dangling `exercise.audio_id` is the failure the foreign keys exist for: it is how a
    bake that dropped one clip becomes an empty screen on a device instead of a red build.

    Gate 2 RAISES rather than returning `ok=False` — a foreign key that does not resolve
    is a build bug, not a content verdict, and there is no list of them to report — so
    this asserts the exception by type. What it shares with the other two gates is the
    part that matters here: the staging directory is torn down on the way out, so a
    crashed build leaves no pack either.
    """
    _replay_seed()
    broken = [
        {**exercise, "audio_ref": "0000000000000000"} if exercise["audio_ref"] else exercise
        for exercise in SEED["exercises"]
    ]
    write_records("exercise", broken, lang="es")

    result = runner.invoke(app, ["pack", "es"])
    assert result.exit_code != EXIT_OK, result.output
    assert isinstance(result.exception, sqlite3.IntegrityError), repr(result.exception)
    assert "FOREIGN KEY" in str(result.exception)
    assert _pack_artefacts(isolated_build_root) == []


def test_the_stage_declares_only_the_artefact_kinds_it_reads() -> None:
    """A `reads` tuple is a contract a reader believes; an unread kind in it is a lie."""
    stage = STAGES.get(PACK_STAGE_ID)
    assert stage is not None
    source = (
        repo_root() / "tools/coursekit/src/coursekit/stages/g9_package.py"
    ).read_text(encoding="utf-8")
    collected = set(re.findall(r'_collect\(lang, "([a-z_]+)"\)', source))
    assert set(stage.reads) == collected
