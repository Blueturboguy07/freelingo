"""G9 — Package: the read-only SQLite pack, the audio bank, and the signed manifest.

The last stage before a learner. Everything upstream produced records; this turns them
into the one artefact that leaves the build machine, and it is the last place a licence
problem can still be stopped for free.

Three gates run here, in this order; each one fails the stage rather than warning, and
**none of them leaves a pack behind**. The database, the audio bank and the manifest are
assembled in a sibling temp directory and moved into place only once gate 3 has passed,
because a stage that refuses a pack and leaves `pack.sqlite` on disk has not refused it:
the next command to look at that directory finds a plausible pack with no manifest.

1. **INV-PACK-17** — every sentence, voice and derived list whose licence requires
   attribution has a non-empty owner reachable from the credits surface. An
   attribution-requiring asset with no reachable credit is a licence violation, so it
   fails the build. (`packbuild.attribution`.)
2. **The schema** — rows are inserted through the DDL that `packages/schema` owns, with
   foreign keys ON, so a dangling reference fails here instead of becoming an empty
   screen on a device. (`packbuild.sqlite`.)
3. **The manifest** — the fields `install.ts` requires, item ids that are content hashes,
   `ledgerUnit` declared exactly once (INV-PACK-40), the bank inside the 120 MB budget
   for all three pipelines (INV-PACK-15), and no `UNRESOLVED` licence row.
   (`packbuild.manifest`.)

What this stage does NOT do is sign. `coursekit sign` is its own command because the
private key exists only as a CI secret, and a stage that signed as a side effect would
be a stage nobody could run locally.
"""

from __future__ import annotations

import shutil
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any

from ..artifacts import read_records, stage_dir, write_records
from ..config import ARTIFACT_SCHEMA_VERSION, BUILD_STAGE_IDS, PACK_STAGE_ID, VALIDATOR_IDS
from ..config.g9 import AUDIO_DIRNAME, PACK_DB_FILENAME
from ..packbuild.attribution import attribution_violations
from ..packbuild.manifest import build_manifest, manifest_violations, write_manifest
from ..packbuild.sqlite import PackInputs, build_rows, row_id_for, write_pack
from ..runlog import licences_seen, read_entries, require_successful
from . import StageContext, StageResult, register_stage

#: The stages whose records G9 reads. G5 and G6 leave no record of their own (a
#: candidate that was accepted is already in the ledger by G7), so they are not listed.
_UPSTREAM = ("g0", "g1", "g2", "g3", "g4", "g7", "g8")


def _validator_report(lang: str) -> dict[str, Any]:
    """The validator suite's own account of itself, from the runlog.

    Read from the log rather than re-run here: `coursekit validate` is a separate command
    with its own exit code, and a stage that re-ran the validators would be a second
    opinion nobody asked for. A validator with no entry is reported as `not-run`, which
    is the state the S002 validator-report summary must be able to show — "clean" and
    "never ran" being the two things a report must never confuse.
    """
    entries = {entry["stage"]: entry for entry in read_entries(lang)}
    report: dict[str, Any] = {}
    for validator_id in VALIDATOR_IDS:
        entry = entries.get(validator_id)
        report[validator_id] = {
            "status": "not-run" if entry is None else str(entry["status"]),
            "findings": 0 if entry is None else int(entry["notes"].get("findings", 0)),
        }
    return report


def _collect(lang: str, kind: str) -> tuple[dict[str, Any], ...]:
    return tuple(read_records(kind, lang=lang))


def _pack_inputs(ctx: StageContext) -> PackInputs:
    lang = ctx.lang
    options = ctx.options
    return PackInputs(
        lang=lang,
        pack_id=options.get("pack_id", f"freelingo-{lang}"),
        course_id=options.get("course_id", f"en-{lang}"),
        major=int(options.get("major", "0")),
        version=options.get("version", "0.1.0"),
        sentences=_collect(lang, "ingested_sentence"),
        lemmas=_collect(lang, "banded_lemma"),
        units=_collect(lang, "unit_assignment"),
        selected=_collect(lang, "selected_item"),
        candidates=_collect(lang, "candidate"),
        exercises=_collect(lang, "exercise"),
        clips=_collect(lang, "baked_clip"),
        licences=tuple(licences_seen(lang)),
        validator_report=_validator_report(lang),
        defect_rate=(float(options["defect_rate"]) if "defect_rate" in options else None),
    )


def _stage_audio_bank(
    lang: str, clips: tuple[dict[str, Any], ...], destination: Path
) -> tuple[int, list[str]]:
    """Copy the baked clips into the pack's own `audio/` directory, content-addressed.

    Copied rather than referenced: a pack is one directory that can be zipped, uploaded
    to a GitHub release and unpacked into a device's cache, and a bank that lived in the
    bake's run directory would ship as a set of broken paths.

    `baked_clip.path` IS `bank/<clip_id>.opus` AND IT IS RELATIVE TO G8'S STAGE
    DIRECTORY. It used to be resolved as `Path(str(clip["path"]))` — relative to the
    process's working directory — so `source.exists()` was false for every clip and the
    function copied NOTHING, counted nothing, and said nothing. Measured on the real
    course, 2026-09-12: a pack whose `audio` table declared 125 clips at
    `audio/<id>.opus`, whose `audio/` directory was empty, and whose manifest said
    `audioBytes: 0` — so INV-PACK-15's assertion against the budget was being made about
    zero bytes, and every listening exercise on the device would have hit S151's
    missing-file path.

    Returns `(copied, missing)`. A declared clip whose file is not there is returned
    rather than skipped: the caller turns it into a failed stage, because a pack that
    declares audio it does not carry is the partial pack the six-state enum exists to
    keep off a device.
    """
    bank_root = stage_dir(lang, "g8")
    destination.mkdir(parents=True, exist_ok=True)
    copied = 0
    missing: list[str] = []
    for clip in clips:
        source = bank_root / str(clip["path"])
        target = destination / f"{clip['clip_id']}.opus"
        if not source.exists():
            missing.append(f"{clip['clip_id']} ({source})")
            continue
        if source.resolve() != target.resolve():
            shutil.copyfile(source, target)
            copied += 1
    return copied, missing


def _publish(staging: Path, pack_dir: Path) -> Path:
    """Move a fully-built pack from the staging directory into the stage directory.

    `os.replace` per entry rather than a directory rename, because the stage directory
    already exists (the runlog lives in it) and may hold the previous build's pack. The
    audio bank is replaced wholesale: a stale clip left over from an earlier bake is a
    file the manifest does not describe and the signature does not cover.
    """
    pack_dir.mkdir(parents=True, exist_ok=True)
    audio = pack_dir / AUDIO_DIRNAME
    if audio.exists():
        shutil.rmtree(audio)
    for entry in sorted(staging.iterdir()):
        target = pack_dir / entry.name
        if entry.is_dir():
            shutil.copytree(entry, target)
        else:
            shutil.copyfile(entry, target)
    return pack_dir / PACK_DB_FILENAME


@register_stage(
    PACK_STAGE_ID,
    reads=(
        "ingested_sentence",
        "banded_lemma",
        "unit_assignment",
        "selected_item",
        "candidate",
        "exercise",
        "baked_clip",
    ),
    writes=("pack_row",),
)
def package(ctx: StageContext) -> StageResult:
    """Assemble the pack. Returns `ok=False` on any gate, having written nothing.

    "Nothing" is literal and is tested: `tests/test_g9_package.py` asserts an empty pack
    directory after each of the three gates fails, not just after the first.
    """
    require_successful(ctx.lang, [stage for stage in _UPSTREAM if stage in BUILD_STAGE_IDS])
    inputs = _pack_inputs(ctx)
    for row in inputs.licences:
        source_id = str(row.get("source_id", ""))
        if source_id:
            ctx.entry.record_input(source_id)

    # Gate 1: INV-PACK-17. Before a byte is written, because the point of a build gate is
    # that the thing it refuses does not exist afterwards.
    licence_failures = attribution_violations(inputs)
    if licence_failures:
        ctx.entry.note(attribution_violations=licence_failures)
        return StageResult(
            ok=False,
            message=(
                f"{len(licence_failures)} asset(s) require attribution with no reachable "
                f"credit (INV-PACK-17): {licence_failures[0]}"
            ),
            detail={"violations": licence_failures},
        )

    rows_by_table = build_rows(inputs)

    # Everything from here on is written into a staging directory beside the real one and
    # moved in one step at the end. `pack_row` included: the artefact is the record of a
    # pack that exists, and a refused build produced none.
    pack_dir = ctx.dir
    with TemporaryDirectory(prefix=f".{PACK_STAGE_ID}-", dir=pack_dir.parent) as staging_root:
        staging = Path(staging_root)

        # Gate 2: the schema. Foreign keys are ON inside `write_pack`.
        database = write_pack(staging / PACK_DB_FILENAME, rows_by_table)
        clips_copied, clips_missing = _stage_audio_bank(
            ctx.lang, inputs.clips, staging / AUDIO_DIRNAME
        )
        if clips_missing:
            ctx.entry.note(audio_clips_missing=clips_missing[:20])
            return StageResult(
                ok=False,
                message=(
                    f"{len(clips_missing)} baked clip(s) the pack declares are not in "
                    f"G8's bank, so the pack would ship an `audio` table whose files do "
                    f"not exist and a manifest asserting 0 bytes against the 120 MB "
                    f"budget (INV-PACK-15): {clips_missing[0]}"
                ),
                detail={"missing": len(clips_missing)},
            )

        # Gate 3: the manifest.
        manifest = build_manifest(inputs, database, audio_dir=staging / AUDIO_DIRNAME)
        manifest_failures = manifest_violations(manifest)
        if manifest_failures:
            ctx.entry.note(manifest_violations=manifest_failures)
            return StageResult(
                ok=False,
                message=f"{len(manifest_failures)} manifest violation(s): {manifest_failures[0]}",
                detail={"violations": manifest_failures},
            )
        write_manifest(staging, manifest)

        # Every gate passed. Now, and only now, does a pack exist.
        database = _publish(staging, pack_dir)

    # The `pack_row` artefact: the last record before SQLite, and what the manifest, the
    # attribution table and the signature are computed over.
    records = [
        {
            "schema_version": ARTIFACT_SCHEMA_VERSION,
            "lang": ctx.lang,
            "table": table,
            "row_id": row_id_for(table, row),
            "payload": dict(row),
        }
        for table, rows in rows_by_table.items()
        for row in rows
    ]
    written = write_records("pack_row", records, lang=ctx.lang)
    ctx.entry.record_output("pack_row")

    ctx.entry.read = sum(
        len(part)
        for part in (inputs.sentences, inputs.lemmas, inputs.units, inputs.exercises, inputs.clips)
    )
    ctx.entry.written = written
    ctx.entry.note(
        pack_bytes=manifest["payloadBytes"],
        audio_bytes=manifest["audioBytes"],
        audio_clips=clips_copied,
        item_ids=len(manifest["itemIds"]),
        ledger_unit=manifest["ledgerUnit"],
        provenance=manifest["provenance"],
        tables={table: len(rows) for table, rows in rows_by_table.items()},
    )
    return StageResult(
        ok=True,
        message=f"{written} pack rows, {len(manifest['itemIds'])} items",
        detail={"database": str(database)},
    )
