"""`coursekit gaps` — the authoring brief, and the rule that it may never enforce.

Two claims live here and they pull in opposite directions, which is why they are in one
file.

**The brief must be complete and correct.** Every gap G4 emitted gets one row, no filled
slot does, and each row's `ledger_digest` is the digest G5 will check against — the same
function, imported, not a second implementation.

**The brief must have no authority.** It is a DERIVED SNAPSHOT. G5 enforces
`stale_ledger` against the ledger G4 emits in the build being run, and if the brief could
also enforce, a stale brief and a stale candidates file would agree with each other and
disagree with the course. That is the "consumer with its own inlined notion" INV-PACK-40
forbids, so the test that no stage imports this module is as load-bearing as the ones
that check its contents.
"""

from __future__ import annotations

import ast
import json
from pathlib import Path
from typing import Any

import pytest
from typer.testing import CliRunner

from coursekit.artifacts import read_records, write_records
from coursekit.cli import app
from coursekit.commands.gaps import brief_path, gap_brief
from coursekit.config import EXIT_MISSING_INPUT, EXIT_OK, EXIT_USAGE
from coursekit.config.g5 import (
    GAP_BRIEF_FILENAME,
    GAP_BRIEF_KIND,
    MIN_CANDIDATES_PER_SLOT,
)
from coursekit.inputs import MissingInput
from coursekit.runlog import RunLog
from coursekit.stages.g5_gapfill import content_root, ledger_digest

PACKAGE_ROOT = Path(__file__).resolve().parents[1] / "src" / "coursekit"
REPO_ROOT = Path(__file__).resolve().parents[3]
COMMITTED_BRIEF = REPO_ROOT / "content" / "es" / "authoring" / GAP_BRIEF_FILENAME

runner = CliRunner()


# ---------------------------------------------------------------------------
# A small build: three units, some gaps, some filled slots
# ---------------------------------------------------------------------------


def _unit(index: int, *, target: list[str]) -> dict[str, Any]:
    return {
        "schema_version": 1,
        "lang": "es",
        "section_index": 1,
        "section_cefr": "A1",
        "unit_index": index,
        "unit_title": f"Unit {index} title",
        "function": f"unit {index} function",
        "grammar_concept": f"concept-{index}",
        "register_slot": "n/a",
        "target_lemmas": target,
        "recycled_lemmas": [],
        "level_count": 1,
    }


def _slot(
    unit: int,
    lesson: int,
    slot: int,
    *,
    gap: bool,
    known: list[str],
    new: list[str],
) -> dict[str, Any]:
    return {
        "schema_version": 1,
        "lang": "es",
        "unit_index": unit,
        "lesson_index": lesson,
        "slot_index": slot,
        "sentence_id": None if gap else "0" * 16,
        "provenance": "llm" if gap else "corpus",
        "gap": gap,
        "new_lemmas": new,
        "known_lemmas": known,
        "grammar_concept": f"concept-{unit}",
        "accepted_alternates": [],
    }


@pytest.fixture
def small_build() -> list[dict[str, Any]]:
    """Two units, a GLOBAL lesson index, three gaps among five slots."""
    units = [_unit(1, target=["uno", "dos"]), _unit(2, target=["tres", "cuatro"])]
    slots = [
        _slot(1, 1, 0, gap=False, known=["uno"], new=["dos"]),
        _slot(1, 1, 1, gap=True, known=["uno", "dos"], new=["tres"]),
        _slot(1, 1, 2, gap=True, known=["dos", "uno"], new=["tres"]),
        # Unit 2's lessons continue the GLOBAL count — this is the fact the authored
        # file got wrong for a whole phase, so the fixture states it.
        _slot(2, 2, 0, gap=True, known=["dos", "tres", "uno"], new=["cuatro"]),
        _slot(2, 2, 1, gap=False, known=["uno"], new=[]),
    ]
    write_records("unit_assignment", units, lang="es")
    write_records("selected_item", slots, lang="es")
    log = RunLog("es")
    with log.stage("g0", tool="test", tool_version="0") as entry:
        entry.written = 1234
        entry.note(max_pairs=200000)
    with log.stage("g4", tool="test", tool_version="0") as entry:
        entry.record_output("selected_item")
        entry.written = len(slots)
        entry.note(slots=len(slots), gap_fraction=0.6)
    return slots


# ---------------------------------------------------------------------------
# Completeness
# ---------------------------------------------------------------------------


def test_every_gap_gets_one_row_and_no_filled_slot_does(
    small_build: list[dict[str, Any]],
) -> None:
    rows, header = gap_brief("es")
    assert [row["slot"] for row in rows] == ["u1/l1/s1", "u1/l1/s2", "u2/l2/s0"]
    assert header["gap_slots"] == 3
    assert header["candidates_required_total"] == 3 * MIN_CANDIDATES_PER_SLOT


def test_the_row_carries_what_an_author_cannot_get_anywhere_else(
    small_build: list[dict[str, Any]],
) -> None:
    """Slot, ledger, concept, and the unit's title and function — in one line.

    Split across two artefacts these are unusable: `selected_item` has the slot and the
    ledger and no title, `unit_assignment` has the title and no slots. Joining them by
    hand for 918 slots is the step an author skips.
    """
    rows, _ = gap_brief("es")
    row = rows[-1]
    assert row["unit_index"] == 2
    assert row["lesson_index"] == 2
    assert row["unit_title"] == "Unit 2 title"
    assert row["function"] == "unit 2 function"
    assert row["grammar_concept"] == "concept-2"
    assert row["new_lemmas"] == ["cuatro"]
    assert row["known_lemmas"] == ["dos", "tres", "uno"]
    assert row["token_window"] == [3, 12]


def test_the_header_names_the_build_it_is_a_snapshot_of(
    small_build: list[dict[str, Any]],
) -> None:
    """A snapshot with no build named is a document nobody can date."""
    _, header = gap_brief("es")
    assert header["kind"] == GAP_BRIEF_KIND
    assert header["max_pairs"] == 200000
    assert header["ingested"] == 1234
    assert header["slots"] == 5
    assert header["g4_run_id"]
    assert "G5 never reads this file" in header["what"]


# ---------------------------------------------------------------------------
# INV-PACK-40 — one ledger, one definition of it
# ---------------------------------------------------------------------------


def test_INV_PACK_40_the_brief_digest_is_g5s_own_function_not_a_second_one(
    small_build: list[dict[str, Any]],
) -> None:
    """[INV-PACK-40] every token-counting consumer reads the declared ledger.

    The brief tells an author which 16 characters to copy onto a candidate and G5 decides
    whether that candidate is stale. If those two strings came from two implementations
    of "digest a lemma set", they would agree until the day one of them sorted
    differently — and the failure would read as `stale_ledger` on correctly authored
    content, which is the most expensive false alarm this pipeline can raise.
    """
    rows, _ = gap_brief("es")
    for row in rows:
        assert row["ledger_digest"] == ledger_digest(row["known_lemmas"], row["new_lemmas"])

    source = (PACKAGE_ROOT / "commands" / "gaps.py").read_text(encoding="utf-8")
    tree = ast.parse(source)
    imported = {
        alias.name
        for node in ast.walk(tree)
        if isinstance(node, ast.ImportFrom) and node.module == "..stages.g5_gapfill"
        for alias in node.names
    } | {
        alias.name
        for node in ast.walk(tree)
        if isinstance(node, ast.ImportFrom) and (node.module or "").endswith("g5_gapfill")
        for alias in node.names
    }
    assert "ledger_digest" in imported, (
        "commands/gaps.py must IMPORT G5's digest, never re-implement it"
    )
    assert "def ledger_digest" not in source


def test_INV_PACK_40_the_digest_is_over_the_set_and_moves_when_the_set_moves() -> None:
    """[INV-PACK-40] the falsifier: a ledger that changed must not digest the same.

    Order is not part of the ledger; membership is. So a reordered ledger is the same
    ledger, and a ledger one lemma different is a different one — which is what makes a
    cap change invalidate every candidate authored against the old cap, by name.
    """
    known = ["casa", "perro", "gato"]
    new = ["verde"]
    assert ledger_digest(known, new) == ledger_digest(sorted(known, reverse=True), new)
    assert ledger_digest(known, new) == ledger_digest([*known, *new], [])
    assert ledger_digest(known, new) != ledger_digest([*known, "azul"], new)
    assert ledger_digest(known, new) != ledger_digest(known, ["azul"])


def test_INV_PACK_40_no_stage_or_validator_reads_the_brief() -> None:
    """[INV-PACK-40] the brief is input for people; the enforcer is `stale_ledger`.

    A second file that a stage consults is a second declaration of the ledger. The gate
    is a grep over every stage and validator for this module and for the brief's
    filename, because "G5 never reads it" is a claim about code, not about intent.
    """
    offenders: dict[str, list[str]] = {}
    for directory in ("stages", "validators", "engines", "packbuild", "sources"):
        for path in sorted((PACKAGE_ROOT / directory).rglob("*.py")):
            source = path.read_text(encoding="utf-8")
            hits = []
            tree = ast.parse(source)
            for node in ast.walk(tree):
                if isinstance(node, ast.ImportFrom) and "gaps" in (node.module or "").split("."):
                    hits.append(f"imports {node.module}")
                if isinstance(node, ast.Constant) and node.value == GAP_BRIEF_FILENAME:
                    hits.append(f"names {GAP_BRIEF_FILENAME}")
            if hits:
                offenders[str(path.relative_to(PACKAGE_ROOT))] = hits
    assert offenders == {}, offenders


# ---------------------------------------------------------------------------
# INV-PACK-12 — a missing input is named, never guessed at
# ---------------------------------------------------------------------------


def test_INV_PACK_12_a_build_with_no_units_fails_loudly_and_says_which_stage() -> None:
    """[INV-PACK-12] no G3 means no titles; the brief says so rather than omitting them."""
    write_records(
        "selected_item",
        [_slot(1, 1, 0, gap=True, known=["uno"], new=["dos"])],
        lang="es",
    )
    with pytest.raises(MissingInput) as excinfo:
        gap_brief("es")
    assert "--only g3" in str(excinfo.value)


def test_INV_PACK_12_a_build_with_no_g4_is_not_a_course_with_no_gaps() -> None:
    """[INV-PACK-12] "nothing to author" and "nothing was built" must not read alike."""
    write_records("unit_assignment", [_unit(1, target=["uno"])], lang="es")
    with pytest.raises(MissingInput) as excinfo:
        gap_brief("es")
    assert "no G4 selection" in str(excinfo.value)


def test_INV_PACK_12_a_gap_in_a_unit_g3_never_assigned_is_two_builds_mixed(
    small_build: list[dict[str, Any]],
) -> None:
    """[INV-PACK-12] the differently-shaped-input case: two artefacts, two builds."""
    write_records(
        "selected_item",
        [*read_records("selected_item", lang="es"), _slot(9, 9, 0, gap=True, known=[], new=["x"])],
        lang="es",
    )
    with pytest.raises(MissingInput) as excinfo:
        gap_brief("es")
    assert "different builds" in str(excinfo.value)


# ---------------------------------------------------------------------------
# The CLI
# ---------------------------------------------------------------------------


def test_the_verb_writes_the_brief_beside_the_content(
    small_build: list[dict[str, Any]],
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("COURSEKIT_CONTENT_ROOT", str(tmp_path / "content"))
    result = runner.invoke(app, ["gaps", "es"])
    assert result.exit_code == EXIT_OK, result.output
    written = brief_path("es")
    assert written == tmp_path / "content" / "es" / "authoring" / GAP_BRIEF_FILENAME
    lines = written.read_text(encoding="utf-8").splitlines()
    assert json.loads(lines[0])["kind"] == GAP_BRIEF_KIND
    assert len(lines) == 1 + 3


def test_no_write_prints_and_touches_nothing(
    small_build: list[dict[str, Any]],
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("COURSEKIT_CONTENT_ROOT", str(tmp_path / "content"))
    result = runner.invoke(app, ["gaps", "es", "--no-write"])
    assert result.exit_code == EXIT_OK, result.output
    assert not brief_path("es").exists()
    assert json.loads(result.output.splitlines()[0])["kind"] == GAP_BRIEF_KIND


def test_an_unknown_language_is_a_usage_error_not_an_empty_brief() -> None:
    result = runner.invoke(app, ["gaps", "xx"])
    assert result.exit_code == EXIT_USAGE


def test_a_build_that_never_ran_exits_3(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("COURSEKIT_CONTENT_ROOT", str(tmp_path / "content"))
    result = runner.invoke(app, ["gaps", "es"])
    assert result.exit_code == EXIT_MISSING_INPUT


# ---------------------------------------------------------------------------
# The committed snapshot
# ---------------------------------------------------------------------------


def test_the_committed_es_brief_is_internally_consistent() -> None:
    """The file four authoring lanes work from says what it is and adds up.

    It is generated, so this is not a test of the generator: it is a test that the
    committed copy was not hand-edited. A brief somebody adjusted by hand is a brief
    whose digests no longer match its ledgers, and every candidate written from it would
    then fail `stale_ledger` with no explanation in sight.
    """
    lines = COMMITTED_BRIEF.read_text(encoding="utf-8").splitlines()
    header = json.loads(lines[0])
    rows = [json.loads(line) for line in lines[1:]]

    assert header["kind"] == GAP_BRIEF_KIND
    assert header["lang"] == "es"
    assert header["gap_slots"] == len(rows)
    assert header["candidates_required_total"] == len(rows) * MIN_CANDIDATES_PER_SLOT
    assert header["max_pairs"], "the snapshot does not say which ingest cap produced it"

    for row in rows:
        assert row["ledger_digest"] == ledger_digest(row["known_lemmas"], row["new_lemmas"])
        assert row["known_lemmas"] == sorted(set(row["known_lemmas"]))
        assert len(row["new_lemmas"]) <= 1
        assert not (set(row["new_lemmas"]) & set(row["known_lemmas"]))

    keys = [(row["unit_index"], row["lesson_index"], row["slot_index"]) for row in rows]
    assert len(set(keys)) == len(keys), "a slot appears twice in the brief"


def test_the_committed_brief_lives_where_the_authoring_lanes_look() -> None:
    """`content/es/authoring/`, beside the rubric — not in `build/`, which is gitignored."""
    assert COMMITTED_BRIEF.is_file()
    assert COMMITTED_BRIEF.parent.parent == content_root() / "es"


# ---------------------------------------------------------------------------
# B9(b) — the brief prints the window the stage will enforce, per slot
# ---------------------------------------------------------------------------


def _banded_lemma(lemma: str, pos: str, rank: int) -> dict[str, Any]:
    return {
        "schema_version": 1,
        "lang": "es",
        "lemma": lemma,
        "pos": pos,
        "rank": rank,
        "frequency": 1000 - rank,
        "decile": 1,
        "band": "A1",
        "band_source": "frequency_decile",
        "band_source_licence": None,
    }


@pytest.fixture
def verbless_build() -> list[dict[str, Any]]:
    """One unit, two gap slots, and a G2 lexicon in which only one of them has a verb.

    Shaped after the real `u1/l1`: the window is the unit's first chunk of target
    lexemes, and whether it can hold a verb is decided by the lexicon's UD tag, not by
    anything the curriculum says about the lesson.
    """
    units = [_unit(1, target=["hola", "bueno", "ser"])]
    slots = [
        _slot(1, 1, 0, gap=True, known=["bueno"], new=["hola"]),
        _slot(1, 2, 0, gap=True, known=["bueno", "hola"], new=["ser"]),
    ]
    write_records("unit_assignment", units, lang="es")
    write_records("selected_item", slots, lang="es")
    write_records(
        "banded_lemma",
        [
            _banded_lemma("bueno", "ADJ", 1),
            _banded_lemma("hola", "PROPN", 2),
            _banded_lemma("ser", "AUX", 3),
        ],
        lang="es",
    )
    log = RunLog("es")
    with log.stage("g0", tool="test", tool_version="0") as entry:
        entry.written = 10
        entry.note(max_pairs=1000)
    with log.stage("g4", tool="test", tool_version="0") as entry:
        entry.record_output("selected_item")
        entry.written = len(slots)
        entry.note(slots=len(slots), gap_fraction=1.0)
    return slots


def test_the_token_window_is_per_slot_and_names_the_verbless_case(
    verbless_build: list[dict[str, Any]],
) -> None:
    """`[1, 12]` for the window with no verb, `[3, 12]` for the one with `ser`.

    The brief printed one course-wide `[3, 12]` on every row before this. An author
    reading it had no way to know that `u1/l1`'s nine slots admit a one-word fixed
    phrase, which is exactly why those nine went unauthored through two rounds while
    every other slot in the course got its twenty.
    """
    rows, header = gap_brief("es")
    assert [(row["slot"], row["token_window"], row["verbless_window"]) for row in rows] == [
        ("u1/l1/s0", [1, 12], True),
        ("u1/l2/s0", [3, 12], False),
    ]
    assert header["verbless_slots"] == 1


def test_a_brief_written_before_g2_shows_the_strict_window_everywhere(
    small_build: list[dict[str, Any]],
) -> None:
    """No `banded_lemma` artefact means no proof, and no proof means the strict floor.

    `small_build` stages G3 and G4 and no G2, which is the shape every other test in this
    file uses — so this is also the assertion that the new lookup did not make the brief
    depend on a stage it has no business requiring.
    """
    rows, header = gap_brief("es")
    assert {tuple(row["token_window"]) for row in rows} == {(3, 12)}
    assert {row["verbless_window"] for row in rows} == {False}
    assert header["verbless_slots"] == 0


def test_the_brief_uses_g5s_own_predicate_rather_than_a_second_copy() -> None:
    """Same rule as the digest: one implementation, imported.

    A brief that computed the window itself would be the second inlined notion
    INV-PACK-40 is about — one file telling an author 1 while the stage enforced 3 is how
    twenty candidates get written and then rejected on length.
    """
    source = (PACKAGE_ROOT / "commands" / "gaps.py").read_text(encoding="utf-8")
    tree = ast.parse(source)
    imported = {
        alias.name
        for node in ast.walk(tree)
        if isinstance(node, ast.ImportFrom)
        for alias in node.names
    }
    assert "min_tokens_for_slot" in imported
    assert "pos_by_lemma" in imported
    assert "VERBAL_POS" not in source, "the brief is deciding verblessness itself"
