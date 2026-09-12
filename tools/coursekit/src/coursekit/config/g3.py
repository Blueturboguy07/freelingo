"""Constants owned by G3 — solve curriculum.

The section skeleton and its CEFR labels, units per section, the new-item rate, the
recycling window (V3's N and K), and the register slot per language.

Owner: p2-g3-g4-curriculum.

This file, not `config/curriculum.py`. The scaffold created `curriculum.py` for "the G3
lane"; the task that implements G3 and G4 is scoped to `config/g3.py` and `config/g4.py`,
so those are the files it writes. `curriculum.py` and `select.py` are left as the scaffold
left them — empty — and integration should delete them rather than have two homes for one
stage's thresholds.

Why the recycling window lives here and not in a validator's own config: G3 *schedules*
the recycling (it emits `recycled_lemmas`) and V3 *checks* it. One number, read by the
producer and the checker, is exactly the shape that drifts when it is written twice.
"""

from __future__ import annotations

from typing import Final

# ---------------------------------------------------------------------------
# Where the authored curriculum lives
# ---------------------------------------------------------------------------

#: `content/<lang>/curriculum.yaml` — the one human input of the language kit
#: (`scope2/00` §2.1 input 6). Never a corpus, never generated, never in `build/`.
CURRICULUM_DIRNAME: Final[str] = "content"
CURRICULUM_FILENAME: Final[str] = "curriculum.yaml"

#: The schema version stamped at the top of an authored curriculum. A bump means the
#: loader changed shape and every language's file needs a look, so it is separate from
#: `ARTIFACT_SCHEMA_VERSION`, which governs machine-written records.
CURRICULUM_SCHEMA_VERSION: Final[int] = 1

#: The clauses a grammar-concept probe may carry. A probe with none of them is REFUSED:
#: it matches every sentence, which makes G4's grammar-concept constraint vacuous while
#: looking exactly like a working selector.
PROBE_CLAUSES: Final[tuple[str, ...]] = (
    "lemma_any",
    "pos_any",
    "morph_any",
    "morph_all",
    "suffix_any",
)

# ---------------------------------------------------------------------------
# The new-item rate — the published i+1 budget
# ---------------------------------------------------------------------------

#: "5-7 new words per lesson embedded in known language" (blog.duolingo.com 2024-04-02,
#: recorded in `deep/01` §Ordering). The solver aims at the midpoint and derives
#: `level_count` from it, so the rate holds by construction instead of being asserted
#: after the fact on a number somebody typed into the curriculum file.
NEW_LEMMAS_PER_LESSON_MIN: Final[int] = 5
NEW_LEMMAS_PER_LESSON_TARGET: Final[int] = 6
NEW_LEMMAS_PER_LESSON_MAX: Final[int] = 7

#: Lessons inside one level (one path node). The product's own shape: a level is a node
#: you tap and a lesson is one session inside it.
LESSONS_PER_LEVEL: Final[int] = 2

#: A unit with no new lemma at all cannot exist — `unit_assignment.target_lemmas` is
#: `minItems: 1`, and a unit that teaches nothing is a path node with no reason to be
#: tapped. When the lexicon runs out, the solver back-fills by rank rather than emitting
#: an empty unit or silently dropping the unit from the course.
MIN_TARGET_LEMMAS_PER_UNIT: Final[int] = 1

# ---------------------------------------------------------------------------
# Recycling — V3's N and K
# ---------------------------------------------------------------------------

#: V3: every introduced lemma re-appears at least N times within K lessons of its
#: introduction. This is the property LibreLingo's randomisation cannot guarantee
#: (`scope2/00` §2.4, `01` F14) — the difference between a course and a shuffled deck.
#:
#: **FOUNDER-LEVEL CHOICE, NOT A MEASURED NUMBER.** `scope2/00` line 127 states the rule
#: as ">=N times within K lessons" and stops there; no row anywhere in the research
#: corpus fixes either value, and the reference product's real spacing was never
#: observed. 3-within-12 is this lane's judgement — roughly "three more times inside the
#: next two units" at `LESSONS_PER_LEVEL` × the usual level count — chosen so the window
#: is shorter than `RECYCLE_WINDOW_UNITS` can reach back. It is flagged here rather than
#: silently shipped because V3 is the strictest thing in the pipeline: raising N or
#: lowering K makes packs fail, and a number nobody chose on purpose is the wrong reason
#: for that. Revisit with the reviewer sample at the end of P2.
RECYCLE_MIN_OCCURRENCES: Final[int] = 3
RECYCLE_WINDOW_LESSONS: Final[int] = 12

#: How far back the solver reaches when it writes a unit's `recycled_lemmas`. Three units
#: at ~6 lessons each is 18 lessons of reach for a 12-lesson window, so a lemma
#: introduced late in a unit still has room to meet its quota.
RECYCLE_WINDOW_UNITS: Final[int] = 3

#: A ceiling on the emitted recycling list. Without it the list is every lemma in the
#: previous three units — a few hundred rows per unit that say nothing G4 can act on.
#: Most recent first, because a lemma introduced last is the one nearest its deadline.
RECYCLE_LEMMAS_MAX: Final[int] = 48

# ---------------------------------------------------------------------------
# The CEFR claim — a G3 OUTPUT, checked against G2, never read out of it (R23)
# ---------------------------------------------------------------------------

#: The chip values `section_cefr` may take, weakest first. `Intro` is the framework
#: template's label for a pre-A1 opening section (`scope2/00` §2.2); this course does not
#: use it, because the capture shows Spanish Section 1 rendering `A1 • SEE DETAILS`.
CEFR_LADDER: Final[tuple[str, ...]] = ("Intro", "A1", "A2", "B1", "B2")

#: The G2 band values, weakest first, for the agreement check below. `unbanded` sorts
#: last: a lemma nobody could band is never evidence FOR a section's label.
BAND_LADDER: Final[tuple[str, ...]] = ("A1", "A2", "B1", "B2", "C1", "C2", "unbanded")

#: The seven `cefr_level_prose` strings that actually ship, in bundle order
#: (str:2325-2331). `deep/03`'s adversarial pass measured this run and found the spec had
#: fabricated an eighth: `high A1` is immediately followed by `early B1`.
CEFR_PROSE_VALUES: Final[tuple[str, ...]] = (
    "very early A1",
    "early A1",
    "high A1",
    "early B1",
    "high B1",
    "early B2",
    "high B2",
)

#: Which chip each prose string belongs to. S024 renders `CEFR {{cefr_level}}` and the
#: blurb `This section covers the {{cefr_level_prose}} level of CEFR…` from the same
#: section row, so the two must agree or the screen contradicts itself.
CEFR_CHIP_FOR_PROSE: Final[dict[str, str]] = {
    "very early A1": "A1",
    "early A1": "A1",
    "high A1": "A1",
    "early B1": "B1",
    "high B1": "B1",
    "early B2": "B2",
    "high B2": "B2",
}

#: Chip values with NO prose string in the bundle. The bare `A2` at str:2323 sits BEFORE
#: the `CEFR {{cefr_level}}` template and is a chip value, not prose. A section that
#: derives an A2 chip has a chip to render and nothing to put in the S024 blurb; G3
#: reports that rather than inventing a string, and `deep/03`'s review left it as an open
#: question about the reference product rather than an answer.
CEFR_CHIPS_WITHOUT_PROSE: Final[tuple[str, ...]] = ("A2",)

#: The G2 lexicon CHECKS the derived section label; it does not produce it. At least this
#: fraction of a section's target lemmas must carry a G2 band at or below the derived
#: chip. Below it the label is a warning, not a silent pass — the section says A1 and the
#: words in it do not.
SECTION_BAND_AGREEMENT_MIN: Final[float] = 0.60

#: Lemmas banded `unbanded` are excluded from the denominator of that fraction rather
#: than counted against it. A lemma the lexicon never saw is missing evidence, and
#: treating missing evidence as contrary evidence turns a thin lexicon into a failing
#: curriculum. The count is reported separately so a thin lexicon is visible.
SECTION_BAND_MIN_SAMPLE: Final[int] = 10

# ---------------------------------------------------------------------------
# Register
# ---------------------------------------------------------------------------

#: The register slot each language's units may declare (`scope2/00` §2.2). Spanish and
#: French are binary T-V; German is too; Japanese is graded honorific. A unit that
#: declares a slot its language does not have is a curriculum error, not a warning.
REGISTER_SLOTS: Final[tuple[str, ...]] = ("n/a", "binary_t_v", "graded_honorific")

REGISTER_SLOT_BY_LANGUAGE: Final[dict[str, str]] = {
    "es": "binary_t_v",
    "fr": "binary_t_v",
    "de": "binary_t_v",
    "ja": "graded_honorific",
}

#: Register-marked lemmas that may be reserved only by the concept that explicitly
#: teaches the contrast. B19 moved `usted` out of unit 1: a course whose default T/V
#: choice is tuteo must not smuggle formal address into an unrelated introduction unit.
#: This is deliberately high precision, matching V6's unambiguous marker policy.
REGISTER_LEXEME_CONCEPT_BY_LANGUAGE: Final[dict[str, dict[str, str]]] = {
    "es": {
        "usted": "formal_informal_address",
        "ustedes": "formal_informal_address",
    }
}

# ---------------------------------------------------------------------------
# Section skeleton bounds
# ---------------------------------------------------------------------------

#: `unit_assignment.section_index` is 1-8 in the frozen contract. Restated here because
#: the loader rejects an out-of-range section with a curriculum error rather than letting
#: jsonschema report it as a record-shape failure three stages later.
SECTION_INDEX_MIN: Final[int] = 1
SECTION_INDEX_MAX: Final[int] = 8
