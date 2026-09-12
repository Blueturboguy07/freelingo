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

import coursekit.config as coursekit_config
from coursekit.adapters import ADAPTERS
from coursekit.artifacts import read_records, write_records
from coursekit.config.g5 import (
    AUTHORED_CANDIDATES_FILENAME,
    CONTENT_ROOT_ENV_VAR,
    GAPFILL_RUBRIC_FILENAME,
    LEDGER_DIGEST_CHARS,
    MAX_TOKENS,
    MIN_CANDIDATES_PER_SLOT,
    MIN_TOKENS,
    REJECT_AXES,
)
from coursekit.inputs import MissingInput
from coursekit.runlog import RunLog, UpstreamStageMissing, read_entries
from coursekit.stages import STAGES, StageContext, StageResult
from coursekit.stages.g5_gapfill import (
    Slot,
    authored_candidates_path,
    authored_candidates_paths,
    authored_shard_dir,
    ledger_digest,
)
from coursekit.validators import VALIDATORS

PACKAGE_ROOT = Path(__file__).resolve().parents[1] / "src" / "coursekit"
FALSIFIERS = Path(__file__).parent / "falsifiers"
REPO_ROOT = Path(__file__).resolve().parents[3]
#: The G5 reject-axis fixture. **A fixture, not course content** — the name is kept
#: because `test_g6_validate_language.py` imports it, and the path moved.
#:
#: It sat at `content/es/candidates.jsonl` for a phase and was counted there as course
#: content ("8 of 918 gap slots covered"). It covered none: it numbers lessons PER UNIT
#: where G4 numbers them globally, its `allowed_lemmas` hold surface forms beside lemmas
#: (`llama`, `salgo`, `quier` — nothing lemmatised them), and its `new_lemmas` carry two
#: entries where a real gap reserves at most one. See `content/es/authoring/README.md`.
#:
#: What it IS good for is the only thing it is used for here: 160 rows whose
#: `authoring_intent` field makes four of G5's five reject axes fire on purpose. A test
#: that only ever feeds a filter things that pass is a test of nothing.
REAL_CANDIDATES = REPO_ROOT / "content" / "es" / "authoring" / "axis-fixture.jsonl"

#: The committed authoring brief — a DERIVED SNAPSHOT of one real es build, written by
#: `coursekit gaps es`. `test_gaps_command.py` owns it; it is named here so this file can
#: assert the one thing the fixture cannot: the fixture's slots are NOT real gaps.
COMMITTED_BRIEF = REPO_ROOT / "content" / "es" / "authoring" / "gap-brief.jsonl"

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
    """THE REGISTERED SPANISH ADAPTER, not a stand-in for it.

    This used to build a local `Analyser` class with `analyse(self, text)`. G5 called it
    that way, every test passed, and the contract every real adapter implements — the one
    `g1_analyze` calls and `SpacyEsAdapter` declares — is `analyse(*, sentence_id, text)`.
    So G5 raised `TypeError: SpacyEsAdapter.analyse() takes 1 positional argument but 2
    were given` the first time it was run against a registered adapter, on a real build,
    after eleven green tests. A shim that is allowed to have its own signature is a shim
    that tests itself.

    Loaded once per session: a model load is two seconds, and a per-test load turns a
    twenty-case parametrisation into a minute of nothing.
    """
    pytest.importorskip("spacy", reason="the 'nlp' dependency group is not installed")
    factory = ADAPTERS.get("es")
    assert factory is not None, "no Spanish adapter is registered; G1's lane owns it"
    return factory()


@pytest.fixture
def es_adapter(
    tmp_path_factory: pytest.TempPathFactory, monkeypatch: pytest.MonkeyPatch
) -> Iterator[None]:
    """The Spanish test environment: the analyser G5 looks up, and a staged `content/`.

    The staged content root carries the axis fixture as `candidates.jsonl` plus the
    rubric beside it, which is the layout G5 and G6 both expect. It is staged rather than
    read from the repository because the fixture deliberately does not live on G5's read
    path any more — it is not course content, and `content/es/authoring/README.md` says
    why. G6's back-translation engine reads the authored file too, so the staging has to
    outlive the G5 call and belongs here rather than inside `run_g5`.

    A test that wants a different `content/` monkeypatches `COURSEKIT_CONTENT_ROOT` over
    this one; nothing here fights that.
    """
    analyser = _spacy_analyser()
    ADAPTERS.reset_for_tests()
    ADAPTERS.add("es", lambda: analyser)

    root = tmp_path_factory.mktemp("content")
    staged = root / "es"
    staged.mkdir(parents=True, exist_ok=True)
    (staged / AUTHORED_CANDIDATES_FILENAME).write_text(
        REAL_CANDIDATES.read_text(encoding="utf-8"), encoding="utf-8"
    )
    (staged / GAPFILL_RUBRIC_FILENAME).write_text(
        (REPO_ROOT / "content" / "es" / GAPFILL_RUBRIC_FILENAME).read_text(encoding="utf-8"),
        encoding="utf-8",
    )
    # `monkeypatch`, not `os.environ` with a `finally`. Measured: the hand-rolled version
    # leaked the staged root into thirteen later tests in a full-suite run and into none
    # of them when they were run alone — the most expensive shape a test fixture has.
    monkeypatch.setenv(CONTENT_ROOT_ENV_VAR, str(root))
    try:
        yield
    finally:
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


@lru_cache(maxsize=1)
def brief_by_slot() -> dict[Slot, dict[str, Any]]:
    """The committed gap brief, keyed by slot. One parse per session."""
    out: dict[Slot, dict[str, Any]] = {}
    for line in COMMITTED_BRIEF.read_text(encoding="utf-8").splitlines():
        if not line:
            continue
        row = json.loads(line)
        if "slot_index" not in row:  # the header line
            continue
        out[Slot.of(row)] = row
    return out


def gap_list(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """The gap list `rows` was written against, derived from the fixture's own ledgers.

    This IS circular — the gaps agree with the candidates because they were built from
    them — and for the axis tests that is the right shape: they are about what G5 does
    with a candidate inside a given window, and the window has to be a parameter.

    The circularity is only dangerous when the file it reads is mistaken for course
    content, which is exactly what happened: an authored file whose gap list is derived
    from itself is consistent with a gap list that does not exist, so nothing here could
    ever have noticed that G4 numbers lessons globally. That check is not this function's
    job any more. It lives in `test_gaps_command.py`, against the ledger a real G4
    emitted, and in `test_the_fixture_is_not_mistaken_for_course_content` below.
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
    """Run the registered G5 over whatever `content/` currently holds.

    Callers get the staged content root from the `es_adapter` fixture, or point
    `COURSEKIT_CONTENT_ROOT` somewhere of their own. This helper never stages anything
    itself: a test that writes shards, an empty tree or a starved file is testing exactly
    that, and a helper that quietly supplied a fallback would make those tests pass over
    the wrong input.
    """
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
    """The axis fixture on G5's read path (staged by `es_adapter`), plus its gap list."""
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

    rows = _one_slot(2)
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
    rows = _one_slot(1)
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
    rows = _one_slot(1)[:3]
    _write_authored(tmp_path, monkeypatch, rows)
    stage_g4("es", gap_list(rows))

    result = run_g5()
    assert not result.ok
    assert str(MIN_CANDIDATES_PER_SLOT) in result.message


def test_a_slot_whose_candidates_all_fail_is_unfilled_never_least_bad(
    es_adapter: None, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Exhausting the pool is a failed stage with the slot named.

    The slot is starved on the G4 SIDE — a gap whose ledger is one word nobody wrote a
    sentence about — and the authored rows are re-stamped with that ledger's digest so
    they clear `stale_ledger` and are judged on vocabulary. Starving the authored side
    instead would only prove `stale_ledger` fires, which has its own test above.
    """
    rows = _one_slot(3)
    gaps = gap_list(rows)
    gaps[0]["known_lemmas"] = ["telescopio"]
    gaps[0]["new_lemmas"] = []
    starved_digest = ledger_digest(gaps[0]["known_lemmas"], gaps[0]["new_lemmas"])
    restamped = []
    for row in rows:
        copy = dict(row)
        copy["ledger_digest"] = starved_digest
        copy["new_lemmas"] = []
        restamped.append(copy)
    _write_authored(tmp_path, monkeypatch, restamped)
    stage_g4("es", gaps)

    result = run_g5()
    assert not result.ok
    assert str(Slot.of(rows[0]["slot"])) in result.message
    emitted = list(read_records("candidate", lang="es"))
    assert all(not row["accepted"] for row in emitted)
    assert {row["reject_reason"] for row in emitted} == {"out_of_vocabulary"}


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
#: Every config module except G5's own, enumerated from the package rather than listed.
#:
#: It WAS a list, and the list went stale the moment another lane renamed
#: `config/analyze.py` to `config/g1.py`: the scan then raised ModuleNotFoundError, which
#: is at least loud. The quieter half is the one that matters — a renamed module simply
#: stops being scanned, and the drift this gate exists to catch walks straight through it.
OTHER_CONFIG_MODULES = tuple(
    f"coursekit.config.{module.stem}"
    for module in sorted(Path(coursekit_config.__file__).parent.glob("*.py"))
    if module.stem not in {"__init__", "g5"}
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


# ---------------------------------------------------------------------------
# Sharding — four authoring lanes, four files, one gap list
# ---------------------------------------------------------------------------


def _write_shards(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    shards: dict[str, list[dict[str, Any]]],
    *,
    legacy: list[dict[str, Any]] | None = None,
) -> Path:
    """Point `content/` at a tmp tree carrying one file per shard name."""
    monkeypatch.setenv("COURSEKIT_CONTENT_ROOT", str(tmp_path / "content"))
    if legacy is not None:
        target = authored_candidates_path("es")
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(
            "\n".join(json.dumps(row, ensure_ascii=False, sort_keys=True) for row in legacy) + "\n",
            encoding="utf-8",
        )
    directory = authored_shard_dir("es")
    directory.mkdir(parents=True, exist_ok=True)
    for name, rows in shards.items():
        (directory / name).write_text(
            "\n".join(json.dumps(row, ensure_ascii=False, sort_keys=True) for row in rows) + "\n",
            encoding="utf-8",
        )
    return directory


def _one_slot(index: int) -> list[dict[str, Any]]:
    """Every authored row for the `index`-th distinct slot in the committed file (1-based).

    By POSITION, not by unit number. The slots this file names are whatever the last
    `coursekit gaps es` said they are, and a fixture that hard-coded `unit_index == 2`
    would start selecting nothing the first time the course is rebuilt at a different
    ingest cap — silently, because "no rows" reads as a passing filter.
    """
    rows = authored_rows(REAL_CANDIDATES)
    slots = list(dict.fromkeys(Slot.of(row["slot"]) for row in rows))
    assert len(slots) >= index, f"the committed file names {len(slots)} slot(s), not {index}"
    wanted = slots[index - 1]
    return [row for row in rows if Slot.of(row["slot"]) == wanted]


def test_shards_are_read_in_sorted_filename_order_and_the_legacy_file_first(
    es_adapter: None, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Read order is fill order: the first survivor fills the slot.

    So an unsorted `iterdir()` would make the shipped sentence depend on the order the
    filesystem happened to hand back, and two machines would build different courses
    from identical inputs. The legacy single file is always first, because it is the
    file that existed before anybody sharded.
    """
    slot_rows = _one_slot(1)
    half = len(slot_rows) // 2
    directory = _write_shards(
        tmp_path,
        monkeypatch,
        {"b-second.jsonl": slot_rows[half:], "a-first.jsonl": slot_rows[:half]},
        legacy=[],
    )
    paths = authored_candidates_paths("es")
    assert paths == [
        authored_candidates_path("es"),
        directory / "a-first.jsonl",
        directory / "b-second.jsonl",
    ]


def test_a_readme_in_the_shard_directory_is_not_read_as_content(
    es_adapter: None, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Only `*.jsonl`. A lane's notes beside its shard must not fail the build."""
    directory = _write_shards(tmp_path, monkeypatch, {"lane.jsonl": _one_slot(1)})
    (directory / "README.md").write_text("how this lane splits its slots\n", encoding="utf-8")
    (directory / ".gitkeep").write_text("", encoding="utf-8")
    assert authored_candidates_paths("es") == [directory / "lane.jsonl"]


def test_the_legacy_file_and_a_shard_are_read_as_one_pool(
    es_adapter: None, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Twenty candidates split across two files is still twenty, not two pools of ten."""
    slot_rows = _one_slot(1)
    half = len(slot_rows) // 2
    _write_shards(
        tmp_path,
        monkeypatch,
        {"lane.jsonl": slot_rows[half:]},
        legacy=slot_rows[:half],
    )
    stage_g4("es", gap_list(slot_rows))
    result = run_g5()
    assert result.ok, result.message
    assert len(list(read_records("candidate", lang="es"))) == len(slot_rows)
    entry = read_entries("es", stage="g5")[-1]
    assert len(entry["notes"]["authoring_files"]) == 2


def test_INV_PACK_51_two_shards_naming_the_same_slot_and_text_is_a_loud_error(
    es_adapter: None, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """[INV-PACK-51] no two ledger items share a key; here the key is (slot, text).

    Not a dedup. Both lanes believe they supplied one of that slot's twenty candidates,
    so collapsing the pair silently leaves the slot NINETEEN deep while
    `MIN_CANDIDATES_PER_SLOT` still reads twenty — and the floor is the only thing
    standing between a thin slot and a slot filled by the least-bad option. The message
    has to name both files, because "which of my four lanes wrote this" is the reader's
    only question.
    """
    slot_rows = _one_slot(1)
    _write_shards(
        tmp_path,
        monkeypatch,
        {"lane-a.jsonl": slot_rows, "lane-b.jsonl": [slot_rows[0]]},
    )
    stage_g4("es", gap_list(slot_rows))

    with pytest.raises(MissingInput) as excinfo:
        run_g5()
    message = str(excinfo.value)
    assert "lane-a.jsonl" in message
    assert "lane-b.jsonl" in message
    assert str(MIN_CANDIDATES_PER_SLOT) in message


def test_INV_PACK_51_the_same_text_for_two_different_slots_is_allowed(
    es_adapter: None, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """[INV-PACK-51] the key is (slot, text), not text.

    A gate widened to "no sentence twice anywhere" would reject content the ledger
    permits: the same short sentence can legitimately be a candidate for two slots, and
    V9's real rule is one occurrence per UNIT, which the `duplicate` axis already owns.
    """
    first = _one_slot(1)
    second = [dict(row) for row in _one_slot(3)]
    for row in second:
        row["text"] = first[0]["text"]
        row["translation"] = first[0]["translation"]
    _write_shards(tmp_path, monkeypatch, {"a.jsonl": first, "b.jsonl": second})
    rows = [*first, *second]
    assert len(_read_authored_for_test()) == len(rows)


def _read_authored_for_test() -> list[dict[str, Any]]:
    from coursekit.stages.g5_gapfill import _read_authored

    return _read_authored(authored_candidates_paths("es"), "es")


# ---------------------------------------------------------------------------
# INV-PACK-40 — one ledger, and a candidate that names a slot G4 never emitted
# ---------------------------------------------------------------------------


def test_INV_PACK_40_a_candidate_for_a_slot_that_is_not_a_gap_fails_the_stage(
    es_adapter: None, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """[INV-PACK-40] a consumer with its own notion of the ledger is refused by name.

    THE FALSIFIER, measured. G4 numbers lessons GLOBALLY across the course — unit 2 is
    lessons 7-12 — and the file that shipped for a whole phase numbered them per unit, so
    it named `u2/l1/s1` where the gap list said `u2/l7/s1`. The two key spaces never
    intersected. G5 read all 160 rows, filled nothing with them, recorded the orphans in
    a runlog note, and reported success on the gaps it did have; the phase then reported
    "8 of 918 slots covered" when the true figure was zero.

    So: an authored slot that is not in G4's gap list is a FAILED stage that names the
    slot, and the message says which key space is the real one.
    """
    real = _one_slot(1)
    stray = [dict(row) for row in real]
    for row in stray:
        row["slot"] = {"unit_index": 2, "lesson_index": 1, "slot_index": 1}
    _write_shards(tmp_path, monkeypatch, {"lane.jsonl": [*real, *stray]})
    stage_g4("es", gap_list(real))

    result = run_g5()
    assert not result.ok
    assert "u2/l1/s1" in result.message
    assert "GLOBAL lesson index" in result.message
    entry = read_entries("es", stage="g5")[-1]
    assert entry["notes"]["orphan_authored_slots"] == ["u2/l1/s1"]


def test_INV_PACK_40_the_orphan_check_does_not_fire_on_a_file_that_matches(
    es_adapter: None, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """[INV-PACK-40] a gate that always fires is a gate nobody can satisfy."""
    rows = _one_slot(1)
    _write_shards(tmp_path, monkeypatch, {"lane.jsonl": rows})
    stage_g4("es", gap_list(rows))
    result = run_g5()
    assert result.ok, result.message
    assert read_entries("es", stage="g5")[-1]["notes"]["orphan_authored_slots"] == []


def test_INV_PACK_40_the_ledger_a_row_names_is_a_digest_not_a_copy_of_the_set() -> None:
    """[INV-PACK-40] one declaration of the ledger, and a witness rather than a copy.

    The allowed set at a late unit is 928 lemmas — measured on the committed brief. The
    axis used to demand that every candidate spell that list out, which is the same list
    written 9,800 times (~47 MB of candidate files) and, worse, a list a hurried author
    edits until the row passes. `ledger_digest` is 16 characters, it is what
    `coursekit gaps` prints, and it cannot be edited into agreement with a ledger it does
    not describe.

    Asserted on the CONTRACT, not on a file: `_AUTHORED_REQUIRED` is what G5 demands of
    every row it will ever read, including the ones the four authoring lanes have not
    written yet.
    """
    from coursekit.stages.g5_gapfill import _AUTHORED_REQUIRED

    assert "ledger_digest" in _AUTHORED_REQUIRED
    assert "allowed_lemmas" not in _AUTHORED_REQUIRED
    for row in authored_rows(REAL_CANDIDATES):
        assert len(row["ledger_digest"]) == LEDGER_DIGEST_CHARS
        assert row["ledger_digest"] == ledger_digest(
            set(row["allowed_lemmas"]) - set(row["new_lemmas"]), row["new_lemmas"]
        )


def test_the_fixture_is_not_mistaken_for_course_content() -> None:
    """The fixture names no real gap slot, and it must not live where G5 looks.

    THIS IS THE REGRESSION TEST FOR THE PHASE'S MOST EXPENSIVE BUG. 160 hand-written rows
    sat at `content/es/candidates.jsonl` and were reported as 0.9% of the course's
    authoring done. They were 0%: they key lessons per unit where G4 keys them globally,
    their `allowed_lemmas` hold surface forms (`llama`, `salgo`, `quier`) that no
    lemmatiser produced, and their `new_lemmas` carry two entries where a real gap
    reserves at most one.

    So two claims: the file is not on G5's read path, and its slots are not gaps.
    """
    from coursekit.stages.g5_gapfill import (
        AUTHORED_CANDIDATES_DIRNAME,
        AUTHORED_CANDIDATES_FILENAME,
        content_root,
    )

    es = content_root() / "es"
    assert es / AUTHORED_CANDIDATES_FILENAME != REAL_CANDIDATES
    assert REAL_CANDIDATES.parent != es / AUTHORED_CANDIDATES_DIRNAME

    rows = authored_rows(REAL_CANDIDATES)
    fixture_slots = {Slot.of(row["slot"]) for row in rows}
    brief = brief_by_slot()
    assert brief, "the committed brief is empty"

    # Most of its keys name nothing — it numbers lessons per unit, G4 numbers them
    # globally — and a couple collide with a real gap by coincidence, because unit 1's
    # lessons ARE lessons 1 and 2 in both schemes. Coincidence is not coverage.
    assert not fixture_slots <= set(brief), (
        "every fixture slot is a real gap; the file is course content after all and the "
        "reasoning in content/es/authoring/README.md needs redoing"
    )

    # For the ones that do collide, the ledger settles it. The fixture's window is not
    # the window G4 emits for that slot, so G5 rejects those rows as `stale_ledger`
    # rather than filling a real slot from a file nobody built against a real corpus.
    for slot in sorted(fixture_slots & set(brief), key=str):
        declared = next(row for row in rows if Slot.of(row["slot"]) == slot)["ledger_digest"]
        assert declared != brief[slot]["ledger_digest"], (
            f"{slot}: the fixture's ledger matches the real one, so these rows would "
            f"fill a shipping slot"
        )

    assert any(len(row["new_lemmas"]) > 1 for row in rows), (
        "the fixture no longer carries a two-new-lemma row, so it no longer exercises "
        "the budget axis and its incompatibility with a real gap is no longer visible"
    )


def test_INV_PACK_12_no_authored_file_at_all_names_both_places_it_looked(
    es_adapter: None, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """[INV-PACK-12] the missing input is NAMED — both the legacy path and the shards.

    "no authored candidates" with one path in it sends an author who sharded to the
    wrong file, which is a slower failure than no message at all.
    """
    monkeypatch.setenv("COURSEKIT_CONTENT_ROOT", str(tmp_path / "content"))
    stage_g4("es", gap_list(_one_slot(1)))
    with pytest.raises(MissingInput) as excinfo:
        run_g5()
    message = str(excinfo.value)
    assert "candidates.jsonl" in message
    assert "candidates/*.jsonl" in message
    assert "coursekit gaps es" in message


def test_INV_PACK_12_g5_calls_the_adapter_the_way_every_other_stage_does(
    es_adapter: None,
) -> None:
    """[INV-PACK-12] the analyser is a per-language INPUT, and its contract is one contract.

    THE REGRESSION TEST FOR A BUG THAT SURVIVED ELEVEN GREEN TESTS. G5 called
    `analyser.analyse(text)`; `g1_analyze` calls `adapter.analyse(sentence_id=..., text=...)`,
    which is what `SpacyEsAdapter` declares. No registered adapter accepts the first form,
    so G5 raised `TypeError: SpacyEsAdapter.analyse() takes 1 positional argument but 2
    were given` the first time it met one — found by running the stage against a real
    build, not by the suite, because the suite supplied a shim with G5's signature.

    Two claims, because the fixture alone only proves today's adapter works: `analyse` is
    keyword-only over exactly `sentence_id` and `text`, and the record it returns carries
    the two keys G5 reads.
    """
    import inspect

    factory = ADAPTERS.get("es")
    assert factory is not None
    adapter = factory()
    parameters = inspect.signature(adapter.analyse).parameters
    assert list(parameters) == ["sentence_id", "text"]
    assert all(
        parameter.kind is inspect.Parameter.KEYWORD_ONLY for parameter in parameters.values()
    ), "a positional `text` lets a stage call it the way G5 used to and be right by accident"

    record = adapter.analyse(sentence_id="a" * 16, text="Mi hermano tiene un libro.")
    assert record["lemmas"]
    assert record["display_tokens"]
    # `display_tokens` is the word count G5's `length` axis uses; `tokens` carries
    # punctuation with offsets and would make the 3-12 window a different window.
    assert len(record["display_tokens"]) <= len(record["tokens"])
