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
    MAX_NEW_LEMMAS_PER_ITEM,
    MAX_TOKENS,
    MIN_CANDIDATES_PER_SLOT,
    MIN_TOKENS,
    MIN_TOKENS_VERBLESS_LESSON,
    REJECT_AXES,
    min_tokens_for_slot,
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
    pos_by_lemma,
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


def test_an_emitted_candidate_carries_the_analysis_g7_will_read(
    es_course: list[dict[str, Any]],
) -> None:
    """`analysis` is G5's own adapter pass, not a shape G7 has to reconstruct.

    Founder ruling B16 option 2. G7 used to resolve a gap by the SURFACE at the gap
    index, which for an authored sentence meant no analysis at all — empty POS, band
    `unbanded`, zero distractors, stage stopped on `tardes` (a surface) where `tarde`
    (the lemma) was wanted. So every row the analyser actually ran on carries the pass
    forward, and `write_records` would already have refused the row if the field were
    absent; what this test adds is that the field is the REAL analysis and not a
    schema-shaped filler. Asserted against a second, independent call to the same
    registered adapter over the same text.
    """
    run_g5()
    analyser = ADAPTERS.get("es")()
    for row in read_records("candidate", lang="es"):
        if row["reject_reason"] == "stale_ledger":
            continue
        carried = row["analysis"]
        assert carried is not None, row["candidate_id"]
        expected = analyser.analyse(sentence_id=row["candidate_id"], text=row["text"])
        assert carried["analyser"] == expected["adapter"]
        assert carried["tokens"] == expected["tokens"]
        assert carried["lemmas"] == expected["lemmas"]
        assert carried["display_tokens"] == expected["display_tokens"]
        # The projection is exactly `CandidateAnalysis`: G1's identity fields are the
        # candidate's own and must not be duplicated onto it.
        assert set(carried) == {"analyser", "tokens", "lemmas", "display_tokens"}


def test_a_stale_row_carries_a_null_analysis_because_the_analyser_never_ran(
    es_adapter: None, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Nullable, not optional — and null for a reason, not as a default.

    `stale_ledger` short-circuits above the adapter call, so there is no pass to carry.
    The row is still WRITTEN (the reject rate is the number that says the ledger window
    is too tight), which is why the field is `null` here rather than missing, and why no
    downstream consumer may treat a present `analysis` key as a non-null one.
    """
    rows = _one_slot(1)
    _write_authored(tmp_path, monkeypatch, rows)

    gaps = gap_list(rows)
    gaps[0]["known_lemmas"] = sorted({*gaps[0]["known_lemmas"], "telescopio"})
    stage_g4("es", gaps)

    run_g5()
    emitted = list(read_records("candidate", lang="es"))
    assert emitted
    assert all(row["reject_reason"] == "stale_ledger" for row in emitted)
    assert all(row["analysis"] is None for row in emitted)


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


# ---------------------------------------------------------------------------
# B9(b) — the per-lesson length floor, and the nine slots it exists for
# ---------------------------------------------------------------------------

#: `content/es/candidates/u01-l01.jsonl`, this lane's shard: `u1/l1/s0 … s8`, twenty
#: candidates each. Named here rather than discovered so a renamed file is a failing test
#: and not a silently unchecked one.
LESSON_ONE_SHARD = REPO_ROOT / "content" / "es" / "candidates" / "u01-l01.jsonl"

#: Every authored file that is course content (the fixture above is not).
COMMITTED_SHARDS = tuple(
    sorted((REPO_ROOT / "content" / "es" / "candidates").glob("*.jsonl"))
) + tuple(path for path in [REPO_ROOT / "content" / "es" / "candidates.jsonl"] if path.is_file())

#: The window G4 emits for every slot of `u1/l1`, measured off the committed brief. Five
#: lemmas, no verb, which is the whole of blocker B9.
LESSON_ONE_WINDOW = frozenset({"bueno", "día", "hola", "noche", "tarde"})

#: The nine slots this lane authored.
LESSON_ONE_SLOTS = frozenset(Slot(1, 1, index) for index in range(9))

def _ledger_lemmas(analysis: dict[str, Any]) -> list[str]:
    """The analysis's lemmas, and nothing on top of them any more.

    This used to apply a local copy of founder ruling B9(a)'s prenominal table
    (`PRENOMINAL_BUENO = {buen, buena, buenos, buenas} -> bueno`) because the ruling was
    landing in another lane's files (`adapters/spacy_es.py`,
    `config/g1.LEMMA_NORMALISATION_ES`) and this one needed to say what "in vocabulary"
    would mean once it had. It landed at the P2 round-3 integration, the adapter now
    normalises both traps this file had measured, and a second copy of a normalisation
    table in a test is a second source of truth for the thing INV-PACK-40 is about — so
    the table is gone and the helper is the identity on `lemmas`, kept because thirty
    call sites read it and because the name says which field is the ledger's.
    """
    return list(analysis["lemmas"])


def authored_shard(path: Path) -> list[dict[str, Any]]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line]


def test_min_tokens_for_slot_relaxes_only_a_window_that_cannot_hold_a_verb() -> None:
    """B9(b)'s predicate, over the four cases that decide a slot's floor."""
    verbless = {"bueno": "ADJ", "día": "NOUN", "hola": "PROPN", "noche": "NOUN", "tarde": "NOUN"}
    assert min_tokens_for_slot(["bueno", "día"], ["hola"], verbless) == MIN_TOKENS_VERBLESS_LESSON

    with_verb = {**verbless, "ser": "AUX"}
    assert min_tokens_for_slot(["bueno", "ser"], ["hola"], with_verb) == MIN_TOKENS
    assert min_tokens_for_slot(["bueno"], ["ser"], with_verb) == MIN_TOKENS, (
        "the NEW lemma is inside the window too; a slot reserved to teach a verb is not "
        "a verbless slot"
    )
    assert min_tokens_for_slot(["comer"], [], {"comer": "VERB"}) == MIN_TOKENS


def test_min_tokens_for_slot_keeps_the_strict_floor_when_it_cannot_prove_verblessness() -> None:
    """An unknown tag and an empty window both keep `MIN_TOKENS`.

    The failure direction is the whole design. A floor that drops because a lemma was
    missing from the lexicon admits a one-word candidate into a lesson that could have
    held a sentence, and nothing downstream can tell that apart from a lesson that had to
    be words. The empty window is sharper still: an empty `known | new` is the B1a defect
    — every gap row G4 emitted carried `known_lemmas: []` — and rewarding it with the
    loosest possible length axis would have turned that silent bug into 918 one-word
    "lessons" that every gate downstream would have accepted.
    """
    assert min_tokens_for_slot(["bueno", "grumo"], [], {"bueno": "ADJ"}) == MIN_TOKENS
    assert min_tokens_for_slot([], [], {}) == MIN_TOKENS
    assert min_tokens_for_slot(["bueno"], [], {}) == MIN_TOKENS


def test_the_verbless_floor_is_relaxed_only_on_a_proved_window_over_10k_draws() -> None:
    """B9(b)'s predicate as a PROPERTY, at the plan's floor of `PROPERTY_RUNS` draws.

    The seven example cases above pin both failure directions on hand-picked windows. This
    is the shape the plan's §Verification asks for at a decision this cheap to get wrong:
    `min_tokens_for_slot` is the one place in the pipeline that can lower a gate, and the
    thing that must never happen is a relaxation on a window nobody proved verbless.

    Both implications, over random (window, lexicon) pairs drawn from a vocabulary that
    deliberately mixes verbal tags, non-verbal tags and UNTAGGED lemmas:

    * `floor < MIN_TOKENS` ⟹ the window is non-empty AND every lemma in it carries a tag
      in the lexicon AND no tag is in `VERBAL_POS`. This is the direction that ships bad
      content, so it is asserted as a biconditional rather than trusted.
    * the converse: an empty window, one untagged lemma, or one verbal tag ⟹ `MIN_TOKENS`.
    * the return value is one of exactly two integers. A floor of 2 is not in the ruling,
      and an arithmetic floor (`len(window) - 1`, say) would satisfy both implications on
      some draws and is excluded here rather than left to a reviewer.

    `base_min_tokens` is varied too: the predicate must return the CALLER's strict floor,
    not the module constant, or rerouting the axis through `ledger.length_window` for `ja`
    (a `(4, 18)` window — see the blocker entry) would silently keep enforcing 3.
    """
    import random

    from coursekit.config.g5 import VERBAL_POS
    from coursekit.config.g7 import PROPERTY_RUNS

    # A vocabulary whose tags span the three outcomes that matter. `hola` is `PROPN` and
    # `sí` is `INTJ` because those are the real tags of the two lemmas lesson 1 turns on.
    tagged = {
        "bueno": "ADJ", "día": "NOUN", "hola": "PROPN", "noche": "NOUN", "tarde": "NOUN",
        "sí": "INTJ", "no": "ADV", "por": "ADP", "favor": "NOUN", "adiós": "INTJ",
        "ser": "AUX", "estar": "AUX", "haber": "AUX", "comer": "VERB", "hablar": "VERB",
    }
    untagged = ("grumo", "zarpe", "flunco")
    vocabulary = sorted(tagged) + list(untagged)

    rng = random.Random(20260912)
    seen_relaxed = 0
    seen_strict = 0
    for _run in range(PROPERTY_RUNS):
        size = rng.randint(0, 6)
        window = rng.sample(vocabulary, size)
        rng.shuffle(window)
        split = rng.randint(0, len(window))
        known, new = window[:split], window[split:]
        # The lexicon is a SUBSET of the tags, so a tagged lemma can also be missing from
        # the lexicon this call is handed — which is the `pos_by_lemma.get(...) is None`
        # branch arriving by draw rather than by construction.
        lexicon = {
            lemma: tag
            for lemma, tag in tagged.items()
            if rng.random() < 0.85
        }
        base = rng.choice((MIN_TOKENS, 4, 7))

        floor = min_tokens_for_slot(known, new, lexicon, base_min_tokens=base)

        assert floor in {MIN_TOKENS_VERBLESS_LESSON, base}, (floor, base, known, new)

        tags = [lexicon.get(lemma) for lemma in set(window)]
        provably_verbless = bool(window) and all(
            tag is not None and tag not in VERBAL_POS for tag in tags
        )
        if floor < base:
            seen_relaxed += 1
            assert provably_verbless, (
                f"the floor dropped to {floor} on a window nobody proved verbless: "
                f"known={known} new={new} tags={tags}"
            )
            assert floor == MIN_TOKENS_VERBLESS_LESSON
        else:
            seen_strict += 1
            assert not provably_verbless, (
                f"the floor stayed at {floor} on a provably verbless window: "
                f"known={known} new={new} tags={tags}"
            )

    # A property that only ever drew one side of the branch proves nothing about the other.
    assert seen_relaxed > 0 and seen_strict > 0, (seen_relaxed, seen_strict)


def test_the_verbless_floor_is_derived_from_the_ledger_and_cannot_be_declared() -> None:
    """There is no per-lesson override anywhere: the only input is the slot's own window.

    B9's option 3 as written ("a per-lesson `MIN_TOKENS` of 1 for a lesson whose window
    has no verb") is one keystroke from a config table a curriculum author can set, and a
    course that could declare `min_tokens: 1` for a lesson that teaches `ser` would ship
    one-word items for a lesson that can hold a sentence. So the signature is the gate:
    `min_tokens_for_slot` takes the two lemma lists G4 emitted and the G2 lexicon, and
    nothing else, and no config module names a per-lesson minimum.
    """
    import inspect

    parameters = inspect.signature(min_tokens_for_slot).parameters
    assert list(parameters) == ["known_lemmas", "new_lemmas", "pos_by_lemma", "base_min_tokens"]

    for module_name in OTHER_CONFIG_MODULES + ("coursekit.config.g5",):
        module = importlib.import_module(module_name)
        for name in dir(module):
            if "MIN_TOKENS" not in name:
                continue
            value = getattr(module, name)
            assert not isinstance(value, dict), (
                f"{module_name}.{name} is a per-key minimum token count. The verbless "
                f"floor is derived from the ledger; a table lets a curriculum declare it."
            )


def test_the_length_window_cannot_drift_from_the_per_pack_window() -> None:
    """G5's 3-12 must be `coursekit.ledger.length_window("es")`, which is the real one.

    The window is PER PACK — `config/g1.LENGTH_WINDOW_BY_LANGUAGE` is `(3, 12)` for the
    Latin-script languages and `(4, 18)` for `ja`, because a Mode-A morpheme is a smaller
    unit than a lemma. G5's own two constants are therefore right for `es`/`fr`/`de` and
    WRONG for `ja`; that is recorded in `docs/owned/p2r3-gapfill-lesson1.json` (under
    `blockers`) rather than fixed here, and it is recorded THERE rather than in
    `docs/P2-BLOCKERS.md` because this lane does not own that file — `config/g5.py`'s
    comment on `MIN_TOKENS` names the same destination. Rerouting the axis changes the
    window of every G5 test and belongs in the round that lands the Japanese pack. This
    test is what stops the es numbers drifting apart in the meantime, and it names the
    mismatch so it cannot be rediscovered.
    """
    from coursekit.ledger import length_window

    assert length_window("es") == (MIN_TOKENS, MAX_TOKENS)
    assert length_window("ja") != (MIN_TOKENS, MAX_TOKENS), (
        "if ja's window becomes 3-12, delete the ja paragraph from config/g5.py and the "
        "ja blocker entry from docs/owned/p2r3-gapfill-lesson1.json rather than leaving "
        "a warning about a thing that is no longer true"
    )


# ---------------------------------------------------------------------------
# B9(b) — the behaviour, over a staged verbless slot
# ---------------------------------------------------------------------------


def _lesson_one_gap(slot_index: int, new_lemmas: list[str]) -> dict[str, Any]:
    """A `selected_item` gap row shaped exactly like the ones G4 emits for `u1/l1`."""
    return {
        "schema_version": 1,
        "lang": "es",
        "unit_index": 1,
        "lesson_index": 1,
        "slot_index": slot_index,
        "sentence_id": None,
        "provenance": "llm",
        "gap": True,
        "new_lemmas": new_lemmas,
        "known_lemmas": sorted(LESSON_ONE_WINDOW - set(new_lemmas)),
        "grammar_concept": "subject_pronouns",
    }


def _banded(lemma: str, pos: str, rank: int) -> dict[str, Any]:
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


def _stage_lexicon(pairs: dict[str, str]) -> None:
    """Write the G2 artefact `pos_by_lemma` reads, one row per lemma."""
    write_records(
        "banded_lemma",
        [_banded(lemma, pos, rank) for rank, (lemma, pos) in enumerate(sorted(pairs.items()), 1)],
        lang="es",
    )


def _authored(
    slot_index: int,
    new_lemmas: list[str],
    text: str,
    known: list[str] | None = None,
) -> dict[str, Any]:
    """One authored row for a `u1/l1` slot, digested over the window it names.

    `known` is a parameter because the digest is the first axis G5 evaluates: a test that
    widens the gap's window and leaves the row's digest alone gets `stale_ledger`, not the
    axis it was written about. (Measured, on this change, which is the axis order working.)
    """
    window = sorted(LESSON_ONE_WINDOW - set(new_lemmas)) if known is None else sorted(known)
    return {
        "slot": {"unit_index": 1, "lesson_index": 1, "slot_index": slot_index},
        "ledger_digest": ledger_digest(window, new_lemmas),
        "new_lemmas": list(new_lemmas),
        "text": text,
        "translation": "Hello.",
        "author": "test",
        "generated_at": "2026-09-12",
        "provenance": "llm",
        "backtranslation": {
            "back_translation": "Hello.",
            "score": 4,
            "judged_by": "agent",
            "rubric_version": "1",
        },
    }


VERBLESS_LEXICON = {
    "bueno": "ADJ",
    "día": "NOUN",
    "hola": "PROPN",
    "noche": "NOUN",
    "tarde": "NOUN",
}


def test_a_one_word_fixed_phrase_fills_a_verbless_slot(
    es_adapter: None, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`Hola.` is one display token and it fills `u1/l1/s0`. That is the whole of B9(b).

    Before this, the same row was rejected `length` — three tokens of
    `{bueno, día, hola, noche, tarde}` is a word list, and two independent authoring
    lanes wrote the same eleven word lists and refused to ship them. The slot stayed
    empty for two rounds and `coursekit build es` exited 4 at G5.
    """
    _write_shards(
        tmp_path,
        monkeypatch,
        {"lesson-one.jsonl": [_authored(0, ["hola"], "Hola.")] * MIN_CANDIDATES_PER_SLOT},
    )
    stage_g4("es", [_lesson_one_gap(0, ["hola"])])
    _stage_lexicon(VERBLESS_LEXICON)

    result = run_g5()
    assert result.ok, result.message
    accepted = [row for row in read_records("candidate", lang="es") if row["accepted"]]
    assert [row["text"] for row in accepted] == ["Hola."]


def test_the_same_one_word_candidate_is_rejected_when_the_window_holds_a_verb(
    es_adapter: None, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The falsifier for the relaxation: add `ser` to the lexicon and `Hola.` is `length`.

    Same candidate, same text, same slot; the only thing that moves is whether the
    permitted window contains a lemma the lexicon tags `AUX`. A relaxation that could not
    be switched off by the ledger would not be derived from it.
    """
    with_ser = sorted([*(LESSON_ONE_WINDOW - {"hola"}), "ser"])
    _write_shards(
        tmp_path,
        monkeypatch,
        {
            "lesson-one.jsonl": [_authored(0, ["hola"], "Hola.", known=with_ser)]
            * MIN_CANDIDATES_PER_SLOT
        },
    )
    gap = _lesson_one_gap(0, ["hola"])
    gap["known_lemmas"] = with_ser
    stage_g4("es", [gap])
    _stage_lexicon({**VERBLESS_LEXICON, "ser": "AUX"})

    result = run_g5()
    assert not result.ok
    assert "exhausted every candidate" in result.message
    rows = list(read_records("candidate", lang="es"))
    assert {row["reject_reason"] for row in rows} == {"length"}


def test_INV_PACK_10_the_verbless_floor_is_a_window_and_never_a_patch(
    es_adapter: None, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """[INV-PACK-10] A rejected short candidate is discarded; nothing is padded to fit.

    The cheap wrong fix for B9 is a repair: pad `Hola.` out to three tokens, or drop a
    token off a twelve-token candidate. Both would turn the gate green and both are what
    the invariant forbids, and neither is visible in the output — a padded sentence
    carries the same fields as one that passed. So the behavioural half is asserted here
    over the boundary the relaxation moved: with the STRICT floor in force, every emitted
    text is still a text somebody authored, character for character.
    """
    with_ser = sorted([*(LESSON_ONE_WINDOW - {"hola"}), "ser"])
    authored = [
        _authored(0, ["hola"], "Hola.", known=with_ser),
        *[_authored(0, ["hola"], "Hola, buenas tardes.", known=with_ser)]
        * (MIN_CANDIDATES_PER_SLOT - 1),
    ]
    _write_shards(tmp_path, monkeypatch, {"lesson-one.jsonl": authored})
    gap = _lesson_one_gap(0, ["hola"])
    gap["known_lemmas"] = with_ser
    stage_g4("es", [gap])
    _stage_lexicon({**VERBLESS_LEXICON, "ser": "AUX"})

    run_g5()
    emitted = {row["text"] for row in read_records("candidate", lang="es")}
    assert emitted <= {row["text"] for row in authored}
    assert "Hola." in emitted, "the rejected row is WRITTEN, not dropped: it is the count"


def test_the_runlog_says_which_slots_got_the_relaxed_floor_and_whether_it_asked(
    es_adapter: None, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`verbless_slots` and `lexicon_pos_rows`, because they fail the same way.

    "No verb in the window" and "no G2 lexicon to ask" both produce the strict floor, and
    afterwards they must not read the same. `lexicon_pos_rows: 0` is the second one.
    """
    _write_shards(
        tmp_path,
        monkeypatch,
        {"lesson-one.jsonl": [_authored(0, ["hola"], "Hola.")] * MIN_CANDIDATES_PER_SLOT},
    )
    stage_g4("es", [_lesson_one_gap(0, ["hola"])])
    _stage_lexicon(VERBLESS_LEXICON)
    run_g5()
    notes = [entry for entry in read_entries("es", stage="g5")][-1]["notes"]
    assert notes["verbless_slots"] == ["u1/l1/s0"]
    assert notes["lexicon_pos_rows"] == len(VERBLESS_LEXICON)
    assert notes["min_tokens_verbless_lesson"] == MIN_TOKENS_VERBLESS_LESSON
    assert notes["token_window"] == [MIN_TOKENS, MAX_TOKENS]


def test_a_build_with_no_g2_lexicon_keeps_the_strict_floor_and_says_so(
    es_adapter: None, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """No `banded_lemma` artefact is not an error, and it is not the relaxed floor either."""
    _write_shards(
        tmp_path,
        monkeypatch,
        {"lesson-one.jsonl": [_authored(0, ["hola"], "Hola.")] * MIN_CANDIDATES_PER_SLOT},
    )
    stage_g4("es", [_lesson_one_gap(0, ["hola"])])
    assert pos_by_lemma("es") == {}

    result = run_g5()
    assert not result.ok, "with no lexicon the window cannot be proved verbless"
    notes = [entry for entry in read_entries("es", stage="g5")][-1]["notes"]
    assert notes["verbless_slots"] == []
    assert notes["lexicon_pos_rows"] == 0


# ---------------------------------------------------------------------------
# The authored lesson-one shard itself
# ---------------------------------------------------------------------------


def test_the_lesson_one_shard_covers_nine_slots_at_twenty_each() -> None:
    """`u1/l1/s0 … s8`, twenty candidates each, and the twenty are distinct.

    Distinct matters more here than anywhere else in the course. The window is five
    lemmas wide, so the cheapest way to reach twenty is the same string twenty times —
    which satisfies `MIN_CANDIDATES_PER_SLOT` and gives the reject loop nothing to
    resample from, i.e. defeats the floor while counting as it.
    """
    rows = authored_shard(LESSON_ONE_SHARD)
    per_slot: dict[str, list[str]] = {}
    for row in rows:
        per_slot.setdefault(str(Slot.of(row["slot"])), []).append(row["text"])
    assert sorted(per_slot) == [f"u1/l1/s{index}" for index in range(9)]
    for slot, texts in per_slot.items():
        assert len(texts) == MIN_CANDIDATES_PER_SLOT, (slot, len(texts))
        assert len(set(texts)) == MIN_CANDIDATES_PER_SLOT, (slot, "a repeated candidate")


def test_the_lesson_one_shard_carries_the_ledger_digest_g4_emits_for_that_window() -> None:
    """Every row's digest is `ledger_digest` over `{bueno, día, hola, noche, tarde}`.

    All nine slots of `u1/l1` share one window — `known | new` is the same five lemmas
    whichever of them the slot is reserved to teach — so they share one digest, and this
    recomputes it rather than copying the string out of the brief. A candidates file that
    agreed with a brief that disagreed with the course is the shape INV-PACK-40 forbids.
    """
    expected = ledger_digest(sorted(LESSON_ONE_WINDOW), [])
    rows = authored_shard(LESSON_ONE_SHARD)
    assert {row["ledger_digest"] for row in rows} == {expected}
    assert brief_by_slot()[Slot(1, 1, 0)]["ledger_digest"] == expected


def test_the_lesson_one_shard_declares_the_new_lemma_g4_reserved_for_each_slot() -> None:
    """`new_lemmas` is copied from G4's gap row, not chosen by the author.

    G4 deals unit 1's target lexemes across its lessons in authored order and reserves
    the head of what is still pending to each gap slot, so `s0 … s4` reserve `hola`,
    `bueno`, `día`, `tarde`, `noche` in that order and `s5 … s8` reserve nothing. The
    `stale_ledger` axis compares this set, not just the digest: same window, a different
    idea of which lemmas are new, is still a stale row.
    """
    reserved = {index: brief_by_slot()[Slot(1, 1, index)]["new_lemmas"] for index in range(9)}
    assert reserved[0] == ["hola"] and reserved[8] == []
    for row in authored_shard(LESSON_ONE_SHARD):
        slot = Slot.of(row["slot"])
        assert row["new_lemmas"] == reserved[slot.slot_index], slot


def test_INV_PACK_06_exactly_one_candidate_per_lesson_one_slot_is_inside_its_window(
    es_adapter: None,
) -> None:
    """[INV-PACK-06] V1/V2 from the authoring side, over this lane's nine ship texts.

    The claim is about the row G5 FILLS EACH SLOT WITH, because that is the row the
    learner meets: every lemma of it is inside `known | new`, and it carries the lemma G4
    reserved for that slot. Measured with the pinned `es_core_news_md`, per row, here —
    not asserted from the authoring notes.

    **This test used to say "exactly one in-window candidate per slot", and the
    integration that landed B9(a) is what changed it.** The reasoning then: G5 fills a
    slot with the FIRST accepted candidate, `g7_expand.py::_load` built its map with
    `candidates[key] = row` over every accepted row and so expanded the LAST, and content
    that accepts once per slot is content for which the two agree. B9(a)'s
    lemma-normalisation table then brought three more of this shard's rows into the window
    (`Buenas noches.`, `¡Buenas tardes!`, `Buenos días, buenas tardes.` — all previously
    out-of-vocabulary rejects), `s0` accepted four, and G7 expanded a word list where the
    course teaches `hola`. The fix is in the stage, not in the content:
    `_load` is `setdefault` now, pinned by
    `test_the_slot_is_expanded_from_the_candidate_G5_filled_it_with_not_the_last_one`
    with its falsifier. So this test asserts the property that survives — the fill is the
    first in-window row and it is the intended one — and no longer a count that a lemma
    table can move.

    The walk is G5's own: slots in order, rows in shard order, a text already accepted
    earlier in the unit is a `duplicate` reject and cannot fill a later slot. That is why
    `s1 … s8` see one accepted row each and `s0` sees four.
    """
    analyser = _spacy_analyser()
    reserved = {index: brief_by_slot()[Slot(1, 1, index)]["new_lemmas"] for index in range(9)}
    rows_by_slot: dict[int, list[dict[str, Any]]] = {index: [] for index in range(9)}
    for row in authored_shard(LESSON_ONE_SHARD):
        rows_by_slot[Slot.of(row["slot"]).slot_index].append(row)

    seen: set[str] = set()
    fills: dict[int, str] = {}
    in_window_counts: dict[int, int] = {}
    for index in range(9):
        in_window = [
            row["text"]
            for row in rows_by_slot[index]
            if set(_ledger_lemmas(analyser.analyse(sentence_id="0" * 16, text=row["text"])))
            <= LESSON_ONE_WINDOW
        ]
        in_window_counts[index] = len(in_window)
        fresh = [text for text in in_window if text not in seen]
        assert fresh, (
            f"u1/l1/s{index} has no in-window candidate the unit has not already "
            f"accepted, so G5 leaves it unfilled: {in_window}"
        )
        fills[index] = fresh[0]
        seen.update(in_window)

    assert in_window_counts == dict.fromkeys(range(9), 4), in_window_counts

    for index, text in fills.items():
        lemmas = _ledger_lemmas(analyser.analyse(sentence_id="0" * 16, text=text))
        assert set(lemmas) <= LESSON_ONE_WINDOW, (index, text, lemmas)
        assert set(reserved[index]) <= set(lemmas), (
            f"u1/l1/s{index} is reserved to teach {reserved[index]} and the candidate "
            f"G5 fills it with, {text!r}, does not contain it"
        )
        assert len(set(lemmas) & set(reserved[index])) <= MAX_NEW_LEMMAS_PER_ITEM


def test_INV_PACK_06_the_lesson_one_ship_texts_are_one_to_twelve_tokens() -> None:
    """[INV-PACK-06] The relaxed floor is 1, the ceiling never moved, and 1 is used.

    `Hola.` and `Buenas.` are one display token each; without B9(b) they are `length`
    rejects and lesson 1 has no content at all.
    """
    analyser = _spacy_analyser()
    counts = {}
    for row in authored_shard(LESSON_ONE_SHARD):
        analysis = analyser.analyse(sentence_id="0" * 16, text=row["text"])
        if set(_ledger_lemmas(analysis)) <= LESSON_ONE_WINDOW:
            counts[row["text"]] = len(analysis["display_tokens"])
    assert counts, "no in-window candidate at all; the shard is not what this test reads"
    assert all(MIN_TOKENS_VERBLESS_LESSON <= count <= MAX_TOKENS for count in counts.values()), (
        counts
    )
    assert min(counts.values()) < MIN_TOKENS, (
        f"every in-window candidate is >= {MIN_TOKENS} tokens, so B9(b) bought nothing "
        f"and the nine slots were fillable all along: {counts}"
    )


def test_a_one_token_sentence_on_a_cloze_form_is_a_bare_blank() -> None:
    """The G7 consequence of B9(b), measured HERE because this lane is what unlocks it.

    B9(b) makes one-token sentences reachable for the first time. `config/g7.py`
    SENTENCE_FORM_PLAN row 3 is (`fill_in_the_blank`, `complete_the_translation`,
    `listen_for_the_missing_word`) and a sentence item takes row `slot_index % 5`;
    `g7_expand.py` builds the body as `_gapped(slot, tokens, _gap_index(tokens))`, which
    over a SINGLE token returns the gap marker and the sentence's punctuation and nothing
    else. A prompt that is one blank is the same unanswerable class the code already
    refuses for endings via `MIN_ENDING_STEM_CHARS` — so the guard exists in one place
    and not the other.

    `_gapped` grew its `slot` parameter in `p2r3/expand-bake-package`, which cuts the gap
    out of the ORIGINAL text using the analysis offsets rather than re-joining tokens, so
    the hazard renders `____.` where it used to render `____`. That is the same
    unanswerable prompt with the full stop kept, which is why this test strips punctuation
    instead of comparing to the bare marker: the assertion is about what is left to
    answer, not about the spelling of the body.

    This lane's nine ship texts escape it BY CONTENT LUCK AND NOT BY A GUARD, and that is
    the fact worth pinning: the two one-token texts are at s0 and s5, and
    `0 % 5 == 5 % 5 == 0` draws the row with no cloze in it. The day someone authors a
    one-token text at a slot index congruent to 3 mod 5 — u1/l2/s3 is the live case, its
    verbless window makes `Sí.` shippable — a bare-blank item ships. Recorded as a blocker
    against the expand lane in `docs/owned/p2r3-gapfill-lesson1.json`; this test is the
    half that fails if it becomes this lane's problem.

    Nothing in `g7_expand.py` or `config/g7.py` is changed here: they are read as data.
    """
    from coursekit.config.g7 import GAP_MARKER, SENTENCE_FORM_PLAN
    from coursekit.stages.g7_expand import ResolvedSlot, _gap_index, _gapped

    cloze_forms = {"fill_in_the_blank", "listen_for_the_missing_word", "complete_the_translation"}
    cloze_rows = {
        index
        for index, row in enumerate(SENTENCE_FORM_PLAN)
        if cloze_forms & set(row)
    }
    assert cloze_rows, "no plan row carries a cloze shape; this test is reading the wrong table"

    # The hazard itself, demonstrated rather than described, through the real analysis
    # path (offsets into the original text) rather than the join fallback.
    def body(text: str, tokens: list[str]) -> str:
        cursor = 0
        rows = []
        for token in tokens:
            start = text.index(token, cursor)
            rows.append({"surface": token, "start": start, "end": start + len(token)})
            cursor = start + len(token)
        slot = ResolvedSlot(
            text=text,
            translation="",
            sid=None,
            analysis={"analyser": "test", "tokens": rows, "lemmas": tokens,
                      "display_tokens": tokens},
            candidate_id=None,
        )
        return _gapped(slot, tokens, _gap_index(tokens))

    for text, tokens in (("Hola.", ["Hola"]), ("Buenas.", ["Buenas"]), ("Sí.", ["Sí"])):
        rendered = body(text, tokens)
        assert rendered.strip(".,¿?¡!") == GAP_MARKER, (text, rendered)
    assert body("Buenas tardes.", ["Buenas", "tardes"]).strip(".,¿?¡!") != GAP_MARKER, (
        "a two-token cloze still has a stem"
    )

    # And the claim about THIS lane's content: no one-token ship text draws a cloze row.
    analyser = _spacy_analyser()
    offenders = []
    for row in authored_shard(LESSON_ONE_SHARD):
        analysis = analyser.analyse(sentence_id="0" * 16, text=row["text"])
        if not set(_ledger_lemmas(analysis)) <= LESSON_ONE_WINDOW:
            continue
        if len(analysis["display_tokens"]) > 1:
            continue
        slot = Slot.of(row["slot"])
        if slot.slot_index % len(SENTENCE_FORM_PLAN) in cloze_rows:
            offenders.append((row["slot"], row["text"]))
    assert offenders == [], (
        f"a one-token ship text sits at a slot index whose SENTENCE_FORM_PLAN row carries "
        f"a cloze shape, so G7 would render a prompt that is nothing but {GAP_MARKER!r}: "
        f"{offenders}. Either move the text to another slot or land the expand lane's "
        f"two-token cloze guard (see blockers in docs/owned/p2r3-gapfill-lesson1.json)."
    )


def test_INV_PACK_08_no_authored_candidate_anywhere_is_ustedeo() -> None:
    """[INV-PACK-08] V6: the es course declares `tu`, so `usted`/`ustedes` is blocking.

    Over EVERY committed shard, not only this lane's. The es course declares one register
    for the whole run — `DEFAULT_REGISTER_BY_SLOT["binary_t_v"] == "tu"` — and V6 returns
    a blocking finding for an accepted answer carrying a marker from the other row. 218
    rows of one shard were `usted` before the round-2 fix; this is the gate that keeps
    them gone, and it reads the register table rather than spelling the two words, so a
    marker added to `ES_REGISTER_MARKERS` is covered the day it is added.
    """
    from coursekit.config.g7 import DEFAULT_REGISTER_BY_SLOT, ES_REGISTER_MARKERS
    from coursekit.validators.exercise import register_of

    assert DEFAULT_REGISTER_BY_SLOT["binary_t_v"] == "tu"
    assert ES_REGISTER_MARKERS["usted"], "an empty marker row makes this check nothing"

    # `register_of` is V6's OWN function, imported. A local tokenise-and-compare here
    # would be a second definition of what a register marker is, and the one that
    # matters is the one the validator runs — it case-folds and strips accents on both
    # sides, which a hand-rolled whitespace tokeniser in a test does not. (Writing the
    # literal call here is itself a hit for `test_ledger_unit.py`'s grep gate, which is
    # the gate working: the scanner cannot tell a comment from a consumer.)
    offenders: list[str] = []
    scanned = 0
    for path in COMMITTED_SHARDS:
        for row in authored_shard(path):
            scanned += 1
            if "usted" in register_of(str(row["text"]), "es"):
                offenders.append(f"{path.name}: {row['text']!r}")
    assert scanned > 9000, f"only {scanned} rows scanned; the shard glob found nothing"
    assert offenders == [], offenders[:5]


def test_INV_PACK_08_the_ustedeo_scan_would_catch_one() -> None:
    """[INV-PACK-08] The falsifier. The scan above is a glob and a set intersection, and
    both of them pass loudly when they see nothing."""
    from coursekit.validators.exercise import register_of

    assert register_of("Buenos días, ¿cómo está usted?", "es") == {"usted"}
    assert register_of("¿Cómo te llamas tú?", "es") == {"tu"}
    assert register_of("Hola, buenos días.", "es") == set(), (
        "a register-neutral greeting must carry no marker, or the gate blocks the course"
    )


def test_every_lesson_one_candidate_is_machine_authored_with_a_rubric_score() -> None:
    """Same rule as the rest of the course: `provenance: llm`, a real integer score.

    The nineteen over-generated candidates per slot are scored too, and honestly: they
    are rejected on VOCABULARY, not on the rubric, so a low score on them would be a
    second reason invented to justify a rejection that already has one.
    """
    from coursekit.config.g6 import BACKTRANSLATION_MIN_SCORE, BACKTRANSLATION_SCORE_RANGE

    low, high = BACKTRANSLATION_SCORE_RANGE
    rows = authored_shard(LESSON_ONE_SHARD)
    assert {row["provenance"] for row in rows} == {"llm"}
    assert {row["backtranslation"]["judged_by"] for row in rows} == {"agent"}
    for row in rows:
        score = row["backtranslation"]["score"]
        assert isinstance(score, int) and low <= score <= high, row["text"]
        assert score >= BACKTRANSLATION_MIN_SCORE, (
            f"{row['text']!r} is authored below the rubric's ship bar. A candidate this "
            f"lane does not believe in is not one of the twenty; it is a row G6 discards "
            f"for the second time."
        )


def test_the_lesson_one_shard_ships_none_of_the_eleven_word_lists() -> None:
    """The eleven strings two rounds refused, by name, in every committed shard.

    They were committed once — 55 rows of `content/es/candidates/u01-u06.jsonl` keyed
    `u1/l1`, written by the lane that also documented why they should not ship.

    **Why they had to be deleted, stated correctly.** Not because of read order: G5 reads
    shards in SORTED FILENAME order (`authored_candidates_paths`) and `u01-l01.jsonl`
    sorts BEFORE `u01-u06.jsonl` (`'l' < 'u'`), so G5's first survivor for `u1/l1` was
    always going to be this lane's shard and `Hola, hola.` could never have become the
    course's first item that way. The measured order is
    `p2fix-integrate, u01-l01, u01-u06, u07-u14, u15-u23, u24-u30`.

    They had to go because of the OTHER defect this lane measured: `g7_expand.py` builds
    its lookup as `candidates[key] = row` over every accepted row, so G7 expands the LAST
    accepted candidate for a slot while G5 reports the FIRST. Leaving the word lists in a
    later-sorting shard would therefore have SHIPPED one of them — G5 would have said
    `Hola.` filled `u1/l1/s0` and the pack would have carried `Hola, hola.` — the moment
    B9(a) and B9(b) made them admissible. The read-order story is the wrong rule to teach
    the next authoring lane: what decides what ships today is last-wins at G7, which is
    why the fix is recorded as a blocker against the expand lane.
    """
    word_lists = {
        "Bueno, bueno.",
        "Bueno, hola, hola.",
        "Bueno, hola.",
        "Día, noche.",
        "Día, tarde, noche.",
        "Hola, bueno.",
        "Hola, día, tarde, noche.",
        "Hola, hola.",
        "Hola, noche.",
        "Hola, tarde.",
        "Tarde, noche.",
    }
    found = [
        f"{path.name}: {row['text']!r}"
        for path in COMMITTED_SHARDS
        for row in authored_shard(path)
        if row["text"] in word_lists and Slot.of(row["slot"]) in LESSON_ONE_SLOTS
    ]
    assert found == [], found

    # Narrowed to `u1/l1` DELIBERATELY, and the number is recorded rather than asserted
    # away: 217 rows of `u01-u06.jsonl` still carry one of these eleven strings for OTHER
    # slots of unit 1 (272 in origin/main, minus the 55 keyed `u1/l1` deleted above),
    # where they are over-generation the `duplicate` and
    # `out_of_vocabulary` axes deal with. Whether any of them SURVIVES for one of those
    # slots — i.e. whether `Hola, hola.` is the first accepted candidate anywhere — is a
    # question about another lane's shard against a real G4, not about this gate, and it
    # is written up in `docs/owned/p2r3-gapfill-lesson1.json` instead of being guessed
    # at here.
    elsewhere = [
        row["text"]
        for path in COMMITTED_SHARDS
        for row in authored_shard(path)
        if row["text"] in word_lists
    ]
    assert len(elsewhere) == 217, (
        f"{len(elsewhere)} word-list rows outside u1/l1, not 217. If the number went "
        f"DOWN a lane cleaned up; if it went UP, a lane is padding with them again."
    )


def test_the_registered_adapter_has_absorbed_the_prenominal_table_and_the_propn_plural() -> None:
    """B9(a) IS LANDED, and both traps this lane measured are closed. Same four strings.

    This test's previous form asserted the opposite and said so in its name: it pinned
    the broken state (`Buenos días.` -> `['buenos', 'día']`, out of vocabulary in the
    lesson that teaches both `bueno` and `día`) and its failure message said "delete
    `PRENOMINAL_BUENO` and this test", not "the adapter regressed". It failed at the P2
    round-3 integration, the day `p2r3/lemma-reachability` landed founder ruling B9(a) —
    which is exactly what it was for. Rewritten rather than deleted, because these four
    strings decided all nine ship texts and the one thing that could still break them
    silently is the adapter dropping the table again.

    Measured here after the merge, 2026-09-12, on the pinned `es_core_news_md` 3.8.0
    through the registered adapter:

    * **the prenominal trap** (`config/g1.LEMMA_NORMALISATION_ES`): `buen`, `buena`,
      `buenos` and `buenas` all reach `bueno`, in every position the raw model
      distinguishes — sentence-initial PROPN, mid-sentence ADJ, and bare.
    * **the PROPN-plural trap**, which B9 as written does not mention and which this lane
      raised against the other one: sentence-initial `Buenas noches.` used to come out
      `['buenas', 'noches']`, the plural noun tagged `PROPN` and never lemmatised, so the
      canonical greeting stayed out of vocabulary even WITH the prenominal table. It now
      reaches `['bueno', 'noche']`.

    The consequence is content rather than code, and it is recorded where it landed: the
    three greetings that used to be rejects (`Buenas noches.`, `¡Buenas tardes!`,
    `Buenos días, buenas tardes.`) are now in vocabulary, so every slot of `u1/l1` has
    four in-window candidates rather than one — see
    `test_INV_PACK_06_exactly_one_candidate_per_lesson_one_slot_is_inside_its_window`
    and, for the stage defect that turned that into a shipped word list,
    `test_the_slot_is_expanded_from_the_candidate_G5_filled_it_with_not_the_last_one`
    in `test_g7_expand.py`.
    """
    analyser = _spacy_analyser()
    measured = {
        text: analyser.analyse(sentence_id="0" * 16, text=text)["lemmas"]
        for text in ("Buenos días.", "Buenas.", "Hola, buenas tardes.", "Buenas noches.")
    }
    assert measured == {
        "Buenos días.": ["bueno", "día"],
        "Buenas.": ["bueno"],
        "Hola, buenas tardes.": ["hola", "bueno", "tarde"],
        "Buenas noches.": ["bueno", "noche"],
    }, measured
    for text, lemmas in measured.items():
        assert set(lemmas) <= LESSON_ONE_WINDOW, (
            f"{text!r} is out of the lesson-1 window again ({lemmas}): the adapter's "
            f"lemma-normalisation table (founder ruling B9(a)) has been dropped or "
            f"narrowed, and eight of the nine ship texts go out of vocabulary with it"
        )


def test_analysis_is_null_on_exactly_the_rows_the_analyser_never_ran_on(
    es_course: list[dict[str, Any]],
) -> None:
    """B16 option 2, write side, as an IFF over a whole run rather than over one row.

    `test_an_emitted_candidate_carries_the_analysis_g7_will_read` proves the analysis is
    real (it re-derives it from a second adapter call) and
    `test_a_stale_row_carries_a_null_analysis_because_the_analyser_never_ran` proves the
    nullable case exists. Neither says how many rows are null, and that is the number G7
    depends on: the contract's own rule is "non-null exactly when G7 will read it", which
    no schema keyword can express, so it has to be asserted over the population.

    `stale_ledger` is the only axis evaluated above the `_analyse` call, so it is the only
    `reject_reason` that may carry a null analysis. A second short-circuit added above
    that call — a cheap early-out on length, say, using a whitespace count — would make an
    accepted-looking population of rows G7 must refuse, and this is what notices.
    """
    result = run_g5()
    assert result.ok, result.message
    rows = list(read_records("candidate", lang="es"))
    assert rows, "no candidates written; this test would pass over nothing"
    null_reasons = {row["reject_reason"] for row in rows if row["analysis"] is None}
    assert null_reasons <= {"stale_ledger"}, null_reasons
    for row in rows:
        if row["reject_reason"] == "stale_ledger":
            continue
        analysis = row["analysis"]
        assert analysis is not None, row["text"]
        assert analysis["lemmas"] and analysis["display_tokens"] and analysis["tokens"]
        assert analysis["analyser"]["model"], "the pin rides on the row, not on the run"
