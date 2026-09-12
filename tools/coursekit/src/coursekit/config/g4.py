"""Constants owned by G4 — select.

The ledger window, how many sentences a lesson slot needs, and the shippable-corpus
filter that keeps oracle-only text out of a lesson.

Owner: p2-g3-g4-curriculum. See `config/g3.py` for why this file and not `select.py`.
"""

from __future__ import annotations

from typing import Final

# ---------------------------------------------------------------------------
# Lesson shape
# ---------------------------------------------------------------------------

#: Slots per lesson. `deep/01` §S20 measured a lesson at ~9-14 exercises including the
#: mistake replays, and replays are generated at runtime from the same items, so the
#: authored slot count is the low end of that range rather than the middle.
SLOTS_PER_LESSON: Final[int] = 9

#: The ledger rule V2 enforces, applied here so a violating item is never selected in the
#: first place: at most one new lemma-or-inflection per exercise.
MAX_NEW_LEMMAS_PER_EXERCISE: Final[int] = 1

#: …and at most K new lemmas per lesson. Same number as the top of the published
#: 5-7 budget: a lesson may introduce its whole allowance, never more.
MAX_NEW_LEMMAS_PER_LESSON: Final[int] = 7

#: New INFLECTIONS of an already-known lemma, per exercise. `scope2/00` Q2 asks whether a
#: "new item" is a lemma, a lemma+inflection, or a lemma plus a grammar concept, and V2's
#: text says "new lemma-or-inflection". This is the inflection half, and V2 reports it as
#: a WARNING rather than a blocking finding for one stated reason: the frozen `exercise`
#: record carries `item_tags.lemmas` and no morphology, so the check is only possible for
#: corpus-sourced items where G1's tokens can be reached through `source_sentence_id`. A
#: blocking rule that silently does not apply to G5-authored items is worse than a warning
#: that applies to what it can see. Making it blocking is a contract change (the exercise
#: record would carry forms), not a threshold change.
MAX_NEW_INFLECTIONS_PER_EXERCISE: Final[int] = 1

#: How many admissible candidates a slot scores for recycling value before taking the best
#: it has seen. Unbounded scoring is O(corpus) per slot and the corpus order is already
#: shortest-first, so the useful candidates are at the front; the bound is what keeps a
#: 250k-row run from being quadratic in the course length.
RECYCLE_SCAN_LIMIT: Final[int] = 512

# ---------------------------------------------------------------------------
# The corpus filter
# ---------------------------------------------------------------------------

#: Selection reads ONLY sources whose licence verdict is this. Oracle-only corpora
#: (NLLB, OpenSubtitles, CCMatrix) inform frequency, perplexity and alignment and may
#: never fill a slot; `forbidden` never reached the ledger at all (INV-PACK-13). The
#: filter is on the row, not on the source id, because a source's verdict is resolved at
#: ingest and a stage that re-derives it can re-derive it differently.
SHIPPABLE_VERDICT: Final[str] = "shippable"

#: UD POS tags whose tokens are not ledger items. A full stop is not a word a learner has
#: to be taught, and a ledger that counts one admits **nothing**: every sentence ends in a
#: lemma no curriculum will ever introduce, so every candidate is blocked forever and the
#: stage reports a clean run with a 100% gap list. Measured on the es-mini fixture before
#: this line existed: 0 of 200 candidates admissible, 738 of 738 slots gapped, no error.
#: The G1 lane owns what goes into `analysed_sentence.lemmas`; this is the belt that stops
#: a disagreement about punctuation from reading as an empty corpus.
LEDGER_EXCLUDED_POS: Final[tuple[str, ...]] = ("PUNCT", "SYM", "SPACE", "X")

#: The segmentation the LEDGER must be run on, per language (EC-PACK-07, and the second
#: clause of INV-PACK-06: "Japanese runs the ledger on Mode-A segmentation").
#:
#: SudachiPy's Mode C glues a compound into one token, so `外国人観光客` is ONE "new item"
#: while three morphemes are being introduced — V2 counts 1, passes, and the learner meets
#: three unseen words in one exercise. Mode A splits it. The edge case's ruling is "Mode A
#: for the ledger, Mode C for display and audio; store both", so this is a constraint on
#: what the validators read, not a ban on Mode C anywhere in the pack.
#:
#: A language absent from this mapping has no segmentation modes (spaCy does not have
#: them) and its rows carry `split_mode: null`. The check is therefore a positive
#: requirement per language, never "whatever the adapter happened to say" — a ledger built
#: on the wrong segmentation passes V1 and V2 *vacuously*, which is the one failure mode
#: no amount of green makes visible.
LEDGER_SPLIT_MODE: Final[dict[str, str]] = {"ja": "A"}

#: "Short candidates" for the A1 length filter and for the yield measurement. `scope2/00`
#: §2.3 G0 puts A1 at 3-12 tokens; the same window defines the denominator of the yield
#: number, so "the ledger admits X% of short candidates" means X% of exactly these.
CANDIDATE_TOKENS_MIN: Final[int] = 3
CANDIDATE_TOKENS_MAX: Final[int] = 12

#: Prefer the shortest admissible sentence for an early slot and let later slots run
#: longer. Sorting by token count then by sentence id keeps selection deterministic —
#: two runs of the same build must produce the same pack, because the FSRS item ids in
#: `packages/core` are content-hashed and a reshuffle re-keys a learner's whole history.
SORT_BY_LENGTH_ASCENDING: Final[bool] = True

# ---------------------------------------------------------------------------
# Repetition — V9
# ---------------------------------------------------------------------------

#: No sentence may be used twice inside one unit. V9's "no duplicate sentence hash within
#: a unit" is enforced at selection, not only checked afterwards.
MAX_USES_PER_SENTENCE_PER_UNIT: Final[int] = 1

#: How often a sentence may come back in a LATER unit, as a fraction of all selected
#: items. Some repetition is recycling working as designed; a lot of it is a corpus that
#: ran out and a selector that hid it.
CROSS_UNIT_REPEAT_CEILING: Final[float] = 0.05

#: A sentence may be used ONCE in the whole course. Recycling is a property of lemmas, not
#: of sentences: V3 wants a word back, not the same sentence back, and a learner who meets
#: the identical string in unit 3 and unit 9 is being tested on recall of that string. The
#: cross-unit ratio above is therefore zero on anything this stage produces, and stays in
#: V9 as a guard on what G5 and G7 produce later.
MAX_USES_PER_SENTENCE_PER_COURSE: Final[int] = 1

# ---------------------------------------------------------------------------
# Gaps
# ---------------------------------------------------------------------------

#: A slot the corpus cannot fill is emitted with `gap: true` and `sentence_id: null`, for
#: G5. It is never dropped: an unfilled slot and a slot whose sentence was dropped are
#: different bugs, and a lesson that quietly got shorter is the one nobody notices.
GAP_PROVENANCE: Final[str] = "llm"
FILLED_PROVENANCE: Final[str] = "corpus"

#: Above this gap fraction the stage FAILS rather than handing G5 a course to write.
#: G5 is the only authoring stage and the plan budgets ~$100 of gap-fill per language;
#: a run that gaps most of its slots is a corpus or a ledger problem, and pushing it into
#: G5 turns a measurable pipeline failure into an invisible authoring bill.
MAX_GAP_FRACTION: Final[float] = 0.60

# ---------------------------------------------------------------------------
# The yield number
# ---------------------------------------------------------------------------

#: `deep/10` Open Question 1: "the framework estimates the ledger admits 5-15% of short
#: candidates … it is unmeasured, and it is now the most load-bearing untested assumption
#: in the content plan." G4 measures it and writes it to the runlog under this key. The
#: bounds are what the framework predicted, recorded so a run outside them is visible as a
#: prediction failure rather than as an ordinary number in a log.
YIELD_NOTE_KEY: Final[str] = "ledger_yield"
PREDICTED_YIELD_MIN: Final[float] = 0.05
PREDICTED_YIELD_MAX: Final[float] = 0.15
