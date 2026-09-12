"""G3 — solve curriculum. A constraint solver, not an LLM.

`scope2/00` §2.3 is explicit about that ("**A constraint solver, not an LLM.**") and the
reason is not taste. G3 decides, for every lemma in the course, the single unit before
which it may never appear. That decision is what V1 checks, what FSRS keys its item ids
off, and what makes the i+1 promise true or false. A stage that produced it by asking a
model would produce a different ledger on every run, and a pack rebuilt with a different
ledger silently re-keys a learner's whole review history.

So this stage reads an authored curriculum and a banded lexicon and assigns lemmas and
grammar concepts to units under three constraints:

1. **The new-item rate.** The published budget is 5-7 new words per lesson embedded in
   known language (`deep/01` §Ordering). `level_count` is DERIVED from the number of new
   lemmas rather than authored, so the rate holds by construction; `_check_new_item_rate`
   asserts it anyway, because "by construction" is a claim about code that changes.
2. **Recycling.** Every introduced lemma must re-appear at least N times within K lessons
   (V3). G3 schedules that — `recycled_lemmas` on each unit is what G4 selects against
   and what V3 later checks.
3. **The lexicon.** A lemma the corpus never produced cannot be taught. Those are
   DEFERRED and counted, never silently dropped, because a curriculum quietly losing a
   third of its vocabulary looks identical to a curriculum that fitted.

### `section_cefr` is an output of this stage (R23)

The adversarial review found the CEFR claim sourced at the wrong granularity. CEFRLex is
a per-lemma A1-C2 lexicon; the product attaches CEFR to **sections** — S023 renders
`{{cefr_level}} • see details` on each section card and S024 renders `CEFR
{{cefr_level}}`, the prose blurb, and a `Grammar concepts` list. A per-lemma lexicon does
not yield a section label and a frequency decile yields neither. So the label is decided
here, from which grammar concepts a section contains, and is then CHECKED against G2's
bands — and only when those bands came from CEFRLex, because a frequency decile is not a
statement about CEFR and checking a CEFR label against one would be theatre. When the
bands are decile-derived the stage records `cefr_checked: false`, which is what makes the
de/ja cards read `Beginner · frequency-ordered` instead of `A1 · CEFR-checked` (Q8).

And only seven prose strings ship, with **no A2** among them (`deep/03` §review,
str:2325-2331). A section that derives an A2 chip has a chip and no blurb; this stage
says so rather than inventing one.
"""

from __future__ import annotations

import math
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

from ..artifacts import read_records, write_records
from ..config import ARTIFACT_SCHEMA_VERSION, CEFR_LANGUAGES, LANGUAGES
from ..config.g3 import (
    BAND_LADDER,
    CEFR_CHIP_FOR_PROSE,
    CEFR_CHIPS_WITHOUT_PROSE,
    CEFR_LADDER,
    CEFR_PROSE_VALUES,
    CURRICULUM_DIRNAME,
    CURRICULUM_FILENAME,
    CURRICULUM_SCHEMA_VERSION,
    LESSONS_PER_LEVEL,
    MIN_TARGET_LEMMAS_PER_UNIT,
    NEW_LEMMAS_PER_LESSON_MAX,
    NEW_LEMMAS_PER_LESSON_TARGET,
    PROBE_CLAUSES,
    RECYCLE_LEMMAS_MAX,
    RECYCLE_WINDOW_UNITS,
    REGISTER_SLOT_BY_LANGUAGE,
    REGISTER_SLOTS,
    SECTION_BAND_AGREEMENT_MIN,
    SECTION_BAND_MIN_SAMPLE,
    SECTION_INDEX_MAX,
    SECTION_INDEX_MIN,
)
from ..runlog import require_successful
from . import StageContext, StageResult, register_stage

__all__ = [
    "Curriculum",
    "CurriculumError",
    "GrammarConcept",
    "Probe",
    "SolveReport",
    "SolveResult",
    "AuthoredSection",
    "AuthoredUnit",
    "curriculum_path",
    "derive_level_count",
    "derive_section_cefr",
    "load_curriculum",
    "solve",
]


class CurriculumError(ValueError):
    """The authored curriculum is wrong. Loud, at load time, never a degraded run."""


# ---------------------------------------------------------------------------
# The authored shapes
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class Probe:
    """How G4 decides a sentence exhibits a grammar concept.

    A token satisfies the probe when it satisfies every clause that is PRESENT. A probe
    with no clause at all is refused at load: it matches every token of every sentence,
    which makes G4's grammar constraint vacuous while looking exactly like a working
    selector — the class of bug that produces a full course of plausible, untagged items.
    """

    lemma_any: tuple[str, ...] = ()
    pos_any: tuple[str, ...] = ()
    morph_any: tuple[str, ...] = ()
    morph_all: tuple[str, ...] = ()
    suffix_any: tuple[str, ...] = ()

    def is_empty(self) -> bool:
        return not any(getattr(self, clause) for clause in PROBE_CLAUSES)

    def matches_token(self, token: Mapping[str, Any]) -> bool:
        lemma = str(token.get("lemma", ""))
        if self.lemma_any and lemma not in self.lemma_any:
            return False
        if self.pos_any and str(token.get("pos", "")) not in self.pos_any:
            return False
        if self.suffix_any and not any(lemma.endswith(suffix) for suffix in self.suffix_any):
            return False
        features = {part for part in str(token.get("morph", "")).split("|") if part}
        if self.morph_any and not (features & set(self.morph_any)):
            return False
        return not (self.morph_all and not set(self.morph_all) <= features)

    def matches_sentence(self, tokens: Iterable[Mapping[str, Any]]) -> bool:
        return any(self.matches_token(token) for token in tokens)


@dataclass(frozen=True, slots=True)
class GrammarConcept:
    """One entry of the authored A1 inventory. `cefr` feeds the section label."""

    id: str
    label: str
    cefr: str
    probe: Probe


@dataclass(frozen=True, slots=True)
class AuthoredUnit:
    """One unit as the human wrote it. Everything derived is absent by design."""

    title: str
    function: str
    grammar_concept: str
    register_slot: str
    target_lexemes: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class AuthoredSection:
    index: int
    cefr_prose: str
    summary: str
    units: tuple[AuthoredUnit, ...]


@dataclass(frozen=True, slots=True)
class Curriculum:
    lang: str
    l1: str
    licence: str
    concepts: dict[str, GrammarConcept]
    sections: tuple[AuthoredSection, ...]

    def units(self) -> list[tuple[AuthoredSection, AuthoredUnit]]:
        return [(section, unit) for section in self.sections for unit in section.units]


# ---------------------------------------------------------------------------
# Loading
# ---------------------------------------------------------------------------


def _repo_root() -> Path:
    """The repository root.

    `tools/coursekit/src/coursekit/stages/g3_solve.py` — six parents. The path shape is
    fixed by the monorepo layout and changes only when somebody moves the package, which
    is a change they will notice; a `.git` probe breaks inside a worktree's `.git` FILE,
    which is exactly where this repository's lanes work.
    """
    return Path(__file__).resolve().parents[5]


def curriculum_path(lang: str) -> Path:
    """`content/<lang>/curriculum.yaml`. Committed, human-authored, never generated."""
    if lang not in LANGUAGES:
        raise ValueError(f"unknown language {lang!r}; expected one of {', '.join(LANGUAGES)}")
    return _repo_root() / CURRICULUM_DIRNAME / lang / CURRICULUM_FILENAME


def _require(mapping: Mapping[str, Any], key: str, where: str) -> Any:
    if key not in mapping:
        raise CurriculumError(f"{where}: missing {key!r}")
    return mapping[key]


def _strings(value: Any, where: str, what: str) -> tuple[str, ...]:
    """A list of real strings, never `str(item)`.

    `str(item)` is the trap this function exists to avoid. YAML 1.1 resolves the bare
    scalar `no` to the boolean False, so `target_lexemes: [..., no, ...]` — the Spanish
    word for "no" — silently becomes the lemma `"False"`, which is in no lexicon, teaches
    nothing, and shows up nowhere but as one more deferred lexeme in a list of hundreds.
    Measured on this repository's own curriculum before the check existed. The remedy is
    to quote it in the YAML; the job here is to make the mistake loud.
    """
    if isinstance(value, str) or not isinstance(value, Sequence):
        raise CurriculumError(f"{where}: {what} must be a list of strings")
    for item in value:
        if not isinstance(item, str):
            raise CurriculumError(
                f"{where}: {what} contains {item!r} ({type(item).__name__}), not a string. "
                f"A bare `no`, `yes`, `on` or `off` in YAML is a boolean — quote it."
            )
    return tuple(value)


def _clause(raw: Mapping[str, Any], name: str, where: str) -> tuple[str, ...]:
    return _strings(raw.get(name, ()), where, f"probe {name!r}")


def load_curriculum(lang: str, *, path: Path | None = None) -> Curriculum:
    """Parse and CHECK an authored curriculum.

    Every failure here is a `CurriculumError` at load time rather than a strange record
    six stages downstream. The checks are the ones a human editing YAML actually gets
    wrong: a probe with no clauses, a unit naming a concept that does not exist, a lemma
    introduced in two units, a register slot the language does not have, a `cefr_prose`
    string that is not one of the seven that ship.
    """
    target = path or curriculum_path(lang)
    if not target.exists():
        raise CurriculumError(
            f"no authored curriculum at {target}. It is input 6 of the language kit "
            f"(scope2/00 §2.1) and there is no fallback: ~1 human-day per language."
        )
    raw = yaml.safe_load(target.read_text(encoding="utf-8"))
    if not isinstance(raw, Mapping):
        raise CurriculumError(f"{target}: the top level must be a mapping")

    version = _require(raw, "schema", str(target))
    if version != CURRICULUM_SCHEMA_VERSION:
        raise CurriculumError(
            f"{target}: schema {version!r}, expected {CURRICULUM_SCHEMA_VERSION}"
        )
    declared_lang = _require(raw, "lang", str(target))
    if declared_lang != lang:
        raise CurriculumError(f"{target}: declares lang {declared_lang!r}, loaded as {lang!r}")

    concepts = _load_concepts(raw, target)
    sections = _load_sections(raw, target, lang, concepts)

    return Curriculum(
        lang=lang,
        l1=str(_require(raw, "l1", str(target))),
        licence=str(_require(raw, "licence", str(target))),
        concepts=concepts,
        sections=sections,
    )


def _load_concepts(raw: Mapping[str, Any], target: Path) -> dict[str, GrammarConcept]:
    concepts: dict[str, GrammarConcept] = {}
    for entry in _require(raw, "grammar_concepts", str(target)):
        where = f"{target}: grammar_concept {entry.get('id', '<unnamed>')!r}"
        concept_id = str(_require(entry, "id", where))
        if concept_id in concepts:
            raise CurriculumError(f"{where}: declared twice")
        probe_raw = _require(entry, "probe", where)
        if not isinstance(probe_raw, Mapping):
            raise CurriculumError(f"{where}: probe must be a mapping")
        unknown = set(probe_raw) - set(PROBE_CLAUSES)
        if unknown:
            raise CurriculumError(
                f"{where}: probe has unknown clause(s) {', '.join(sorted(unknown))}; "
                f"the loader accepts {', '.join(PROBE_CLAUSES)}"
            )
        probe = Probe(**{clause: _clause(probe_raw, clause, where) for clause in PROBE_CLAUSES})
        if probe.is_empty():
            raise CurriculumError(
                f"{where}: probe has no clauses, so it matches every sentence and makes "
                f"G4's grammar-concept constraint vacuous. Give it at least one of "
                f"{', '.join(PROBE_CLAUSES)}."
            )
        cefr = str(_require(entry, "cefr", where))
        if cefr not in CEFR_LADDER:
            raise CurriculumError(f"{where}: cefr {cefr!r} is not one of {CEFR_LADDER}")
        concepts[concept_id] = GrammarConcept(
            id=concept_id,
            label=str(_require(entry, "label", where)),
            cefr=cefr,
            probe=probe,
        )
    if not concepts:
        raise CurriculumError(f"{target}: no grammar concepts")
    return concepts


def _load_sections(
    raw: Mapping[str, Any],
    target: Path,
    lang: str,
    concepts: Mapping[str, GrammarConcept],
) -> tuple[AuthoredSection, ...]:
    allowed_slot = REGISTER_SLOT_BY_LANGUAGE.get(lang)
    seen_lexemes: dict[str, str] = {}
    sections: list[AuthoredSection] = []
    for entry in _require(raw, "sections", str(target)):
        index = int(_require(entry, "index", str(target)))
        where = f"{target}: section {index}"
        if not SECTION_INDEX_MIN <= index <= SECTION_INDEX_MAX:
            raise CurriculumError(
                f"{where}: index out of range {SECTION_INDEX_MIN}-{SECTION_INDEX_MAX}"
            )
        prose = str(_require(entry, "cefr_prose", where))
        if prose not in CEFR_PROSE_VALUES:
            raise CurriculumError(
                f"{where}: cefr_prose {prose!r} is not one of the seven strings that ship "
                f"({', '.join(CEFR_PROSE_VALUES)}). There is no A2 prose string."
            )
        units: list[AuthoredUnit] = []
        for unit_entry in _require(entry, "units", where):
            unit_where = f"{where}, unit {unit_entry.get('title', '<untitled>')!r}"
            concept = str(_require(unit_entry, "grammar_concept", unit_where))
            if concept not in concepts:
                raise CurriculumError(f"{unit_where}: unknown grammar_concept {concept!r}")
            slot = str(_require(unit_entry, "register_slot", unit_where))
            if slot not in REGISTER_SLOTS:
                raise CurriculumError(f"{unit_where}: register_slot {slot!r} is not a slot")
            if slot != "n/a" and allowed_slot is not None and slot != allowed_slot:
                raise CurriculumError(
                    f"{unit_where}: register_slot {slot!r}, but {lang} is {allowed_slot!r}"
                )
            lexemes = _strings(
                _require(unit_entry, "target_lexemes", unit_where),
                unit_where,
                "target_lexemes",
            )
            if not lexemes:
                raise CurriculumError(f"{unit_where}: no target_lexemes")
            for lexeme in lexemes:
                if lexeme in seen_lexemes:
                    raise CurriculumError(
                        f"{unit_where}: {lexeme!r} was already introduced in "
                        f"{seen_lexemes[lexeme]}. A lemma has exactly one introduction "
                        f"unit — that is what V1 is the promise about."
                    )
                seen_lexemes[lexeme] = unit_where
            units.append(
                AuthoredUnit(
                    title=str(_require(unit_entry, "title", unit_where)),
                    function=str(_require(unit_entry, "function", unit_where)),
                    grammar_concept=concept,
                    register_slot=slot,
                    target_lexemes=lexemes,
                )
            )
        if not units:
            raise CurriculumError(f"{where}: no units")
        sections.append(
            AuthoredSection(
                index=index,
                cefr_prose=prose,
                summary=str(entry.get("summary", "")),
                units=tuple(units),
            )
        )
    if not sections:
        raise CurriculumError(f"{target}: no sections")
    if [section.index for section in sections] != sorted(s.index for s in sections):
        raise CurriculumError(f"{target}: sections are not in ascending index order")
    return tuple(sections)


# ---------------------------------------------------------------------------
# The solver
# ---------------------------------------------------------------------------


def derive_level_count(new_lemmas: int) -> int:
    """Levels for a unit that introduces `new_lemmas` items.

    Derived, not authored. A level is `LESSONS_PER_LEVEL` lessons and a lesson carries
    `NEW_LEMMAS_PER_LESSON_TARGET` new items, so the published 5-7 budget holds by
    construction. `_check_new_item_rate` asserts the postcondition against the MAX rather
    than trusting that sentence.
    """
    per_level = LESSONS_PER_LEVEL * NEW_LEMMAS_PER_LESSON_TARGET
    return max(1, math.ceil(new_lemmas / per_level))


def _check_new_item_rate(unit_index: int, new_lemmas: int, level_count: int) -> None:
    ceiling = level_count * LESSONS_PER_LEVEL * NEW_LEMMAS_PER_LESSON_MAX
    if new_lemmas > ceiling:
        raise CurriculumError(
            f"unit {unit_index}: {new_lemmas} new lemmas over {level_count} level(s) is "
            f"more than {NEW_LEMMAS_PER_LESSON_MAX} per lesson (ceiling {ceiling})"
        )


def derive_section_cefr(
    concepts: Mapping[str, GrammarConcept],
    units: Iterable[AuthoredUnit],
) -> str:
    """The section's CEFR chip: the highest rung any of its grammar concepts sits on.

    This is the R23 correction made executable. The label is a curriculum-design output —
    which concepts a section contains — not a lookup in a per-lemma lexicon.
    """
    rungs = [CEFR_LADDER.index(concepts[unit.grammar_concept].cefr) for unit in units]
    if not rungs:
        raise CurriculumError("a section with no units has no CEFR label")
    return CEFR_LADDER[max(rungs)]


@dataclass(frozen=True, slots=True)
class SectionCheck:
    """What the G2 lexicon says about a section label G3 derived."""

    section_index: int
    cefr: str
    prose: str
    prose_exists: bool
    banded_sample: int
    agreeing: int
    agreement: float
    checked: bool
    ok: bool


@dataclass(slots=True)
class SolveReport:
    """Everything a reader needs to tell a fitted curriculum from a lucky one."""

    units: int = 0
    lexemes_authored: int = 0
    lexemes_assigned: int = 0
    lexemes_deferred: int = 0
    lexemes_backfilled: int = 0
    deferred_sample: list[str] = field(default_factory=list)
    lessons: int = 0
    new_lemmas_per_lesson: float = 0.0
    cefr_checked: bool = False
    section_checks: list[SectionCheck] = field(default_factory=list)

    def as_notes(self) -> dict[str, Any]:
        return {
            "units": self.units,
            "lexemes_authored": self.lexemes_authored,
            "lexemes_assigned": self.lexemes_assigned,
            "lexemes_deferred": self.lexemes_deferred,
            "lexemes_backfilled": self.lexemes_backfilled,
            "deferred_sample": self.deferred_sample,
            "lessons": self.lessons,
            "new_lemmas_per_lesson": round(self.new_lemmas_per_lesson, 3),
            "cefr_checked": self.cefr_checked,
            "sections": [
                {
                    "section_index": check.section_index,
                    "cefr": check.cefr,
                    "prose": check.prose,
                    "prose_exists": check.prose_exists,
                    "banded_sample": check.banded_sample,
                    "agreement": round(check.agreement, 3),
                    "checked": check.checked,
                    "ok": check.ok,
                }
                for check in self.section_checks
            ],
        }


@dataclass(slots=True)
class SolveResult:
    units: list[dict[str, Any]]
    report: SolveReport

    @property
    def ok(self) -> bool:
        return all(check.ok for check in self.report.section_checks)


def _lexicon(banded: Iterable[Mapping[str, Any]]) -> dict[str, dict[str, Any]]:
    """lemma -> its G2 row. First row wins; G2 emits one row per lemma."""
    lexicon: dict[str, dict[str, Any]] = {}
    for row in banded:
        lexicon.setdefault(str(row["lemma"]), dict(row))
    return lexicon


def solve(
    curriculum: Curriculum,
    banded: Iterable[Mapping[str, Any]],
) -> SolveResult:
    """Assign lemmas and grammar concepts to units. Deterministic, given the same inputs.

    Determinism is not a nicety here: `packages/core` keys FSRS rows by a content hash of
    the item, so a ledger that reshuffles between builds re-keys a learner's entire review
    history on pack update.
    """
    lexicon = _lexicon(banded)
    by_rank = sorted(lexicon, key=lambda lemma: (int(lexicon[lemma]["rank"]), lemma))
    claimed = {
        lexeme for _, unit in curriculum.units() for lexeme in unit.target_lexemes
    }

    introduced: dict[str, int] = {}
    per_unit_new: list[list[str]] = []
    records: list[dict[str, Any]] = []
    report = SolveReport()
    section_lemmas: dict[int, list[str]] = {}

    unit_index = 0
    for section, unit in curriculum.units():
        unit_index += 1
        report.lexemes_authored += len(unit.target_lexemes)

        requested = [
            lexeme
            for lexeme in unit.target_lexemes
            if lexeme in lexicon and lexeme not in introduced
        ]
        deferred = [lexeme for lexeme in unit.target_lexemes if lexeme not in lexicon]
        report.lexemes_deferred += len(deferred)
        for lexeme in deferred:
            if len(report.deferred_sample) < RECYCLE_LEMMAS_MAX:
                report.deferred_sample.append(lexeme)

        target = list(requested)
        if len(target) < MIN_TARGET_LEMMAS_PER_UNIT:
            # Back-fill by rank so a unit is never empty. A lemma some LATER unit
            # authored is excluded: teaching it early would leave that unit's own
            # target_lexemes not-new and move an introduction the author placed.
            for lemma in by_rank:
                if len(target) >= MIN_TARGET_LEMMAS_PER_UNIT:
                    break
                if lemma in introduced or lemma in claimed or lemma in target:
                    continue
                target.append(lemma)
                report.lexemes_backfilled += 1
        if not target:
            raise CurriculumError(
                f"unit {unit_index} ({unit.title!r}) has no assignable lemma: none of its "
                f"{len(unit.target_lexemes)} target_lexemes is in the G2 lexicon and the "
                f"lexicon has nothing left to back-fill with."
            )

        level_count = derive_level_count(len(target))
        _check_new_item_rate(unit_index, len(target), level_count)

        recycled = _recycling_for(unit_index, per_unit_new)

        records.append(
            {
                "schema_version": ARTIFACT_SCHEMA_VERSION,
                "lang": curriculum.lang,
                "section_index": section.index,
                "section_cefr": derive_section_cefr(curriculum.concepts, section.units),
                "unit_index": unit_index,
                "unit_title": unit.title,
                "function": unit.function,
                "grammar_concept": unit.grammar_concept,
                "register_slot": unit.register_slot,
                "target_lemmas": list(target),
                "recycled_lemmas": list(recycled),
                "level_count": level_count,
            }
        )

        for lemma in target:
            introduced[lemma] = unit_index
        per_unit_new.append(list(target))
        section_lemmas.setdefault(section.index, []).extend(target)
        report.units += 1
        report.lexemes_assigned += len(target)
        report.lessons += level_count * LESSONS_PER_LEVEL

    if report.lessons:
        report.new_lemmas_per_lesson = report.lexemes_assigned / report.lessons

    report.section_checks = [
        _check_section(curriculum, section, lexicon, section_lemmas.get(section.index, []))
        for section in curriculum.sections
    ]
    report.cefr_checked = any(check.checked for check in report.section_checks)
    return SolveResult(units=records, report=report)


def _recycling_for(unit_index: int, per_unit_new: Sequence[Sequence[str]]) -> list[str]:
    """The lemmas this unit must bring back, most recently introduced first.

    V3 wants every lemma re-appearing N times within K lessons of its introduction, and
    the lemma introduced last is the one nearest its deadline — so recency, not rank, is
    the order, and the list is capped rather than being every lemma of three whole units.
    """
    window = per_unit_new[max(0, unit_index - 1 - RECYCLE_WINDOW_UNITS) : unit_index - 1]
    recycled: list[str] = []
    for lemmas in reversed(window):
        for lemma in lemmas:
            if len(recycled) >= RECYCLE_LEMMAS_MAX:
                return recycled
            recycled.append(lemma)
    return recycled


def _check_section(
    curriculum: Curriculum,
    section: AuthoredSection,
    lexicon: Mapping[str, Mapping[str, Any]],
    lemmas: Sequence[str],
) -> SectionCheck:
    """Check a derived section label against G2 — and only where that means anything.

    The check runs when the section's lemmas were banded by CEFRLex. When they were
    banded by frequency decile it does not: a decile is not a statement about CEFR, and
    running the comparison anyway would turn a thin proxy into a failing curriculum while
    reporting a number that means nothing. The stage then records `checked: false`, which
    is what makes a card read `Beginner · frequency-ordered` rather than
    `A1 · CEFR-checked` (the Q8 ruling).
    """
    cefr = derive_section_cefr(curriculum.concepts, section.units)
    prose_exists = cefr not in CEFR_CHIPS_WITHOUT_PROSE
    declared_chip = CEFR_CHIP_FOR_PROSE[section.cefr_prose]
    if declared_chip != cefr:
        raise CurriculumError(
            f"section {section.index}: the grammar concepts derive {cefr!r}, but "
            f"cefr_prose {section.cefr_prose!r} belongs to {declared_chip!r}. S024 renders "
            f"both from the same row and would contradict itself."
        )

    rows = [lexicon[lemma] for lemma in lemmas if lemma in lexicon]
    from_cefrlex = [row for row in rows if row.get("band_source") == "cefrlex"]
    checked = (
        curriculum.lang in CEFR_LANGUAGES
        and len(from_cefrlex) >= SECTION_BAND_MIN_SAMPLE
        and len(from_cefrlex) == len(rows)
    )
    banded = [row for row in from_cefrlex if row.get("band") in BAND_LADDER[:-1]]
    ceiling = BAND_LADDER.index(cefr) if cefr in BAND_LADDER else len(BAND_LADDER) - 1
    agreeing = sum(1 for row in banded if BAND_LADDER.index(str(row["band"])) <= ceiling)
    agreement = agreeing / len(banded) if banded else 0.0
    ok = (not checked) or (
        len(banded) >= SECTION_BAND_MIN_SAMPLE and agreement >= SECTION_BAND_AGREEMENT_MIN
    )
    return SectionCheck(
        section_index=section.index,
        cefr=cefr,
        prose=section.cefr_prose,
        prose_exists=prose_exists,
        banded_sample=len(banded),
        agreeing=agreeing,
        agreement=agreement,
        checked=checked,
        ok=ok,
    )


# ---------------------------------------------------------------------------
# The stage
# ---------------------------------------------------------------------------


@register_stage("g3", reads=("banded_lemma",), writes=("unit_assignment",))
def solve_curriculum(ctx: StageContext) -> StageResult:
    """Read `g2/banded.jsonl` and `content/<lang>/curriculum.yaml`; write `g3/units.jsonl`."""
    require_successful(ctx.lang, ["g2"])
    banded = list(read_records("banded_lemma", lang=ctx.lang))
    curriculum = load_curriculum(ctx.lang)

    result = solve(curriculum, banded)
    written = write_records("unit_assignment", result.units, lang=ctx.lang)

    ctx.entry.record_output("unit_assignment")
    ctx.entry.read = len(banded)
    ctx.entry.written = written
    ctx.entry.rejected = result.report.lexemes_deferred
    ctx.entry.note(
        curriculum=str(curriculum_path(ctx.lang).relative_to(_repo_root())),
        curriculum_licence=curriculum.licence,
        **result.report.as_notes(),
    )

    failing = [check for check in result.report.section_checks if not check.ok]
    if failing:
        return StageResult(
            ok=False,
            message=(
                "section CEFR label disagrees with the CEFRLex bands of its own lemmas: "
                + "; ".join(
                    f"section {check.section_index} says {check.cefr} but only "
                    f"{check.agreement:.0%} of {check.banded_sample} banded lemmas agree"
                    for check in failing
                )
            ),
            detail=result.report.as_notes(),
        )
    return StageResult(
        ok=True,
        message=(
            f"{written} units, {result.report.lexemes_assigned} lemmas, "
            f"{result.report.new_lemmas_per_lesson:.1f} new per lesson"
        ),
        detail=result.report.as_notes(),
    )
