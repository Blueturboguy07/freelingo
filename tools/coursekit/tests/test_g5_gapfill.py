"""G5 gap-fill, and the invariant whose gate is a property of the source.

**INV-PACK-10** — "Generated content that fails a filter axis is discarded and resampled,
never patched. Gate: no repair path exists in the generator."

That gate cannot be written as an assertion about output. A patched candidate carries the
same fields as one that passed, sits inside the same ledger and the same length window,
and is wrong only in the way a native reviewer notices three hundred items later. So the
test that owns this invariant parses the stage and fails on a repair-shaped identifier or
a string-mutating call, with `falsifiers/INV-PACK-10.json` beside it carrying eight
sources the scanner must reject and five it must accept — because a scanner that walks
nothing, or one that has been widened until it rejects `str.join`, both pass a test that
only ever scans the real module.

The source gate is necessary and not sufficient, so the behavioural half is here too: the
emitted texts are a subset of the authored texts, over the real 160-candidate file and
over generated ones.

**The scan is two gates of different strength.** The identifier half runs over every
module this lane owns (`LANE_SOURCES`), because a `_repair_text` helper one import away
in `engines/` satisfies the letter of a two-file scan; the string-mutator half stays on
the two stages (`GENERATOR_SOURCES`), because its argument — "nothing here has any
business building a modified copy of a string" — is true there and false in a module that
parses a rubric file and builds a URL. `test_g6_validate_language.py` carries the matching
behavioural gate for the engines: every string they are handed must be a candidate text
verbatim, which catches a repair that happens BEFORE the check and so never reaches
emitted text.
"""

from __future__ import annotations

import ast
import importlib
import json
import re
from collections import Counter
from collections.abc import Iterator
from functools import lru_cache
from pathlib import Path
from typing import Any

import pytest

from coursekit.adapters import ADAPTERS
from coursekit.artifacts import read_records, write_records
from coursekit.config.g5 import (
    MAX_TOKENS,
    MIN_CANDIDATES_PER_SLOT,
    MIN_TOKENS,
    REJECT_AXES,
)
from coursekit.inputs import MissingInput
from coursekit.runlog import RunLog, UpstreamStageMissing, read_entries
from coursekit.stages import STAGES, StageContext, StageResult
from coursekit.stages.g5_gapfill import Slot, authored_candidates_path
from coursekit.validators import VALIDATORS

PACKAGE_ROOT = Path(__file__).resolve().parents[1] / "src" / "coursekit"
FALSIFIERS = Path(__file__).parent / "falsifiers"
REPO_ROOT = Path(__file__).resolve().parents[3]
REAL_CANDIDATES = REPO_ROOT / "content" / "es" / "candidates.jsonl"

#: The two stages candidate text actually flows through. Scanned by BOTH halves of the
#: gate: repair-shaped identifiers and string-mutating calls. G6 narrows the surviving
#: set and must not edit content either, so it is held to the same rule as G5.
GENERATOR_SOURCES = (
    PACKAGE_ROOT / "stages" / "g5_gapfill.py",
    PACKAGE_ROOT / "stages" / "g6_validate_language.py",
)

#: Every other module this lane owns, scanned by the IDENTIFIER half only.
#:
#: The adversarial pass was right that a `_repair_text` helper in `engines/` or
#: `validators/` would have slipped past a gate that looked at two files. It cannot be
#: the same gate, though: the mutator half rests on an argument that is true of the two
#: stages and false here — `languagetool.py` builds a URL with `rstrip('/')`,
#: `backtranslation.py` reads a rubric file with `line.strip()`, `mock_lt.py` builds a
#: category name with `.title()`. Banning `str` methods in a module whose job is parsing
#: and HTTP would be a gate that has to be silenced, and the first thing silenced is the
#: enforcement. So the name half — which is what a repair helper would announce itself
#: with — runs everywhere in the lane, and the strict half runs where the text is.
LANE_SOURCES = (
    PACKAGE_ROOT / "engines" / "kenlm.py",
    PACKAGE_ROOT / "engines" / "languagetool.py",
    PACKAGE_ROOT / "engines" / "mock_lt.py",
    PACKAGE_ROOT / "engines" / "backtranslation.py",
    PACKAGE_ROOT / "validators" / "language.py",
    PACKAGE_ROOT / "config" / "g5.py",
    PACKAGE_ROOT / "config" / "g6.py",
)


# ---------------------------------------------------------------------------
# The scanner
# ---------------------------------------------------------------------------

#: Words that name the act the invariant forbids. Matched against IDENTIFIERS only.
REPAIR_WORDS = re.compile(
    r"repair|patch|mend|amend|salvage|rewrite|reword|sanitis|sanitiz|"
    r"correct|tweak|touchup|touch_up|(?<![a-zA-Z])fix",
    re.IGNORECASE,
)

#: `str` methods that return a different string. Calling one of these on anything is a
#: violation in these two modules: neither has a legitimate reason to build a string
#: that is a modified form of another, and a narrower rule ("only on candidate text")
#: would need to track data flow and would be the first thing to go wrong.
MUTATORS = frozenset(
    {
        "replace",
        "sub",
        "subn",
        "translate",
        "strip",
        "lstrip",
        "rstrip",
        "removeprefix",
        "removesuffix",
        "capitalize",
        "title",
        "expandtabs",
        "format",
        "format_map",
        "ljust",
        "rjust",
        "center",
        "zfill",
        "normalize",
    }
)


def repair_paths(source: str, *, mutators: bool = True) -> list[str]:
    """Every repair-shaped thing in `source`. Identifiers and calls; never prose.

    Deliberately blind to strings and comments. The module this runs against documents
    the rule it is enforcing, in English, using the word "patched" — a scanner that read
    prose would fail on the documentation of the invariant, and the obvious fix for that
    (delete the documentation) is worse than the bug.

    `mutators=False` runs the identifier half alone, for the lane modules where a `str`
    method has a job that is not rewriting a candidate (see `LANE_SOURCES`).
    """
    tree = ast.parse(source)
    found: list[str] = []

    def flag(name: str, node: ast.AST, what: str) -> None:
        if REPAIR_WORDS.search(name):
            found.append(f"line {getattr(node, 'lineno', 0)}: {what} {name!r}")

    for node in ast.walk(tree):
        if isinstance(node, ast.FunctionDef | ast.AsyncFunctionDef):
            flag(node.name, node, "function named")
        elif isinstance(node, ast.ClassDef):
            flag(node.name, node, "class named")
        elif isinstance(node, ast.Name):
            flag(node.id, node, "name")
        elif isinstance(node, ast.Attribute):
            flag(node.attr, node, "attribute")
        elif isinstance(node, ast.arg):
            flag(node.arg, node, "argument named")
        elif isinstance(node, ast.keyword) and node.arg:
            flag(node.arg, node, "keyword argument")
        elif isinstance(node, ast.alias):
            flag(node.name, node, "import")
            if node.asname:
                flag(node.asname, node, "import alias")

        if mutators and isinstance(node, ast.Call):
            func = node.func
            if isinstance(func, ast.Attribute) and func.attr in MUTATORS:
                found.append(f"line {node.lineno}: string-mutating call .{func.attr}()")
            elif isinstance(func, ast.Name) and func.id in MUTATORS:
                found.append(f"line {node.lineno}: string-mutating call {func.id}()")

    return found


# ---------------------------------------------------------------------------
# INV-PACK-10 — the gate
# ---------------------------------------------------------------------------


def test_INV_PACK_10_no_repair_path_exists_in_the_generator() -> None:
    """[INV-PACK-10] G5 and G6 contain no repair path: no edit, no patch, no rewrite."""
    offenders = {
        str(path.relative_to(PACKAGE_ROOT)): repair_paths(path.read_text(encoding="utf-8"))
        for path in GENERATOR_SOURCES
    }
    assert {name: hits for name, hits in offenders.items() if hits} == {}, (
        "a repair path exists in the generator. A candidate that fails a filter axis is "
        "discarded and resampled; the remedy for a near miss is the next candidate, "
        "never an edit to this one."
    )


def test_INV_PACK_10_no_repair_path_exists_anywhere_in_the_lane() -> None:
    """[INV-PACK-10] No module this lane owns declares a repair helper either.

    "No repair path exists in the generator" is a claim about the generator, and a
    `_repair_text` living one import away in `engines/` or `validators/` satisfies the
    letter of a two-file scan while breaking the invariant. The identifier half runs over
    every module in the lane; the mutator half stays on the two stages, where the only
    strings in play are candidate texts.
    """
    offenders = {
        str(path.relative_to(PACKAGE_ROOT)): repair_paths(
            path.read_text(encoding="utf-8"), mutators=False
        )
        for path in LANE_SOURCES
    }
    assert {name: hits for name, hits in offenders.items() if hits} == {}, (
        "a repair-shaped identifier exists in a lane module. A candidate that fails an "
        "axis is discarded and resampled wherever the code that fails it lives."
    )


def test_INV_PACK_10_the_identifier_half_alone_still_catches_a_named_repair_helper() -> None:
    """[INV-PACK-10] `mutators=False` is a narrower gate, not a disabled one.

    The lane scan drops the string-method rule. If dropping it also dropped the name
    rule, `test_INV_PACK_10_no_repair_path_exists_anywhere_in_the_lane` would pass over
    any source at all — which is the shape of every gate that quietly stopped checking.
    """
    corpus = json.loads((FALSIFIERS / "INV-PACK-10.json").read_text(encoding="utf-8"))
    named = [case for case in corpus["must_reject"] if repair_paths(case["source"], mutators=False)]
    assert len(named) >= 4, (
        "the identifier half caught fewer than four of the committed repair sources; "
        "it is not a gate on its own"
    )
    false_positives = {
        case["name"]: hits
        for case in corpus["must_accept"]
        if (hits := repair_paths(case["source"], mutators=False))
    }
    assert false_positives == {}, false_positives


def test_INV_PACK_10_the_scanner_rejects_every_falsifier() -> None:
    """[INV-PACK-10] The committed repair-shaped sources are all caught."""
    corpus = json.loads((FALSIFIERS / "INV-PACK-10.json").read_text(encoding="utf-8"))
    assert len(corpus["must_reject"]) >= 8, "the falsifier corpus has been thinned out"
    missed = [case["name"] for case in corpus["must_reject"] if not repair_paths(case["source"])]
    assert missed == [], f"the scanner did not catch: {missed}"


def test_INV_PACK_10_the_scanner_accepts_prose_and_the_shape_the_invariant_asks_for() -> None:
    """[INV-PACK-10] A gate widened until it rejects everything is not a gate.

    Five near-misses: two of them are the module explaining the rule in English, and one
    is the discard-and-resample loop the invariant is asking for. If any of these trips
    the scanner, the scanner would have to be silenced somewhere and the first thing
    silenced would be the enforcement.
    """
    corpus = json.loads((FALSIFIERS / "INV-PACK-10.json").read_text(encoding="utf-8"))
    assert len(corpus["must_accept"]) >= 5
    wrong = {
        case["name"]: repair_paths(case["source"])
        for case in corpus["must_accept"]
        if repair_paths(case["source"])
    }
    assert wrong == {}, f"false positives: {wrong}"


def test_INV_PACK_10_the_scanner_is_walking_something() -> None:
    """[INV-PACK-10] The real stage parses to a non-trivial tree.

    Without this, `repair_paths` returning [] for every input — the mode where it is
    handed an empty file, or where `ast.walk` is broken — reads as a clean pass.
    """
    source = GENERATOR_SOURCES[0].read_text(encoding="utf-8")
    tree = ast.parse(source)
    identifiers = [node.id for node in ast.walk(tree) if isinstance(node, ast.Name)] + [
        node.name for node in ast.walk(tree) if isinstance(node, ast.FunctionDef)
    ]
    assert len(identifiers) > 40, "the scanner is not seeing the module it is scanning"


# ---------------------------------------------------------------------------
# The fixture: a real Spanish analyser and a real G4 gap list
# ---------------------------------------------------------------------------


@lru_cache(maxsize=1)
def _spacy_analyser() -> Any:
    """The pinned `es_core_news_md`, wrapped in the shape G5 asks an adapter for.

    Loaded once per session: a model load is two seconds, and a per-test load turns a
    twenty-case parametrisation into a minute of nothing.
    """
    spacy = pytest.importorskip("spacy", reason="the 'nlp' dependency group is not installed")
    nlp = spacy.load("es_core_news_md")

    class Analyser:
        name = "spacy"
        version = "3.8.0"
        model = "es_core_news_md"

        def analyse(self, text: str) -> dict[str, Any]:
            doc = nlp(text)
            words = [token for token in doc if not token.is_punct and not token.is_space]
            return {
                "lemmas": [token.lemma_ for token in words],
                "tokens": [token.text for token in words],
                "display_tokens": [token.text for token in words],
            }

    return Analyser()


@pytest.fixture
def es_adapter() -> Iterator[None]:
    """Register the Spanish analyser G5 will look up, then put the registry back."""
    analyser = _spacy_analyser()
    ADAPTERS.reset_for_tests()
    ADAPTERS.add("es", lambda: analyser)
    yield
    ADAPTERS.reset_for_tests()


#: The modules this lane registers, and the registry each lands in.
LANE_REGISTRATIONS = (
    ("coursekit.stages.g5_gapfill", "g5"),
    ("coursekit.stages.g6_validate_language", "g6"),
)


def ensure_registered() -> None:
    """Put this lane's stages and validator back after `empty_registry` cleared them.

    `conftest.empty_registry` calls `Registry.reset_for_tests()`, which clears the
    entries AND the discovered flag. Re-discovery then goes through
    `importlib.import_module`, which returns the module from `sys.modules` without
    re-running `@register_stage` — so every registry stays empty for the rest of the
    session, and `STAGES.get("g5")` is `None` in a file that imported the stage at the
    top. Measured: `pytest tests/` had eleven G5 tests fail on "g5 is not registered"
    while `pytest tests/test_g5_gapfill.py` passed.

    That is a bug in `coursekit/__init__.py`, which this lane does not own, and it is
    worse than the symptom: `test_cli.py::test_discovery_finds_nothing_yet_and_that_is_
    the_correct_state` runs after those fixtures and now passes because the registry was
    emptied, not because nothing is registered. This helper is the local workaround;
    the fix belongs in `Registry.discover`.
    """
    for module_name, stage_id in LANE_REGISTRATIONS:
        if STAGES.get(stage_id) is None:
            importlib.reload(importlib.import_module(module_name))
    if VALIDATORS.get("V8") is None:
        importlib.reload(importlib.import_module("coursekit.validators.language"))


def authored_rows(path: Path) -> list[dict[str, Any]]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line]


def gap_list(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """The G4 gap list the authored file was written against.

    Derived from the file rather than committed separately, because G3/G4 have not
    landed: the authored rows carry the window they were written against and the
    `stale_ledger` axis is what catches the day the real G4 disagrees with them.
    """
    windows: dict[Slot, tuple[list[str], list[str]]] = {}
    for row in rows:
        windows[Slot.of(row["slot"])] = (row["allowed_lemmas"], row["new_lemmas"])
    return [
        {
            "schema_version": 1,
            "lang": "es",
            "unit_index": slot.unit_index,
            "lesson_index": slot.lesson_index,
            "slot_index": slot.slot_index,
            "sentence_id": None,
            "provenance": "llm",
            "gap": True,
            "new_lemmas": sorted(new),
            "known_lemmas": sorted(set(allowed) - set(new)),
            "grammar_concept": "present tense",
        }
        for slot, (allowed, new) in windows.items()
    ]


def stage_g4(lang: str, gaps: list[dict[str, Any]]) -> None:
    """Write a `selected_item` artefact and the successful G4 runlog entry G5 requires."""
    write_records("selected_item", gaps, lang=lang)
    log = RunLog(lang)
    with log.stage("g4", tool="test", tool_version="0") as entry:
        entry.record_output("selected_item")
        entry.written = len(gaps)


def run_g5(lang: str = "es", options: dict[str, str] | None = None) -> StageResult:
    ensure_registered()
    stage = STAGES.get("g5")
    assert stage is not None, "g5 is not registered"
    log = RunLog(lang)
    with log.stage("g5", tool="test", tool_version="0") as entry:
        result = stage.run(
            StageContext(lang=lang, runlog=log, entry=entry, options=dict(options or {}))
        )
        if not result.ok:
            entry.status = "failed"
    return result


@pytest.fixture
def es_course(es_adapter: None) -> Iterator[list[dict[str, Any]]]:
    """The committed Spanish candidates, with a matching gap list and a G4 entry."""
    rows = authored_rows(REAL_CANDIDATES)
    stage_g4("es", gap_list(rows))
    yield rows


# ---------------------------------------------------------------------------
# INV-PACK-10 — the behaviour
# ---------------------------------------------------------------------------


def test_INV_PACK_10_every_emitted_text_is_an_authored_text(
    es_course: list[dict[str, Any]],
) -> None:
    """[INV-PACK-10] Nothing leaves G5 as a modified form of what arrived.

    The source gate says no repair path is written here; this says none ran. Over the
    whole 160-candidate Spanish file, the set of emitted texts is a subset of the set of
    authored texts — character for character, accents included.
    """
    result = run_g5()
    emitted = {row["text"] for row in read_records("candidate", lang="es")}
    authored = {row["text"] for row in es_course}
    assert emitted <= authored, f"G5 produced text nobody authored: {sorted(emitted - authored)}"
    assert result.ok, result.message


def test_INV_PACK_10_a_candidate_one_accent_from_correct_is_discarded_not_corrected(
    es_adapter: None,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """[INV-PACK-10] The behavioural falsifier: `El jardin es grande.` stays unaccented.

    It is inside the length window, inside the register, and one combining accent away
    from a sentence the ledger already contains. Every repair path anyone would actually
    write fixes exactly this. G5 must emit it verbatim, rejected.
    """
    corpus = json.loads((FALSIFIERS / "INV-PACK-10.json").read_text(encoding="utf-8"))
    case = corpus["behavioural_falsifier"]

    rows = [row for row in authored_rows(REAL_CANDIDATES) if row["slot"]["unit_index"] == 2]
    rows = [row for row in rows if row["slot"]["lesson_index"] == 1]
    planted = dict(rows[0])
    planted["text"] = case["text"]
    planted["translation"] = "The garden is big."
    planted["backtranslation"] = dict(planted["backtranslation"])
    rows = [planted, *rows]

    _write_authored(tmp_path, monkeypatch, rows)
    stage_g4("es", gap_list(rows))
    run_g5()

    emitted = list(read_records("candidate", lang="es"))
    planted_rows = [row for row in emitted if row["text"] == case["text"]]
    assert planted_rows, "the failing candidate was dropped instead of recorded"
    assert planted_rows[0]["accepted"] is False
    assert planted_rows[0]["reject_reason"] == "out_of_vocabulary"

    # The accented form is an authored candidate of its own in this slot, so its
    # presence proves nothing on its own; what proves it is the COUNT. A repair path
    # would turn the unaccented row into a second copy of the accented one.
    assert Counter(row["text"] for row in emitted) == Counter(row["text"] for row in rows), (
        "the multiset of emitted texts is not the multiset of authored texts: something "
        "rewrote a candidate into another candidate"
    )


def _write_authored(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, rows: list[dict[str, Any]]
) -> Path:
    """Point `content/` at a tmp tree carrying `rows`, and return the file."""
    monkeypatch.setenv("COURSEKIT_CONTENT_ROOT", str(tmp_path / "content"))
    target = authored_candidates_path("es")
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(
        "\n".join(json.dumps(row, ensure_ascii=False, sort_keys=True) for row in rows) + "\n",
        encoding="utf-8",
    )
    return target


# ---------------------------------------------------------------------------
# Generate-and-reject
# ---------------------------------------------------------------------------


def test_a_rejected_candidate_is_written_not_dropped(es_course: list[dict[str, Any]]) -> None:
    """The reject rate is the number that says the ledger window is too tight.

    It is only a number if the denominator is real: every authored candidate for a gap
    slot appears in the output, kept or not.
    """
    run_g5()
    emitted = list(read_records("candidate", lang="es"))
    assert len(emitted) == len(es_course)
    assert any(row["accepted"] for row in emitted)
    assert any(not row["accepted"] for row in emitted)


def test_every_reject_reason_is_one_of_the_declared_axes(es_course: list[dict[str, Any]]) -> None:
    """A free-text reason makes the reject rate uncountable."""
    run_g5()
    reasons = {
        row["reject_reason"] for row in read_records("candidate", lang="es") if not row["accepted"]
    }
    assert reasons <= set(REJECT_AXES), f"undeclared reject reason(s): {reasons - set(REJECT_AXES)}"


def test_the_authored_file_exercises_four_of_the_five_axes(es_course: list[dict[str, Any]]) -> None:
    """Over-generation that only ever produces passes proves nothing about the filters.

    `stale_ledger` is the fifth and cannot fire here by construction — the gap list in
    this fixture is derived from the same file — so it has its own test below.
    """
    run_g5()
    counts = dict.fromkeys(REJECT_AXES, 0)
    for row in read_records("candidate", lang="es"):
        if not row["accepted"]:
            counts[row["reject_reason"]] += 1
    fired = {axis for axis, count in counts.items() if count}
    assert fired == set(REJECT_AXES) - {"stale_ledger"}, counts


def test_a_candidates_file_written_against_a_different_ledger_is_refused(
    es_adapter: None, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`stale_ledger`. Authoring is offline; G4 moves; the file must not fill anyway.

    Every axis below this one would otherwise be measured against a vocabulary the build
    no longer has, and would pass for the wrong reason.
    """
    rows = [row for row in authored_rows(REAL_CANDIDATES) if row["slot"]["unit_index"] == 1]
    rows = [row for row in rows if row["slot"]["lesson_index"] == 1]
    _write_authored(tmp_path, monkeypatch, rows)

    gaps = gap_list(rows)
    gaps[0]["known_lemmas"] = sorted({*gaps[0]["known_lemmas"], "telescopio"})
    stage_g4("es", gaps)

    result = run_g5()
    assert not result.ok
    emitted = list(read_records("candidate", lang="es"))
    assert emitted
    assert all(row["reject_reason"] == "stale_ledger" for row in emitted)


def test_a_slot_authored_below_the_overgeneration_floor_fails_the_stage(
    es_adapter: None, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Three candidates cannot survive five axes, and the alternative to failing is patching."""
    rows = [row for row in authored_rows(REAL_CANDIDATES) if row["slot"]["unit_index"] == 1][:3]
    _write_authored(tmp_path, monkeypatch, rows)
    stage_g4("es", gap_list(rows))

    result = run_g5()
    assert not result.ok
    assert str(MIN_CANDIDATES_PER_SLOT) in result.message


def test_a_slot_whose_candidates_all_fail_is_unfilled_never_least_bad(
    es_adapter: None, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Exhausting the pool is a failed stage with the slot named."""
    rows = [row for row in authored_rows(REAL_CANDIDATES) if row["slot"]["unit_index"] == 3]
    rows = [row for row in rows if row["slot"]["lesson_index"] == 1]
    # A window that admits nothing: same lemma count, none of them the authored ones.
    starved = []
    for row in rows:
        copy = dict(row)
        copy["allowed_lemmas"] = ["telescopio"]
        copy["new_lemmas"] = []
        starved.append(copy)
    _write_authored(tmp_path, monkeypatch, starved)
    stage_g4("es", gap_list(starved))

    result = run_g5()
    assert not result.ok
    assert "u3/l1/s4" in result.message
    assert all(not row["accepted"] for row in read_records("candidate", lang="es"))


def test_the_runlog_records_the_author_and_the_reject_rate(es_course: list[dict[str, Any]]) -> None:
    """`author` is an agent, not a model id, and the manifest counts off it."""
    run_g5()
    entry = read_entries("es", stage="g5")[-1]
    notes = entry["notes"]
    assert notes["discard_and_resample"] is True
    assert notes["emitted_text_is_authored_verbatim"] is True
    assert notes["reject_rate"] > 0
    assert notes["gap_slots"] == notes["filled_slots"]
    assert all("agent" in author for author in notes["author"])
    assert entry["outputs"] == ["candidate"]


def test_g5_refuses_to_run_without_a_morphology_adapter(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """No whitespace fallback. A whitespace 'lemma' makes V1 pass vacuously."""
    rows = authored_rows(REAL_CANDIDATES)
    stage_g4("es", gap_list(rows))
    ADAPTERS.reset_for_tests()
    try:
        with pytest.raises(MissingInput, match="no morphology adapter"):
            run_g5()
    finally:
        ADAPTERS.reset_for_tests()


def test_g5_refuses_to_run_before_g4(es_adapter: None) -> None:
    """`require_successful` raises rather than producing candidates over an empty gap list."""
    with pytest.raises(UpstreamStageMissing, match="g4"):
        run_g5()


# ---------------------------------------------------------------------------
# The authored file itself
# ---------------------------------------------------------------------------


def test_the_committed_spanish_file_over_generates_twenty_per_slot() -> None:
    """§S5's "over-generate ~20 per slot", asserted against the artefact."""
    rows = authored_rows(REAL_CANDIDATES)
    per_slot: dict[str, int] = {}
    for row in rows:
        per_slot[str(Slot.of(row["slot"]))] = per_slot.get(str(Slot.of(row["slot"])), 0) + 1
    assert per_slot, "content/es/candidates.jsonl is empty"
    assert all(count >= MIN_CANDIDATES_PER_SLOT for count in per_slot.values()), per_slot


# ---------------------------------------------------------------------------
# "The same path as a corpus sentence" — enforced, not asserted in a docstring
# ---------------------------------------------------------------------------

#: Names another config module could plausibly give the A1 token window, and what each
#: must equal. `config/ingest.py` is G0's and is empty today; `config/base.py` is where
#: the scaffold says a constant two stages share belongs. Neither is this lane's to
#: write, so the contract is enforced from here instead: the moment one of them declares
#: a window, it has to be G5's.
SHARED_WINDOW_SCALARS = {
    "MIN_TOKENS": MIN_TOKENS,
    "A1_MIN_TOKENS": MIN_TOKENS,
    "MIN_TOKENS_A1": MIN_TOKENS,
    "MAX_TOKENS": MAX_TOKENS,
    "A1_MAX_TOKENS": MAX_TOKENS,
    "MAX_TOKENS_A1": MAX_TOKENS,
}

#: The same window written as a pair.
SHARED_WINDOW_TUPLES = (
    "LENGTH_WINDOW",
    "TOKEN_WINDOW",
    "A1_LENGTH_WINDOW",
    "A1_TOKEN_WINDOW",
    "SENTENCE_LENGTH_WINDOW",
)

#: Config modules that are not this lane's, scanned for a second copy of the window.
OTHER_CONFIG_MODULES = (
    "coursekit.config.base",
    "coursekit.config.ingest",
    "coursekit.config.select",
    "coursekit.config.analyze",
    "coursekit.config.band",
    "coursekit.config.curriculum",
    "coursekit.config.gapfill",
    "coursekit.config.validate",
)


def test_the_length_window_cannot_drift_from_g0s() -> None:
    """G5's docstring says an authored sentence goes through G0's 3-12 A1 window.

    Today that is two numbers in `config/g5.py`, because `config/ingest.py` is an empty
    scaffold and `config/base.py` — where the repo's own rule puts a constant two stages
    share — has no length window in it. Neither file is in this lane's ownership, so the
    claim cannot be made true by importing something that does not exist yet.

    What it can be is **unfalsifiable-proof**: the moment the G0 lane declares a window
    under any of the names below, this test compares it to G5's and fails on a
    disagreement. Then the fix is one line — G5 imports it — and the drift never reaches
    a pack, which is the whole content of "a candidate re-enters through the same path as
    a corpus sentence".
    """
    found: dict[str, Any] = {}
    scanned: list[str] = []
    for module_name in OTHER_CONFIG_MODULES:
        module = importlib.import_module(module_name)
        scanned.append(module_name)
        for name, expected in SHARED_WINDOW_SCALARS.items():
            if hasattr(module, name):
                found[f"{module_name}.{name}"] = (getattr(module, name), expected)
        for name in SHARED_WINDOW_TUPLES:
            if hasattr(module, name):
                found[f"{module_name}.{name}"] = (
                    tuple(getattr(module, name)),
                    (MIN_TOKENS, MAX_TOKENS),
                )

    assert len(scanned) == len(OTHER_CONFIG_MODULES), scanned
    disagree = {where: pair for where, pair in found.items() if pair[0] != pair[1]}
    assert disagree == {}, (
        f"a second A1 length window disagrees with G5's ({MIN_TOKENS}-{MAX_TOKENS}): "
        f"{disagree}. An authored candidate is supposed to go through the SAME filter as "
        f"a corpus sentence; two windows means it does not. Delete the copy in "
        f"config/g5.py and import the shared one."
    )


def test_the_window_scan_would_see_a_constant_if_one_appeared() -> None:
    """The scan above passes trivially while every other config module is empty.

    So it is run once against a module that does declare the window — this lane's own —
    to show the lookup finds a constant when there is one to find. Without this, the G0
    lane could land `A1_MAX_TOKENS = 20` under a name nobody scans and the gate above
    would stay green for the same reason it is green today.
    """
    g5_config = importlib.import_module("coursekit.config.g5")
    hits = {
        name: getattr(g5_config, name) for name in SHARED_WINDOW_SCALARS if hasattr(g5_config, name)
    }
    assert hits == {"MIN_TOKENS": MIN_TOKENS, "MAX_TOKENS": MAX_TOKENS}


def test_every_committed_candidate_is_machine_authored_with_a_rubric_score() -> None:
    """`provenance: llm` on every row, so the manifest's percentage is a real count."""
    rows = authored_rows(REAL_CANDIDATES)
    assert {row["provenance"] for row in rows} == {"llm"}
    assert all(isinstance(row["backtranslation"]["score"], int) for row in rows)
    assert all(row["backtranslation"]["judged_by"] == "agent" for row in rows)
