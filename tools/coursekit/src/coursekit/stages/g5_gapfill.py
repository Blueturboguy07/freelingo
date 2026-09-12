"""G5 — gap-fill. The only stage in the pipeline that authors text.

G4 emits a gap list: lesson slots no corpus sentence can fill inside the unit's
vocabulary window. This stage fills them from candidates authored ahead of time into
`content/<lang>/candidates.jsonl` and `content/<lang>/candidates/*.jsonl`, and it fills
them by **generate-and-reject**, which is `deep/10` §S5's G5-A.

## One file per authoring lane, and two rules that make that safe

Four lanes author one Spanish course. They write `content/es/candidates/<lane>.jsonl`
and this stage reads the legacy single file first, then every shard in **sorted
filename order** — sorted because the first surviving candidate fills the slot, so an
unsorted listing would make the shipped sentence depend on directory order.

Two files naming the same `(slot, text)` is a **hard stop**, not a dedup: both lanes
believe they contributed one of that slot's twenty candidates, and quietly collapsing
them leaves the slot nineteen deep while the over-generation floor still reads twenty.

## A candidate for a slot that is not a gap is a FAILED stage

`orphan_authored_slots` used to be a runlog note and nothing else. It has to be a
failure, because the silence had a cost that is now measured: 160 rows keyed `u2/l1/s1`
against a fixture sat in the repository for a phase while G4's real gap list keyed that
slot `u2/l7/s1` — G4's lesson index is GLOBAL across the course (unit 2 is lessons 7-12)
and the fixture's was per unit. The two key spaces never intersected, so every authored
row filled nothing, and the phase reported "8 of 918 slots covered" when the honest
figure was zero. A stage handed content it cannot use says so by name.

## Generate-and-reject, and why there is no repair path

Closed-vocabulary constrained decoding does not exist against a hosted API: Outlines'
OpenAI backend is JSON-schema-only, and its Anthropic page documents no structured-output
types at all (softened by review R18 to "documents nothing", not "documented absence").
So the vocabulary constraint cannot be enforced *during* generation and has to be
enforced *after* it. Over-generate about twenty per slot, run every one through the
filters, keep what survives.

**INV-PACK-10: a candidate that fails an axis is discarded and resampled, never
patched.** The invariant's gate is "no repair path exists in the generator", and the
reason it is phrased as a property of the code rather than of the output is that a repair
path is invisible in the output — a patched sentence looks exactly like a sentence that
passed. Two things hold it here:

- `tests/test_g5_gapfill.py` parses this module and fails on a repair-shaped identifier
  or a string-mutating call, with `tests/falsifiers/INV-PACK-10.json` beside it so the
  scanner cannot pass by scanning nothing.
- The emitted texts are a subset of the authored texts, asserted over generated inputs.
  Every `text` this stage writes is the object it read; nothing constructs one.

Resampling is the loop itself: candidates are evaluated in file order and the slot is
filled by the first survivor, so a rejection costs the next candidate and nothing else.
A slot whose twenty candidates all fail is a **failed stage**, named, not a slot filled
by the least-bad option.

## Every candidate re-enters through the corpus path

`scope2/00` §2.3 requires that "every output re-enters at G6 identically to corpus
sentences". Identically means the same lemmatiser, the same length window and the same
ledger:

- lemmas come from the **G1 adapter registry**, the same analyser that produced
  `analysed_sentence` for every corpus row. If no adapter is registered for the language
  this stage fails loudly rather than whitespace-splitting — a whitespace "lemma" makes
  V1 pass vacuously, and for Japanese it makes a whole sentence one unknown token.
- the length window is G0's 3-12 token A1 filter, from the shared config, not a second
  looser number for authored text — with ONE derived exception, founder ruling B9(b): a
  slot whose permitted window holds no lemma the G2 lexicon tags `VERB` or `AUX` takes
  `MIN_TOKENS_VERBLESS_LESSON` instead of `MIN_TOKENS`, because the first lesson of the
  Spanish course permits five lemmas and none of them is a verb, and at three tokens the
  only strings inside that window are word lists. The upper bound never moves, the
  relaxation is computed from the gap row rather than declared by the author, and G0's
  ingest window is untouched: a corpus sentence is still filtered at three tokens.
- the ledger is the one G4 emitted on the row, not the one the author had in mind, which
  is what the `stale_ledger` axis is for: authoring happens offline, and a candidates
  file written against last week's curriculum must fail rather than fill. The authored
  row carries `ledger_digest` — 16 hex characters over the sorted `known | new` set —
  rather than a copy of the set itself. Same check, a witness that does not have to be
  re-spelled on all 9,800 rows, and one that cannot be edited into agreement.
  `coursekit gaps <lang>` prints the digest per slot; nothing but this stage enforces it.

## There is no model here

No API key for any provider exists in this environment, so the plan's ruling applies: the
Opus agent is the author. `author` on every row is that agent, `provenance` is `llm`, and
the manifest's machine-authored percentage is therefore a real count of real rows.
"""

from __future__ import annotations

import hashlib
import json
import os
from collections.abc import Iterable, Iterator, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from ..adapters import ADAPTERS
from ..artifacts import dedup_hash, read_records, write_records
from ..config.g5 import (
    AUTHORED_CANDIDATES_DIRNAME,
    AUTHORED_CANDIDATES_FILENAME,
    AUTHORED_PROVENANCE,
    AUTHORED_SHARD_SUFFIX,
    CONTENT_ROOT_DIRNAME,
    CONTENT_ROOT_ENV_VAR,
    LEDGER_DIGEST_CHARS,
    MAX_NEW_LEMMAS_PER_ITEM,
    MAX_TOKENS,
    MIN_CANDIDATES_PER_SLOT,
    MIN_TOKENS,
    MIN_TOKENS_VERBLESS_LESSON,
    OVERGENERATION_TARGET,
    REJECT_AXES,
    min_tokens_for_slot,
)
from ..inputs import MissingInput
from ..runlog import require_successful
from . import StageContext, StageResult, register_stage

__all__ = [
    "Slot",
    "authored_candidates_path",
    "authored_candidates_paths",
    "authored_shard_dir",
    "content_root",
    "gapfill",
    "ledger_digest",
    "pos_by_lemma",
]


@dataclass(frozen=True, slots=True)
class Slot:
    """A lesson slot, as G4 and the authored file both name it."""

    unit_index: int
    lesson_index: int
    slot_index: int

    @classmethod
    def of(cls, row: dict[str, Any]) -> Slot:
        return cls(
            unit_index=int(row["unit_index"]),
            lesson_index=int(row["lesson_index"]),
            slot_index=int(row["slot_index"]),
        )

    def __str__(self) -> str:
        return f"u{self.unit_index}/l{self.lesson_index}/s{self.slot_index}"


# ---------------------------------------------------------------------------
# Where the authored file lives
# ---------------------------------------------------------------------------


def content_root() -> Path:
    """`<repo>/content`, or `$COURSEKIT_CONTENT_ROOT`.

    Authored content is repository content, not build output: it is reviewed, it is
    licensed CC BY-NC-SA with the rest of the pack, and it survives `rm -rf build`.
    """
    override = os.environ.get(CONTENT_ROOT_ENV_VAR)
    if override:
        return Path(override)
    # `tools/coursekit/src/coursekit/stages/g5_gapfill.py` -> five parents is
    # `tools/coursekit`, six is the repository root. Same walk as
    # `artifacts._repo_root`, one directory deeper.
    return Path(__file__).resolve().parents[5] / CONTENT_ROOT_DIRNAME


def authored_candidates_path(lang: str) -> Path:
    """The legacy single file: `content/<lang>/candidates.jsonl`."""
    return content_root() / lang / AUTHORED_CANDIDATES_FILENAME


def authored_shard_dir(lang: str) -> Path:
    """`content/<lang>/candidates/` — one `.jsonl` per authoring lane."""
    return content_root() / lang / AUTHORED_CANDIDATES_DIRNAME


def authored_candidates_paths(lang: str) -> list[Path]:
    """Every authored file G5 reads, in the order it reads them.

    The legacy single file first, then every `*.jsonl` in the shard directory in SORTED
    filename order. Sorted, because the order candidates are evaluated in is the order
    slots get filled in: `gapfill` takes the first survivor per slot, so an unsorted
    directory listing would make a build's output depend on inode order and two machines
    would ship different sentences from identical inputs.
    """
    paths: list[Path] = []
    legacy = authored_candidates_path(lang)
    if legacy.exists():
        paths.append(legacy)
    shards = authored_shard_dir(lang)
    if shards.is_dir():
        paths.extend(
            sorted(path for path in shards.iterdir() if path.suffix == AUTHORED_SHARD_SUFFIX)
        )
    return paths


def pos_by_lemma(lang: str) -> dict[str, str]:
    """G2's consolidated UD tag per ledger lemma, or `{}` when G2 has not run.

    The input to `config.g5.min_tokens_for_slot`, which needs to know whether a slot's
    permitted vocabulary can hold a verb (founder ruling B9(b)). `banded_lemma` carries
    exactly one row per lemma — `g2_band.consolidate_pos` collapses a lemma's tags to the
    most frequent one and `assert_unique_keys` enforces the key — so this is a lookup and
    not a vote.

    **An empty map is not an error and it is not a silent degradation either.** Every
    caller treats an unknown tag as "this lemma could be a verb" and keeps the strict
    `MIN_TOKENS`, so a build with no G2 artefact gets the same length axis G5 has always
    had; the only thing it loses is the relaxation. The alternative — `require_successful`
    on g2 — would be a new upstream dependency for a stage whose product does not depend
    on G2 at all, and it would make every G5 test stage a banded lexicon to test an axis
    that has nothing to do with banding. The runlog records the row count so a reader can
    tell "no verb in the window" from "no lexicon to ask".
    """
    try:
        # `list(...)`, inside the `try`. `read_records` is a GENERATOR: it raises
        # `FileNotFoundError` on the first `next`, not at the call, so a `try` around the
        # call alone catches nothing and every G5 test that stages no G2 dies on the
        # comprehension instead. Measured, once, on this change.
        rows = list(read_records("banded_lemma", lang=lang))
    except FileNotFoundError:
        return {}
    return {str(row["lemma"]): str(row["pos"]) for row in rows}


def ledger_digest(known_lemmas: Iterable[str], new_lemmas: Iterable[str]) -> str:
    """The identity of one slot's permitted vocabulary, in `LEDGER_DIGEST_CHARS` hex.

    Over the SORTED UNION of the two lists, so it is a digest of the SET and not of the
    order G4 happened to emit. `known` and `new` are kept apart on the row and joined
    here because `allowed = known | new` is what the vocabulary axis tests against; the
    split matters to the new-item budget, not to the identity of the window.
    """
    allowed = sorted(set(known_lemmas) | set(new_lemmas))
    payload = "\x1f".join(allowed)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:LEDGER_DIGEST_CHARS]


# ---------------------------------------------------------------------------
# The authored row
# ---------------------------------------------------------------------------

#: Private, so `test_no_constant_lives_outside_config` leaves it alone, and local
#: because it is a contract with a file this lane also writes — unlike
#: `coursekit.artifacts`, nothing downstream reads this shape.
_AUTHORED_REQUIRED = (
    "slot",
    "ledger_digest",
    "new_lemmas",
    "text",
    "translation",
    "author",
    "generated_at",
    "provenance",
    "backtranslation",
)


def _read_one(path: Path) -> Iterator[tuple[int, dict[str, Any]]]:
    """Line number and row, for every non-blank line of one authored file."""
    with path.open(encoding="utf-8") as handle:
        for number, line in enumerate(handle, start=1):
            if not line or line.isspace():
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError as exc:
                raise MissingInput(f"{path.name} line {number}: {exc}") from exc
            missing = [key for key in _AUTHORED_REQUIRED if key not in row]
            if missing:
                raise MissingInput(
                    f"{path.name} line {number}: authored candidate is missing {', '.join(missing)}"
                )
            if row["provenance"] != AUTHORED_PROVENANCE:
                raise MissingInput(
                    f"{path.name} line {number}: provenance is {row['provenance']!r}; G5 "
                    f"emits {AUTHORED_PROVENANCE!r} and nothing else, because the "
                    f"manifest's machine-authored percentage is counted off this field"
                )
            yield number, row


def _read_authored(paths: Sequence[Path], lang: str) -> list[dict[str, Any]]:
    """Every authored row across the legacy file and the shards, in read order.

    Two DIFFERENT files naming the same `(slot, text)` is a hard stop, not a dedup. Both
    lanes believe they are supplying one of the twenty candidates that slot needs, so
    silently collapsing them leaves the slot NINETEEN deep while the over-generation floor
    reports twenty — the floor is the thing that stops a slot being filled by the
    least-bad option, and a floor that counts a sentence twice is not a floor. The message
    names both files, because "which of my four lanes wrote this" is the reader's only
    question.

    WITHIN one file the same pair is not an error, and the distinction is deliberate. One
    author over-generating twenty candidates for one slot will repeat themselves, and the
    stage already has a name and a counter for that: the `duplicate` reject axis, whose
    count is how anybody knows the ledger window is too tight. Raising there would delete
    a measurement and turn a normal authoring outcome into a build failure. A collision
    ACROSS files is a different event — two people, one slot, no coordination — and no
    axis can see it, because by the time `_axis` runs the rows have been pooled.
    """
    if not paths:
        content = content_root() / lang
        raise MissingInput(
            f"no authored gap-fill candidates for {lang!r}: neither "
            f"{content / AUTHORED_CANDIDATES_FILENAME} nor any "
            f"{content / AUTHORED_CANDIDATES_DIRNAME}/*{AUTHORED_SHARD_SUFFIX} exists. "
            f"G5 is the only authoring stage and it authors nothing at run time: with no "
            f"API key in this environment the candidates are written ahead of the build "
            f"(plan ruling), and a build that cannot find them must stop rather than "
            f"leave the gap list unfilled. `coursekit gaps {lang}` writes the brief that "
            f"says which slots need them."
        )
    rows: list[dict[str, Any]] = []
    origin: dict[tuple[int, int, int, str], tuple[Path, str]] = {}
    for path in paths:
        for number, row in _read_one(path):
            slot = Slot.of(row["slot"])
            key = (slot.unit_index, slot.lesson_index, slot.slot_index, str(row["text"]))
            first = origin.get(key)
            if first is not None and first[0] != path:
                raise MissingInput(
                    f"{path.name} line {number}: the candidate {row['text']!r} for {slot} "
                    f"was already supplied by {first[1]}. Two authored FILES naming the "
                    f"same (slot, text) is a collision between two authoring lanes, not a "
                    f"duplicate to drop: dropping it leaves the slot one candidate short "
                    f"of the over-generation floor of {MIN_CANDIDATES_PER_SLOT} while the "
                    f"count still reads {MIN_CANDIDATES_PER_SLOT}. Delete it from one of "
                    f"the two files. (The same pair twice inside ONE file is the "
                    f"`duplicate` reject axis's job, and is counted, not raised.)"
                )
            if first is None:
                origin[key] = (path, f"{path.name} line {number}")
            rows.append(row)
    return rows


def _candidate_id(lang: str, slot: Slot, text: str) -> str:
    """Content-addressed over language, slot and text.

    The slot is in the digest because the same sentence may legitimately be authored
    for two slots, and two rows sharing an id would make the reject rate unreadable.
    """
    payload = f"{lang}\x1f{slot.unit_index}\x1f{slot.lesson_index}\x1f{slot.slot_index}\x1f{text}"
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:16]


# ---------------------------------------------------------------------------
# The filter axes
# ---------------------------------------------------------------------------


def _analyse(analyser: Any, sentence_id: str, text: str) -> dict[str, Any]:
    """The G1 adapter's analysis of one authored sentence. Never a whitespace split.

    `analyse(*, sentence_id, text)` is the adapter contract — the one `g1_analyze` calls
    and the one `SpacyEsAdapter` implements. This function used to call `analyse(text)`
    positionally, which no registered adapter accepts, so G5 raised `TypeError:
    SpacyEsAdapter.analyse() takes 1 positional argument but 2 were given` the first time
    it met a real one. It had never met one: the test fixture supplied a shim with the
    wrong signature, so eleven green tests were testing the shim. The fixture now builds
    the registered adapter.

    It used to return `(lemmas, len(display_tokens))` and throw the rest away. The whole
    record is returned now because G7 needs it: `candidate.analysis` carries this pass
    forward across the G5 -> G7 boundary so that G7 resolves a gap by the lemma rather
    than by the surface at the gap index (founder ruling B16, option 2). Analysing once
    and carrying it is both cheaper than a second pass inside G7 and unable to disagree
    with itself.
    """
    return analyser.analyse(sentence_id=sentence_id, text=text)


def _token_count(analysis: Mapping[str, Any]) -> int:
    """The length axis's unit: `display_tokens`, the lexical surfaces.

    Punctuation is in `tokens[]` with its offsets because the grader needs the spans, and
    counting it would make "the same 3-12 window as a corpus sentence" a different window
    in practice.
    """
    words = analysis.get("display_tokens")
    return len(words) if words is not None else len(analysis["lemmas"])


def _candidate_analysis(analysis: Mapping[str, Any]) -> dict[str, Any]:
    """G1's `analysed_sentence` narrowed to the four fields `CandidateAnalysis` holds.

    `adapter` is called `analyser` on a candidate and the record's own identity fields
    (`schema_version`, `sentence_id`, `lang`) are dropped: the candidate already carries
    its own. `CandidateAnalysis` is closed, so this is a projection and not a copy.
    """
    return {
        "analyser": analysis["adapter"],
        "tokens": list(analysis["tokens"]),
        "lemmas": list(analysis["lemmas"]),
        "display_tokens": list(analysis["display_tokens"]),
    }


def _axis(
    authored: dict[str, Any],
    gap: dict[str, Any],
    analyser: Any,
    seen_in_unit: set[str],
    sentence_id: str,
    min_tokens: int,
) -> tuple[str | None, dict[str, Any] | None]:
    """The first axis this candidate fails (or `None`), and the analysis behind it.

    Evaluated in `REJECT_AXES` order and short-circuited: `stale_ledger` has to come
    first, because every axis below it would otherwise be measured against a vocabulary
    the build no longer has and would pass for the wrong reason.

    `min_tokens` is the slot's lower bound, not the module's: `config.g5.
    min_tokens_for_slot` returns `MIN_TOKENS_VERBLESS_LESSON` for a window that cannot
    hold a verb (founder ruling B9(b)). It is a PARAMETER rather than a lookup inside
    here so that the relaxation is decided once per slot, in front of the reader, next to
    the gap row it was derived from — a per-candidate lookup would let two candidates for
    one slot be measured against two different windows.

    The second element is what the row's `analysis` field gets, and it is `None` for
    exactly the rows the analyser never ran on — the two `stale_ledger` returns above
    the `_analyse` call. That is why `candidate.analysis` is nullable rather than
    optional: a stale row is still WRITTEN, because the reject rate is the number that
    says the ledger window is too tight, and no schema keyword can say "non-null exactly
    when G7 will read it".
    """
    allowed = set(gap["known_lemmas"]) | set(gap["new_lemmas"])
    if authored["ledger_digest"] != ledger_digest(gap["known_lemmas"], gap["new_lemmas"]):
        return "stale_ledger", None
    if set(authored["new_lemmas"]) != set(gap["new_lemmas"]):
        # Same window, different idea of which lemmas are the NEW ones. The author
        # wrote to a budget of one new lemma per item against a different set, so the
        # budget axis below would be measured against the wrong thing.
        return "stale_ledger", None

    analysis = _analyse(analyser, sentence_id, authored["text"])
    carried = _candidate_analysis(analysis)
    lemmas = list(analysis["lemmas"])
    token_count = _token_count(analysis)

    unknown = [lemma for lemma in lemmas if lemma not in allowed]
    if unknown:
        return "out_of_vocabulary", carried

    introduced = {lemma for lemma in lemmas if lemma in set(gap["new_lemmas"])}
    if len(introduced) > MAX_NEW_LEMMAS_PER_ITEM:
        return "new_lemma_budget", carried

    if not min_tokens <= token_count <= MAX_TOKENS:
        return "length", carried

    if dedup_hash(authored["text"]) in seen_in_unit:
        return "duplicate", carried

    return None, carried


# ---------------------------------------------------------------------------
# The stage
# ---------------------------------------------------------------------------


def _gaps(lang: str) -> Iterator[dict[str, Any]]:
    for row in read_records("selected_item", lang=lang):
        if row["gap"]:
            yield row


@register_stage("g5", reads=("selected_item",), writes=("candidate",))
def gapfill(ctx: StageContext) -> StageResult:
    """Fill G4's gap list by generate-and-reject. Writes every candidate, kept or not."""
    require_successful(ctx.lang, ("g4",))

    analyser_factory = ADAPTERS.get(ctx.lang)
    if analyser_factory is None:
        raise MissingInput(
            f"no morphology adapter is registered for {ctx.lang!r}, so a candidate "
            f"cannot be lemmatised the way a corpus sentence was. There is no "
            f"whitespace fallback by design: whitespace 'lemmas' make V1 pass vacuously "
            f"and, for ja, make a whole sentence one unknown token. Register one in "
            f"coursekit/adapters/ (G1's lane)."
        )
    analyser = analyser_factory()

    paths = authored_candidates_paths(ctx.lang)
    authored = _read_authored(paths, ctx.lang)
    for path in paths:
        ctx.entry.record_input(str(path))

    by_slot: dict[Slot, list[dict[str, Any]]] = {}
    for row in authored:
        by_slot.setdefault(Slot.of(row["slot"]), []).append(row)

    gaps = list(_gaps(ctx.lang))
    lexicon_pos = pos_by_lemma(ctx.lang)
    records: list[dict[str, Any]] = []
    rejected_by_axis = dict.fromkeys(REJECT_AXES, 0)
    seen_by_unit: dict[int, set[str]] = {}
    filled: list[str] = []
    unfilled: list[str] = []
    thin: list[str] = []
    verbless: list[str] = []

    for gap in gaps:
        slot = Slot.of(gap)
        # Per slot, once, before any candidate is measured. B9(b): a lesson whose
        # permitted window holds no VERB or AUX may be words and fixed phrases.
        min_tokens = min_tokens_for_slot(gap["known_lemmas"], gap["new_lemmas"], lexicon_pos)
        if min_tokens != MIN_TOKENS:
            verbless.append(str(slot))
        pool = by_slot.get(slot, [])
        if len(pool) < MIN_CANDIDATES_PER_SLOT:
            thin.append(f"{slot} ({len(pool)})")
            continue

        seen = seen_by_unit.setdefault(int(gap["unit_index"]), set())
        slot_filled = False
        for row in pool:
            candidate_id = _candidate_id(ctx.lang, slot, row["text"])
            axis, analysis = _axis(row, gap, analyser, seen, candidate_id, min_tokens)
            accepted = axis is None
            if accepted:
                seen.add(dedup_hash(row["text"]))
                if not slot_filled:
                    slot_filled = True
                    filled.append(str(slot))
            else:
                rejected_by_axis[axis] += 1
            records.append(
                {
                    "schema_version": 1,
                    "lang": ctx.lang,
                    "candidate_id": candidate_id,
                    "unit_index": slot.unit_index,
                    "lesson_index": slot.lesson_index,
                    "slot_index": slot.slot_index,
                    "text": row["text"],
                    "translation": row["translation"],
                    "author": row["author"],
                    "generated_at": row["generated_at"],
                    "accepted": accepted,
                    "reject_reason": None if accepted else axis,
                    "provenance": AUTHORED_PROVENANCE,
                    "analysis": analysis,
                }
            )
        if not slot_filled:
            unfilled.append(str(slot))

    written = write_records("candidate", records, lang=ctx.lang)
    ctx.entry.record_output("candidate")
    ctx.entry.read = len(authored)
    ctx.entry.written = written
    ctx.entry.rejected = sum(rejected_by_axis.values())

    gap_slots = {Slot.of(gap) for gap in gaps}
    orphans = sorted(
        (str(slot) for slot in by_slot if slot not in gap_slots),
        key=lambda name: (len(name), name),
    )
    ctx.entry.note(
        author=sorted({row["author"] for row in authored}),
        authoring_files=[str(path) for path in paths],
        overgeneration_target=OVERGENERATION_TARGET,
        gap_slots=len(gaps),
        filled_slots=len(filled),
        unfilled_slots=unfilled,
        thin_slots=thin,
        # B9(b), in the artefact. Three numbers rather than one, because "no verb in the
        # window" and "no G2 lexicon to ask" produce the same strict floor and must not
        # read the same afterwards: `lexicon_pos_rows: 0` is the second one.
        token_window=[MIN_TOKENS, MAX_TOKENS],
        min_tokens_verbless_lesson=MIN_TOKENS_VERBLESS_LESSON,
        verbless_slots=verbless,
        lexicon_pos_rows=len(lexicon_pos),
        orphan_authored_slots=orphans,
        rejected_by_axis=rejected_by_axis,
        reject_rate=round(sum(rejected_by_axis.values()) / written, 4) if written else 0.0,
        # INV-PACK-10, stated in the artefact as well as enforced by the test. Phrased
        # as the positive property rather than as the absence of a repair path, because
        # the scanner in tests/test_g5_gapfill.py fails this module on a repair-shaped
        # IDENTIFIER — and a note key that had to be exempted from the gate would be the
        # first hole in it.
        discard_and_resample=True,
        emitted_text_is_authored_verbatim=True,
    )

    # ORPHANS FIRST, and as a FAILURE. An authored slot that is not in G4's gap list used
    # to be counted into a runlog note and otherwise ignored — the stage read the rows,
    # filled nothing with them, and reported on the gaps it did have. That silence is how
    # 160 rows keyed `u2/l1/s1` against a fixture rode in the repository for a phase while
    # G4's real gap list keyed the same slot `u2/l7/s1`: the two key spaces never
    # intersected, every authored row was an orphan, and the number the phase reported was
    # "8 of 918 slots covered" when the true figure was zero. A stage that is handed
    # content it cannot use must say so; the reader's question is not "how many gaps are
    # left" but "why did none of what I wrote count".
    #
    # THE MESSAGE NAMES THE CHECK, NOT ONE OF ITS CAUSES. It used to open with the
    # per-unit-vs-global keying explanation as a statement of fact, because that was the
    # bug in front of whoever wrote it. There are two ways to be an orphan and the stage
    # cannot tell them apart from here: the rows may be keyed in a numbering G4 does not
    # use (the 2026-09-11 case), or the ledger may have moved under correctly-keyed rows
    # so that the slot stopped existing (B19, 2026-09-12 — a curriculum or lemmatiser
    # change re-cuts G4's gap list, and 18 authored slots ceased to be gaps). The first
    # phrasing misdiagnosed the second case for a whole round: it sent a reader to re-key
    # a file that was already correctly keyed. So the message states the observation,
    # offers both explanations as possibilities, and hands over the one cheap
    # discriminator between them — all of the file orphaned is a key-space mismatch, some
    # of it orphaned is a ledger that moved.
    if orphans:
        return StageResult(
            ok=False,
            message=(
                f"{len(orphans)} authored slot(s) are not in this build's gap list: "
                f"{', '.join(orphans)}. Nothing here is filled by a candidate written for "
                f"another slot (INV-PACK-10). Two causes produce this and the stage cannot "
                f"tell them apart: (1) the ledger moved since these rows were written, so "
                f"the slot no longer exists — a curriculum or lemmatiser change re-cuts "
                f"G4's gap list, and rows for a slot that is gone belong in "
                f"`content/{ctx.lang}/candidates-orphaned/`, not in a neighbouring window; "
                f"or (2) the file is keyed in a lesson numbering G4 does not use — G4 emits "
                f"a GLOBAL lesson index (unit 2 is lessons 7-12, unit 3 is 13-18), so a "
                f"file keyed per unit names slots that do not exist. Diff against "
                f"`coursekit gaps {ctx.lang}`: if every slot in a file is an orphan it is "
                f"(2) and the file is re-keyed; if some are and the rest matched, it is (1) "
                f"and the orphans are retired."
            ),
        )
    if thin:
        return StageResult(
            ok=False,
            message=(
                f"{len(thin)} slot(s) authored below the over-generation floor of "
                f"{MIN_CANDIDATES_PER_SLOT}: {', '.join(thin)}. Generate-and-reject has "
                f"nothing to resample from, and the alternative is patching."
            ),
        )
    if unfilled:
        return StageResult(
            ok=False,
            message=(
                f"{len(unfilled)} slot(s) exhausted every candidate: "
                f"{', '.join(unfilled)}. Widen the ledger window or author more; a slot "
                f"is never filled by the least-bad rejected candidate."
            ),
        )
    return StageResult(
        ok=True,
        message=f"{len(filled)}/{len(gaps)} slots filled from {written} candidates",
        detail={"rejected_by_axis": rejected_by_axis},
    )
