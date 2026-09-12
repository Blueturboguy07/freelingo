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
import unicodedata
from collections.abc import Callable, Iterable, Mapping, Sequence
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
from ..inputs import MissingInput
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
    "Unreachable",
    "curriculum_path",
    "derive_level_count",
    "derive_section_cefr",
    "load_curriculum",
    "solve",
    "unreachable_lexemes",
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
    #: `(lexeme, the surface forms this unit teaches for it)`, as authored. Optional per
    #: lexeme and per unit; a tuple of pairs rather than a dict so the unit stays frozen
    #: and hashable. Read by the reachability gate below and by nothing else — it is a
    #: claim about the LANGUAGE, not a selector, and G4 never sees it.
    forms: tuple[tuple[str, tuple[str, ...]], ...] = ()

    def taught_forms(self, lexeme: str) -> tuple[str, ...]:
        """Every surface the reachability gate may test for `lexeme`.

        The lexeme itself is always one of them: a curriculum that declares `casa` is
        claiming, at minimum, that the lemmatiser produces `casa` for the word `casa`.
        Authored forms come after it, in the order they were written, so the failure
        message reads in the order a human would check them.
        """
        authored = next((forms for name, forms in self.forms if name == lexeme), ())
        return tuple(dict.fromkeys((lexeme, *authored)))


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
        raise CurriculumError(f"{target}: schema {version!r}, expected {CURRICULUM_SCHEMA_VERSION}")
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
                    forms=_load_forms(unit_entry, unit_where, lexemes),
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


def _load_forms(
    unit_entry: Mapping[str, Any],
    where: str,
    lexemes: tuple[str, ...],
) -> tuple[tuple[str, tuple[str, ...]], ...]:
    """The optional `forms:` block: `{lexeme: [surface, ...]}`, checked at load time.

    Four refusals, and each one is a way the block could look right and say nothing:

    - a key that is not one of this unit's `target_lexemes` is a typo or a lexeme that
      moved unit, and either way the forms it declares are tested against nothing;
    - an empty list is a lexeme that claims to have declared its forms and has not;
    - a non-string entry is the YAML boolean trap `_strings` exists for (`no`, `on`);
    - **a form that is not NFC-lowercase is refused**, and that is the load-bearing one.

    ## Why a capital is refused rather than lowercased

    `es_core_news_md` re-tags a sentence-initial capital PROPN and leaves the lemma as
    the surface, so `Gracias` reaches the lemma `gracias` where `gracias` reaches
    `gracia` (measured 2026-09-12). A `forms:` list is allowed to name a real form of the
    word — a plural, an inflection — and is NOT allowed to name a spelling that only
    works because of where it sits: that would discharge the B9(c) gate for a lexeme no
    ordinary corpus sentence can select, which is the exact defect B9(c) exists to catch.
    An adversarial review of the first version of this lane found three such rows.

    Refused rather than silently lowercased because the YAML is the declaration: an
    author who writes `Gracias` believes something about Spanish that is wrong, and a
    lowercasing loader would accept the belief and then fail somewhere else. The position
    artefact belongs in `config/g1.LEMMA_NORMALISATION_ES`, whose whole job is to make
    the two positions agree; see D-B9A-01 there.
    """
    raw = unit_entry.get("forms")
    if raw is None:
        return ()
    if not isinstance(raw, Mapping):
        raise CurriculumError(f"{where}: forms must be a mapping of lexeme -> [surface, ...]")
    unknown = sorted(set(raw) - set(lexemes))
    if unknown:
        raise CurriculumError(
            f"{where}: forms names {', '.join(repr(name) for name in unknown)}, which "
            f"is not in this unit's target_lexemes. A form list keyed to a lexeme the "
            f"unit does not teach is checked against nothing."
        )
    loaded: list[tuple[str, tuple[str, ...]]] = []
    for lexeme in dict.fromkeys(lexemes):
        if lexeme not in raw:
            continue
        forms = _strings(raw[lexeme], where, f"forms[{lexeme!r}]")
        if not forms:
            raise CurriculumError(
                f"{where}: forms[{lexeme!r}] is empty. Omit the key instead — an empty "
                f"list reads as 'the forms were declared' and declares nothing."
            )
        for form in forms:
            if form != unicodedata.normalize("NFC", form.lower()):
                raise CurriculumError(
                    f"{where}: forms[{lexeme!r}] declares {form!r}, which is not "
                    f"NFC-lowercase. The pinned lemmatiser re-tags a sentence-initial "
                    f"capital PROPN and keeps the surface as the lemma, so a capitalised "
                    f"form can reach a lemma that no mid-sentence occurrence of the same "
                    f"word ever reaches — it would discharge the reachability gate for a "
                    f"lexeme nothing can select. Declare a real lowercase form, or put "
                    f"the position artefact in config/g1.LEMMA_NORMALISATION_ES."
                )
        loaded.append((lexeme, tuple(dict.fromkeys(forms))))
    return tuple(loaded)


# ---------------------------------------------------------------------------
# Lexeme reachability — founder ruling B9(c)
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class Unreachable:
    """One declared lexeme the pinned lemmatiser never produces, and what was tried."""

    unit_index: int
    unit_title: str
    lexeme: str
    #: `(form, the ledger lemma the adapter produced for it, or None)` in the order the
    #: forms were tried. Carried so the failure message names the lemma the model DOES
    #: produce: "levantarse -> levantar él" is a fixable sentence and "unreachable" is
    #: not.
    attempts: tuple[tuple[str, str | None], ...]

    def as_line(self) -> str:
        tried = ", ".join(
            f"{form!r} -> {produced!r}" if produced else f"{form!r} -> (not one word)"
            for form, produced in self.attempts
        )
        return f"u{self.unit_index} {self.unit_title!r}: {self.lexeme!r} ({tried})"


def unreachable_lexemes(
    curriculum: Curriculum,
    lemmatise_surfaces: Callable[[Sequence[str]], list[tuple[str, str] | None]],
) -> list[Unreachable]:
    """Every declared target lexeme no form the course teaches can reach. **B9(c).**

    The defect, in one sentence: *a curriculum may declare a target lemma the pinned
    lemmatiser never produces for any form the course intends to teach.* It is silent
    today. Such a lexeme is simply not in the G2 lexicon, so `solve` counts it as
    DEFERRED — the same bucket as a perfectly good lemma this corpus happened not to
    contain — and the unit ships teaching one thing fewer than it says it does. The
    first person to notice is whoever tries to author a sentence against the window,
    which is how `docs/P2-BLOCKERS.md` §B9 was written.

    The oracle is the adapter's own `lemmatise_surfaces` over `unit.taught_forms(...)`,
    **with the B9(a) normalisation table applied** (the adapter applies it; nothing here
    knows the table exists). One batched call for the whole course.

    **Why the G2 lexicon is NOT consulted, though it is right there in `solve`.** A
    lexeme in the lexicon has demonstrably been produced by the lemmatiser for some real
    corpus sentence, which is stronger evidence than a one-word document — and that is
    exactly the problem. It makes the verdict a property of the CORPUS: the same
    curriculum and the same model would pass on Monday's ingest and fail on Tuesday's,
    and a curriculum error would hide behind a corpus that happened to be lucky. The
    gate is a pure function of (curriculum, pinned model, normalisation table), like the
    adapter self-test, so it can be run and reasoned about before a byte is ingested.

    The cost of that choice is that a lexeme whose bare form mis-lemmatises must declare
    a form that does not — `trabajos` for `trabajo`, `primas` for `prima` — which is what
    the `forms:` block is for and why it is per unit rather than global. Those forms are
    lowercase by construction (`_load_forms` refuses a capital and says why), so the gate
    cannot be discharged by the sentence-initial PROPN reading; where the bare surface is
    the only spelling the course teaches, the repair belongs in
    `config/g1.LEMMA_NORMALISATION_ES` instead.
    """
    ordered: list[tuple[int, AuthoredUnit, str, tuple[str, ...]]] = []
    probes: list[str] = []
    for unit_index, (_section, unit) in enumerate(curriculum.units(), start=1):
        # `dict.fromkeys`, not `set`: a duplicated lexeme is probed and reported once,
        # and the order stays the authored one so the failure list reads down the unit.
        for lexeme in dict.fromkeys(unit.target_lexemes):
            forms = unit.taught_forms(lexeme)
            ordered.append((unit_index, unit, lexeme, forms))
            probes.extend(forms)
    produced = lemmatise_surfaces(probes)
    if len(produced) != len(probes):
        raise CurriculumError(
            f"the adapter returned {len(produced)} answers for {len(probes)} probed "
            f"forms. `lemmatise_surfaces` is element-for-element by contract; a "
            f"different length would silently shift every verdict onto another lexeme."
        )
    failures: list[Unreachable] = []
    cursor = 0
    for index, unit, lexeme, forms in ordered:
        answers = produced[cursor : cursor + len(forms)]
        cursor += len(forms)
        if any(answer is not None and answer[0] == lexeme for answer in answers):
            continue
        failures.append(
            Unreachable(
                unit_index=index,
                unit_title=unit.title,
                lexeme=lexeme,
                attempts=tuple(
                    (form, answer[0] if answer else None)
                    for form, answer in zip(forms, answers, strict=True)
                ),
            )
        )
    return failures


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
    #: B9(c). Declared lexemes no form the course teaches can reach. Written by the
    #: stage, never by `solve`: the solver is a pure function of a curriculum and a
    #: lexicon, and this is a question about the lemmatiser.
    unreachable: list[Unreachable] = field(default_factory=list)

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
            "unreachable_lexemes": [failure.as_line() for failure in self.unreachable],
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
        """Both gates: every section CEFR check, and B9(c) reachability.

        `solve()` never writes `report.unreachable` — it is a pure function of a
        curriculum and a lexicon and reachability is a question about the lemmatiser — so
        for a caller that only calls `solve()` this reduces to the section checks. The
        stage is the only caller in `src/` and it fills the field in before reading `ok`;
        `test_g3_solve.py` pins both readings so a second caller cannot quietly get the
        weaker one.
        """
        return not self.report.unreachable and all(check.ok for check in self.report.section_checks)


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
    claimed = {lexeme for _, unit in curriculum.units() for lexeme in unit.target_lexemes}

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
    """Read `g2/banded.jsonl` and `content/<lang>/curriculum.yaml`; write `g3/units.jsonl`.

    The reachability gate (B9(c)) runs HERE and unconditionally, on the registered
    adapter, with no flag and no skip. That is deliberate twice over: it is not a
    registered validator, because `VALIDATOR_IDS` is what `pack-ci`'s `pipeline-ready`
    job counts and an unregistered id would skip both pack jobs green; and it takes no
    "check reachability" option, because an option is a way to turn it off. The stage
    therefore needs the `nlp` group, which every route that can reach G3 already has —
    G1 and G2 are hard-gated on it — and asks for it through the adapter, so a runner
    without it fails by name (INV-PACK-12) instead of writing units nobody checked.
    """
    require_successful(ctx.lang, ["g2"])
    banded = list(read_records("banded_lemma", lang=ctx.lang))
    curriculum = load_curriculum(ctx.lang)

    from .g1_analyze import adapter_for

    result = solve(curriculum, banded)
    try:
        lemmatise = adapter_for(ctx.lang).lemmatise_surfaces
    except MissingInput as exc:
        # A named stage failure, not a traceback, and never a skip. INV-PACK-12: a
        # missing per-language source fails loudly and is not replaced by something of a
        # different shape. The one shape that would be worse than either is "reachability
        # was not checked because no adapter was around", which is how an unreachable
        # lexeme got into the shipped curriculum in the first place — so this returns
        # ok=False rather than leaving `report.unreachable` empty and looking clean.
        return StageResult(
            ok=False,
            message=(
                f"the B9(c) reachability gate needs the morphology adapter and there is "
                f"none: {exc}. G1 and G2 are hard-gated on the same adapter, so a run "
                f"that got this far had one; this is not a reason to skip the gate."
            ),
            detail=result.report.as_notes(),
        )
    result.report.unreachable = unreachable_lexemes(curriculum, lemmatise)
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

    if result.report.unreachable:
        return StageResult(
            ok=False,
            message=(
                f"{len(result.report.unreachable)} declared target lexeme(s) are "
                f"unreachable: the pinned lemmatiser produces no such lemma for any "
                f"form the course teaches, so the unit would ship teaching one item "
                f"fewer than it declares and V1 would pass over a lemma that cannot "
                f"exist. Declare a `forms:` entry with a surface that does reach it, or "
                f"declare the lemma the model actually produces. "
                + "; ".join(failure.as_line() for failure in result.report.unreachable[:12])
                + ("; …" if len(result.report.unreachable) > 12 else "")
            ),
            detail=result.report.as_notes(),
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
