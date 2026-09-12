"""`coursekit sample <lang>` — the stratified reviewer sheet (H1), and its score reader.

`scope2/00` §2.4, H1: *"Human: stratified sample of N items reviewed by a native speaker;
measured defect rate written into the manifest"*, and the plan's non-negotiable 5: content
ships only through `coursekit validate` **and** a sample with a ≤2% wrong-item gate,
*"the measured rate is shown to the learner"*.

Two design decisions carry the weight.

**Stratified over three dimensions, not one.** A sample uniform over units but drawn only
from `translate` exercises says nothing about the word bank; one drawn only from corpus
sentences says nothing about the gap-filled ones, which are the rows most likely to be
wrong and the entire reason a rate is published at all. So the strata are
`(unit_index, exercise_type, provenance)` and every non-empty stratum gets at least one
row while the budget allows.

**Deterministic under a recorded seed.** A sample that cannot be redrawn cannot be
audited: a reviewer scores 300 rows, a maintainer re-runs the draw six weeks later, and
the two sets have to be the same 300 or the published rate belongs to no measurable
population. The seed is a named constant, it is written into the sheet, and the draw is
a `random.Random(seed)` over a population sorted by a stable key.

**This run has no paid native reviewer.** The scores in `content/<lang>/review/` come
from the phase's Opus reviewer agent against `RUBRIC.md`, so every rate this module
produces carries `PROVISIONAL (unreviewed by a paid native speaker)` — see
`config/sample.py`, which owns that string because it has to appear identically
everywhere it is shown — two carriers today (`docs/pack-provenance.md` and the coursekit
README, both asserted verbatim by `tests/test_sample.py`) and two still to be built (the
S001 card at P3, the manifest's `review` block at G9).
"""

from __future__ import annotations

import json
import random
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .artifacts import artifact_path, read_records, run_dir
from .config import MAX_DEFECT_RATE, REVIEWER_SAMPLE_ITEMS
from .config.sample import (
    ACCENT_DIMENSION,
    ACCENT_UNSCOREABLE_NO_BAKE,
    ACCENT_UNSCOREABLE_NO_SHEET,
    ACCENT_UNSCOREABLE_UNSCORED,
    AUDIO_ENGINE_NONE,
    DEFECT_VERDICTS,
    PROVISIONAL_DEFECT_RATE_NOTE,
    RECORDED_REVIEWER_KINDS,
    REVIEW_DIMENSION_VALUES,
    REVIEW_DIMENSIONS,
    REVIEW_DIR_TEMPLATE,
    REVIEW_VERDICTS,
    REVIEWER_KIND_AGENT,
    REVIEWER_KIND_PAID_NATIVE,
    RUBRIC_FILENAME,
    SAMPLE_FILENAME_TEMPLATE,
    SAMPLE_SEED,
    SAMPLE_STRATA,
    SAMPLE_SUMMARY_FILENAME,
    SCORES_FILENAME,
)

# KNOWN TEST-INFRA HAZARD, recorded rather than papered over (docs/owned/
# p2-validate-ci.json -> knownHazards). `Registry.restore_for_tests()` evicts the
# discovered validator modules from `sys.modules` so their registrations re-run on the
# next import, which produces a SECOND `SuiteInputMissing` class object. These names are
# bound here at import time, so both halves of this module stay internally consistent
# (the pre-eviction `shipped_items` raises the pre-eviction class) and nothing fails
# today. It would fail the day an `except SuiteInputMissing` crosses that boundary. The
# fix is to move the exception into a module the registry never evicts; that module does
# not exist yet and `coursekit/__init__.py` is not this lane's file.
from .validators.pack import ShippedItem, SuiteInputMissing, shipped_items

__all__ = [
    "SampleItem",
    "SampleSheet",
    "ScoreError",
    "accent_scoring_violations",
    "accent_summary",
    "derive_accent",
    "allocate",
    "draw_sample",
    "review_summary",
    "read_scores",
    "sample_path",
    "sheet_audio_ids",
    "sheet_exercise_ids",
    "write_sample",
]


class ScoreError(ValueError):
    """A scores file that does not match the rubric's contract."""


@dataclass(frozen=True, slots=True)
class SampleItem:
    """One row a reviewer scores.

    The last six fields are the clip, and they exist because of founder ruling **B6**:
    Spanish bakes on Kokoro, whose Spanish voices declare no region, so the manifest says
    `language: es` + `accent_claim: unverified` and NOTHING in `coursekit` listens to the
    bank. `RUBRIC.md` §`accent_consistency` is the only accent check the project has, and
    until this lane it was a column a reviewer could not fill in: the sheet named no clip
    and no role (`docs/P2-BLOCKERS.md` B18), so `cast.yaml`'s `D-CAST-ES-02` question —
    does Rosa read as a different speaker from Plumas, when 70% of her style vector IS
    Plumas — could not be put to anybody.

    Every one of the six is `None` together or set together, and the join that sets them
    is three-legged, which is the point:

    * the exercise's `audio_ref` (G7) says which clip this row WOULD be spoken by;
    * the `baked_clip` record (G8) says which clips a bake actually produced, with the
      engine and the voice spec that produced them;
    * the cast (`content/<lang>/cast.yaml`) turns that voice spec back into a role and
      the display name the rubric asks about by name.

    A promise from G7 is not a clip. `audio_ref` is present on every audio-bearing
    exercise the moment G7 runs, months before any bake, so a sheet that copied it would
    hand a reviewer sixteen hex characters and no bytes — and `"pass"` on a clip nobody
    played is the one lie this sheet exists to prevent. So `clip_path` is set only when
    the file is on disk at draw time, and `has_audio` reads `clip_path`, never
    `clip_id`.
    """

    exercise_id: str
    unit_index: int
    lesson_index: int
    exercise_type: str
    provenance: str
    prompt: str
    accepted_answers: tuple[str, ...]
    distractors: tuple[str, ...]
    source_text: str
    source_translation: str
    #: The baked clip id (16 hex), or `None` when no bake produced this row's clip.
    #: Content-addressed over the engine, its pin, the voice spec, the codec, the
    #: bitrate, the loudness target and the text (INV-AUD-08 via `tts.cast.rebake_key`),
    #: so a row re-drawn after an engine swap carries a DIFFERENT id and last bake's
    #: accent verdict cannot join onto it.
    clip_id: str | None = None
    #: Where to listen, relative to the language's run directory (`g8/bank/<id>.opus`).
    #: `None` means the bytes are not there, whatever the exercise promised.
    clip_path: str | None = None
    #: The cast role speaking it (`narrator`), and its display name (`Plumas`).
    voice_role: str | None = None
    voice_name: str | None = None
    #: The engine that ACTUALLY synthesised the clip, recorded per row rather than
    #: assumed from the cast file, in the spirit of INV-PACK-14: a bank half-baked by a
    #: second engine is visible on the rows, not only in a header nobody re-reads.
    clip_engine: str | None = None
    #: What the clip SAYS. Not always the prompt or the first accepted answer — a
    #: `listen_for_the_missing_word` row plays the whole sentence while accepting one
    #: token (`config/g8.py::SPOKEN_TEXT_SOURCE`), and a reviewer judging "is this the
    #: same accent" needs the line they are hearing.
    clip_text: str | None = None

    @property
    def stratum(self) -> tuple[int, str, str]:
        return (self.unit_index, self.exercise_type, self.provenance)

    @property
    def has_audio(self) -> bool:
        """Is there something to listen to? The only licence for an accent score."""
        return self.clip_path is not None

    def to_json(self) -> dict[str, Any]:
        return {
            "exercise_id": self.exercise_id,
            "unit_index": self.unit_index,
            "lesson_index": self.lesson_index,
            "exercise_type": self.exercise_type,
            "provenance": self.provenance,
            "prompt": self.prompt,
            "accepted_answers": list(self.accepted_answers),
            "distractors": list(self.distractors),
            "source_text": self.source_text,
            "source_translation": self.source_translation,
            "clip_id": self.clip_id,
            "clip_path": self.clip_path,
            "voice_role": self.voice_role,
            "voice_name": self.voice_name,
            "clip_engine": self.clip_engine,
            "clip_text": self.clip_text,
            "has_audio": self.has_audio,
            "stratum": f"{self.unit_index}|{self.exercise_type}|{self.provenance}",
        }


@dataclass(frozen=True, slots=True)
class SampleSheet:
    """The drawn sheet, with everything needed to redraw it."""

    lang: str
    requested: int
    seed: int
    strata: tuple[str, ...]
    population: int
    items: tuple[SampleItem, ...]
    allocation: dict[str, int]

    @property
    def drawn(self) -> int:
        return len(self.items)

    @property
    def audio_rows(self) -> int:
        """How many drawn rows a reviewer can actually listen to."""
        return sum(1 for item in self.items if item.has_audio)

    @property
    def audio_engines(self) -> tuple[str, ...]:
        """The engines that baked this sheet's clips. Empty when none did.

        A tuple rather than a string because the failure worth seeing is TWO: a bank
        half re-baked by a second synthesiser under one `accent_claim` is EC-PACK-52,
        and it is invisible in a header that names one engine.
        """
        return tuple(sorted({item.clip_engine for item in self.items if item.clip_engine}))

    def summary(self) -> dict[str, Any]:
        return {
            "lang": self.lang,
            "requested": self.requested,
            "drawn": self.drawn,
            "population": self.population,
            "seed": self.seed,
            "strata": list(self.strata),
            "distinct_strata": len(self.allocation),
            "allocation": dict(sorted(self.allocation.items())),
            # The accent half of the sheet, written down at draw time so that a rate
            # quoted later can be checked against what the reviewer was actually given.
            "audio_rows": self.audio_rows,
            "audio_engines": list(self.audio_engines),
        }


@dataclass(frozen=True, slots=True)
class _Clip:
    """One baked clip, as the sheet needs it: where it is, who said it, what it says."""

    clip_id: str
    path: str | None
    role: str | None
    name: str | None
    engine: str
    text: str


def _roles_by_voice(lang: str) -> dict[str, tuple[str, str]]:
    """`voice_id -> (role id, display name)`, from the cast file. `{}` when there is none.

    Imported inside the function on purpose. `tts.cast` is cheap (yaml and hashlib), but
    `coursekit sample` must keep working on a checkout whose `tts` dependency group was
    never synced, and a module-level import here would make the whole command's fate
    depend on a neighbour's imports. A missing or unreadable cast costs the sheet the
    ROLE NAMES and nothing else: the clip, its path and its engine still come from the
    bake, so a reviewer can still listen. They just cannot be asked the Rosa question.
    """
    try:
        from .tts.cast import CastError, load_cast
    except ImportError:  # pragma: no cover - the tts module has no optional imports today
        return {}
    try:
        cast = load_cast(lang)
    except (CastError, FileNotFoundError, OSError):
        return {}
    return {role.voice_id: (role.id, role.display_name) for role in cast.roles}


def _clips(lang: str) -> dict[str, _Clip]:
    """Every clip THIS build baked, keyed by clip id. `{}` when G8 never ran.

    The emptiness is load-bearing. "No bake existed" has to reach the sheet as `null` on
    every clip field, which the accent dimension then reports as unscoreable — rather
    than as an absent key a reader mistakes for a clean result, which is the reading
    INV-PACK-14 exists to fail on the grammar engine and this is the same sentence about
    the voice engine.
    """
    path = artifact_path(lang, "baked_clip")
    if not path.exists():
        return {}
    roles = _roles_by_voice(lang)
    root = run_dir(lang) / "g8"
    clips: dict[str, _Clip] = {}
    for record in read_records("baked_clip", lang=lang):
        role, name = roles.get(record["voice_id"], (None, None))
        relative = str(record["path"])
        # A record without bytes is not a clip a reviewer can score. The bank is
        # gitignored and CI uploads it as an artefact with a one-day retention
        # (`docs/ci.md`), so "the manifest remembers it" and "it is here to play" come
        # apart routinely, and only the second one licenses a verdict.
        on_disk = (root / relative).exists()
        clips[record["clip_id"]] = _Clip(
            clip_id=record["clip_id"],
            path=f"g8/{relative}" if on_disk else None,
            role=role,
            name=name,
            engine=record["engine"],
            text=record["text"],
        )
    return clips


def _population(lang: str) -> tuple[SampleItem, ...]:
    """Every exercise in the build, with its provenance resolved.

    Provenance comes from the shipped-item join rather than from the exercise row: an
    exercise carries `source_sentence_id`, and the same 16-hex id space holds corpus
    sentence ids and G5 candidate ids. Resolving it here means the sheet can be
    stratified by the thing that actually predicts a defect.
    """
    path = artifact_path(lang, "exercise")
    if not path.exists():
        raise SuiteInputMissing(
            f"no exercise artefact at {path}; `coursekit sample` draws from G7 output, "
            f"so run `coursekit build {lang}` first. Drawing from nothing would produce "
            f"an empty sheet and a defect rate of 0%."
        )
    provenance: dict[str, str] = {}
    texts: dict[str, ShippedItem] = {}
    for item in shipped_items(lang):
        if item.item_id:
            provenance[item.item_id] = item.provenance
            texts[item.item_id] = item

    clips = _clips(lang)
    rows: list[SampleItem] = []
    for record in read_records("exercise", lang=lang):
        source = record["source_sentence_id"]
        origin = texts.get(source) if source else None
        # `audio_ref` is G7's promise; `clips` is G8's fact. The row gets the clip only
        # where the two agree, so an exercise naming a clip that was never baked —
        # exactly the state G9 refused a pack over on 2026-09-12 — reaches the reviewer
        # as "nothing to listen to" rather than as a broken path.
        clip = clips.get(record["audio_ref"]) if record["audio_ref"] else None
        rows.append(
            SampleItem(
                exercise_id=record["exercise_id"],
                unit_index=record["unit_index"],
                lesson_index=record["lesson_index"],
                exercise_type=record["type"],
                provenance=provenance.get(source or "", "unknown"),
                prompt=record["prompt"],
                accepted_answers=tuple(record["accepted_answers"]),
                distractors=tuple(record["distractors"]),
                source_text=origin.text if origin else "",
                source_translation=origin.translation if origin else "",
                clip_id=clip.clip_id if clip else None,
                clip_path=clip.path if clip else None,
                voice_role=clip.role if clip else None,
                voice_name=clip.name if clip else None,
                clip_engine=clip.engine if clip else None,
                clip_text=clip.text if clip else None,
            )
        )
    return tuple(rows)


def _coarse_first_order(keys: Iterable[str]) -> list[str]:
    """Stratum keys, round-robin over the FIRST dimension (the unit).

    Not key order, and the difference is a bug that was measured rather than imagined: a
    5-unit build with 8 exercise types and 2 provenances has ~80 strata, and a 40-row
    sheet allocated one-each in lexicographic order fills up inside units 1 to 4 and
    never reaches unit 5. A sample that stops before the end of the course cannot measure
    the end of the course — and the later units are the ones built on the most
    accumulated vocabulary, so they are where drift lands.

    So: one stratum from each unit, then a second from each unit, and so on. Within a
    unit the order is the stratum key, which puts exercise type before provenance.
    """
    groups: dict[str, list[str]] = {}
    for key in sorted(keys):
        groups.setdefault(key.split("|", 1)[0], []).append(key)

    def group_sort(name: str) -> tuple[int, int | str]:
        return (0, int(name)) if name.isdigit() else (1, name)

    ordered: list[str] = []
    names = sorted(groups, key=group_sort)
    depth = 0
    while any(len(groups[name]) > depth for name in names):
        for name in names:
            if len(groups[name]) > depth:
                ordered.append(groups[name][depth])
        depth += 1
    return ordered


def allocate(sizes: Mapping[str, int], n: int) -> dict[str, int]:
    """Split `n` across strata: one each while the budget allows, then largest remainder.

    Three properties, all asserted in `tests/test_sample.py`:

    * the allocation sums to `min(n, total population)` — the sheet is the size it says;
    * no stratum is allocated more rows than it has — a stratum of 2 never owes 3;
    * when the budget is smaller than the number of strata, the rows it does have are
      spread across every unit rather than piled into the first few (`_coarse_first_order`).

    Ties in the remainder are broken by stratum key, so the result is a function of the
    population and `n` alone. That is what makes the seed the *only* source of variation.
    """
    keys = sorted(sizes)
    total = sum(sizes[key] for key in keys)
    target = min(n, total)
    if target <= 0:
        return {key: 0 for key in keys}

    # One per non-empty stratum, spread across units, while the budget lasts.
    allocation = {key: 0 for key in keys}
    remaining = target
    for key in _coarse_first_order(keys):
        if remaining == 0:
            break
        if sizes[key] > 0:
            allocation[key] = 1
            remaining -= 1

    # The rest proportionally to the unallocated remainder of each stratum.
    while remaining > 0:
        headroom = {key: sizes[key] - allocation[key] for key in keys}
        available = sum(value for value in headroom.values() if value > 0)
        if available == 0:
            break
        shares = {
            key: (headroom[key] / available) * remaining for key in keys if headroom[key] > 0
        }
        whole = {key: min(int(value), headroom[key]) for key, value in shares.items()}
        handed = sum(whole.values())
        if handed == 0:
            # Every share is below 1: give the remaining rows to the largest fractions.
            order = sorted(shares, key=lambda key: (-shares[key], key))
            for key in order[:remaining]:
                whole[key] = 1
            handed = sum(whole.values())
        for key, value in whole.items():
            allocation[key] += value
        remaining -= handed
    return allocation


def draw_sample(
    lang: str,
    *,
    n: int = REVIEWER_SAMPLE_ITEMS,
    seed: int = SAMPLE_SEED,
) -> SampleSheet:
    """Draw a stratified, reproducible sheet of `n` items."""
    if n <= 0:
        raise ValueError(f"sample size must be positive, got {n}")
    population = _population(lang)
    if not population:
        raise SuiteInputMissing(
            f"{lang}: the exercise artefact is empty, so there is nothing to sample. An "
            f"empty sheet scores 0 wrong items out of 0, which is a defect rate that "
            f"means nothing and reads as a perfect pack."
        )

    buckets: dict[str, list[SampleItem]] = {}
    for item in sorted(
        population,
        key=lambda row: (row.unit_index, row.lesson_index, row.exercise_type, row.exercise_id),
    ):
        key = f"{item.unit_index}|{item.exercise_type}|{item.provenance}"
        buckets.setdefault(key, []).append(item)

    allocation = allocate({key: len(rows) for key, rows in buckets.items()}, n)
    rng = random.Random(seed)
    drawn: list[SampleItem] = []
    for key in sorted(buckets):
        quota = allocation[key]
        if quota <= 0:
            continue
        drawn.extend(rng.sample(buckets[key], quota))
    drawn.sort(key=lambda row: (row.unit_index, row.lesson_index, row.exercise_id))

    return SampleSheet(
        lang=lang,
        requested=n,
        seed=seed,
        strata=SAMPLE_STRATA,
        population=len(population),
        items=tuple(drawn),
        allocation=allocation,
    )


def sample_path(lang: str, n: int) -> Path:
    """`<build root>/<lang>/sample-<n>.jsonl`."""
    return run_dir(lang) / SAMPLE_FILENAME_TEMPLATE.format(n=n)


def write_sample(sheet: SampleSheet) -> tuple[Path, Path]:
    """Write the sheet and its summary. Returns both paths."""
    target = sample_path(sheet.lang, sheet.requested)
    target.parent.mkdir(parents=True, exist_ok=True)
    with target.open("w", encoding="utf-8") as handle:
        for item in sheet.items:
            handle.write(json.dumps(item.to_json(), ensure_ascii=False, sort_keys=True) + "\n")
    summary = run_dir(sheet.lang) / SAMPLE_SUMMARY_FILENAME
    summary.write_text(
        json.dumps(sheet.summary(), ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    return (target, summary)


# ---------------------------------------------------------------------------
# Scores
# ---------------------------------------------------------------------------


def review_dir(lang: str, repo_root: Path | None = None) -> Path:
    root = repo_root or Path(__file__).resolve().parents[4]
    return root / REVIEW_DIR_TEMPLATE.format(lang=lang)


def read_scores(lang: str, repo_root: Path | None = None) -> list[dict[str, Any]]:
    """Read `content/<lang>/review/scores.jsonl`, validating every row.

    An absent file is an empty list: "nobody has reviewed this language" is a legitimate
    state and the summary below reports it as such. A malformed row is an error, because
    a verdict this module cannot read is a verdict that silently drops out of the
    denominator.
    """
    path = review_dir(lang, repo_root) / SCORES_FILENAME
    if not path.exists():
        return []
    rows: list[dict[str, Any]] = []
    for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        if not line.strip() or line.lstrip().startswith("//"):
            continue
        try:
            row = json.loads(line)
        except json.JSONDecodeError as exc:
            raise ScoreError(f"{path.name} line {number}: {exc}") from exc
        missing = {"exercise_id", "verdict", "reviewer"} - set(row)
        if missing:
            raise ScoreError(f"{path.name} line {number}: missing {', '.join(sorted(missing))}")
        if row["verdict"] not in REVIEW_VERDICTS:
            raise ScoreError(
                f"{path.name} line {number}: verdict {row['verdict']!r} is not one of "
                f"{', '.join(REVIEW_VERDICTS)} (see {RUBRIC_FILENAME})"
            )
        for dimension, value in row.get("dimensions", {}).items():
            if dimension not in REVIEW_DIMENSIONS:
                raise ScoreError(
                    f"{path.name} line {number}: {dimension!r} is not a rubric dimension "
                    f"({', '.join(REVIEW_DIMENSIONS)})"
                )
            # `null` is legal and it is not a score: it is how a reviewer says "this
            # dimension could not be judged on this row", which for `accent_consistency`
            # is every row on a sheet drawn before a bake. Anything else that is not
            # `pass` or `fail` is a value nothing downstream can count, and it is
            # refused here rather than silently read as truthy by the first caller that
            # asks "how many passed?".
            if value is not None and value not in REVIEW_DIMENSION_VALUES:
                raise ScoreError(
                    f"{path.name} line {number}: {dimension} is {value!r}, which is not "
                    f"{' or '.join(REVIEW_DIMENSION_VALUES)} — or null, which means the "
                    f"dimension could not be scored on this row (see {RUBRIC_FILENAME})"
                )
        rows.append(row)
    return rows


def sheet_exercise_ids(lang: str, requested: int) -> tuple[str, ...] | None:
    """The exercise ids on THIS build's drawn sheet, or `None` if no sheet is on disk.

    `None` and `()` are different answers and the difference is the point: no sheet means
    the intersection below cannot be computed at all, while an empty sheet means it was
    computed and is empty. Both refuse the gate; only one of them is a missing file.
    """
    path = sample_path(lang, requested)
    if not path.exists():
        return None
    ids: list[str] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        ids.append(str(json.loads(line)["exercise_id"]))
    return tuple(ids)


def sheet_audio_ids(lang: str, requested: int) -> tuple[str, ...] | None:
    """The ids on this build's sheet that a reviewer could LISTEN to, or `None`.

    Read back off the written sheet rather than recomputed, for the same reason
    `sheet_exercise_ids` is: the sheet is the artefact the reviewer was handed, and a
    recomputation six weeks later would answer for a bank that may since have been
    re-baked. `None` (no sheet) and `()` (a sheet, no audio on it) are different
    answers and `accent_summary` reports them as different reasons.
    """
    path = sample_path(lang, requested)
    if not path.exists():
        return None
    ids: list[str] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        row = json.loads(line)
        # `clip_path` is the field, not `clip_id`: a clip id with no bytes behind it is
        # a promise G7 made, and the sheet's whole job is to keep those two apart.
        if row.get("clip_path"):
            ids.append(str(row["exercise_id"]))
    return tuple(ids)


def accent_scoring_violations(
    *,
    scores: Sequence[Mapping[str, Any]],
    sheet_item_ids: Iterable[str] | None,
    sheet_audio_ids: Iterable[str] | None,
) -> tuple[str, ...]:
    """Rows that scored the accent dimension on a clip nobody could have played.

    The one lie the sheet exists to prevent, checked rather than asked for politely.
    `RUBRIC.md` says it in words — *"`pass` on a clip nobody played would be the one lie
    this sheet exists to prevent"* — and a rule that lives only in prose is a rule that
    holds until somebody is in a hurry. A sheet of 300 rows where the accent column is
    filled in with `pass` all the way down is indistinguishable, in every number this
    module publishes, from a bank a native speaker checked.

    Returns the offending exercise ids. Empty when nothing is wrong, and empty when the
    question cannot be asked: with no sheet on disk (`sheet_audio_ids is None`) there is
    nothing to check a row against, and `accent_summary` reports THAT as the reason it
    has no rate rather than inventing a violation.
    """
    if sheet_audio_ids is None:
        return ()
    audio = set(sheet_audio_ids)
    on_sheet = set(sheet_item_ids) if sheet_item_ids is not None else None
    offenders: list[str] = []
    for row in scores:
        identifier = str(row["exercise_id"])
        if on_sheet is not None and identifier not in on_sheet:
            # Not on this build's sheet at all: it is already out of the denominator
            # (`review_summary`), and judging a row that belongs to another build's
            # population is a different finding with its own count, `unjoined`.
            continue
        value = (row.get("dimensions") or {}).get(ACCENT_DIMENSION)
        if value is not None and identifier not in audio:
            offenders.append(identifier)
    return tuple(offenders)


def accent_summary(
    *,
    scores: Sequence[Mapping[str, Any]],
    sheet_item_ids: Iterable[str] | None = None,
    sheet_audio_ids: Iterable[str] | None = None,
    engines: Sequence[str] = (),
) -> dict[str, Any]:
    """What the accent question was answered with, beside the wrong-item rate.

    Beside, never inside. `RUBRIC.md` is explicit that an accent finding is not a wrong
    item — a learner meeting a clip in the wrong accent is not taught something false —
    so it takes the `awkward` verdict and `MAX_DEFECT_RATE` never sees it. This block is
    the other half of that decision: the dimension founder ruling B6 made the project's
    ONLY accent check has to be reported somewhere, or the ruling bought a column nobody
    reads.

    Three states, three different sentences, and the whole design is that they cannot be
    confused with each other:

    * no sheet on disk — the question cannot be put, `rows_with_audio` is `None`;
    * a sheet with no clips (no bake, or a bake whose bytes are gone) — the question was
      put to zero rows, `audio_engine` is `none`, and `pass_rate` is `None`;
    * a sheet with clips — `pass_rate` over the rows that HAVE audio and were scored.

    `pass_rate` is never 1.0 by default and never 0.0 by default. An unscored accent
    column reads `None` with a reason attached, because "consistent" and "nobody
    listened" are the two answers a pack card must not merge — the same failure
    INV-PACK-14 names when a validator reports zero findings from an engine that never
    ran.

    Raises `ScoreError` when a row scored the dimension without a clip; the caller turns
    that into exit 4.
    """
    offenders = accent_scoring_violations(
        scores=scores,
        sheet_item_ids=sheet_item_ids,
        sheet_audio_ids=sheet_audio_ids,
    )
    if offenders:
        shown = ", ".join(offenders[:5]) + (" ..." if len(offenders) > 5 else "")
        raise ScoreError(
            f"{len(offenders)} row(s) scored {ACCENT_DIMENSION} on a sheet row with no "
            f"clip: {shown}. The sheet's `clip_path` is null for those rows, so there "
            f"were no bytes to listen to — score them null, which is what null is for."
        )

    audio = None if sheet_audio_ids is None else set(sheet_audio_ids)
    on_sheet = set(sheet_item_ids) if sheet_item_ids is not None else None
    judged = [
        row
        for row in scores
        if (on_sheet is None or str(row["exercise_id"]) in on_sheet)
        and audio is not None
        and str(row["exercise_id"]) in audio
        and (row.get("dimensions") or {}).get(ACCENT_DIMENSION) is not None
    ]
    passed = sum(
        1 for row in judged if (row.get("dimensions") or {})[ACCENT_DIMENSION] == "pass"
    )
    rows_with_audio = None if audio is None else len(audio)

    if audio is None:
        reason: str | None = ACCENT_UNSCOREABLE_NO_SHEET
    elif not audio:
        reason = ACCENT_UNSCOREABLE_NO_BAKE
    elif not judged:
        reason = ACCENT_UNSCOREABLE_UNSCORED
    else:
        reason = None

    return {
        # Which voice engine actually spoke to the reviewer. `none` is a recorded state,
        # not an absent key (INV-PACK-14); two names here is EC-PACK-52 on the sheet.
        "audio_engine": "+".join(sorted(set(engines))) if engines else AUDIO_ENGINE_NONE,
        "rows_with_audio": rows_with_audio,
        "scored": len(judged),
        "passed": passed,
        "failed": len(judged) - passed,
        "pass_rate": (passed / len(judged)) if judged else None,
        "unscoreable_reason": reason,
    }


def review_summary(
    *,
    scores: Sequence[Mapping[str, Any]],
    sample_size: int,
    reviewer_kind: str = REVIEWER_KIND_AGENT,
    sheet_item_ids: Iterable[str] | None = None,
) -> dict[str, Any]:
    """The `review` block of `validator-report.json` and of the pack manifest.

    The note is not decoration. §2.6 makes trust marking a rendered surface, and the plan
    puts the measured rate on the S001 card and in S137. A rate whose provenance is not
    attached to it makes the same claim as a rate a paid native speaker produced.

    **The rate is computed over the JOIN, not over the scores file.** `content/<lang>/
    review/scores.jsonl` is committed and a sheet is not: the draw is reproducible under
    `SAMPLE_SEED` only for a fixed population, and G0 reads a **live Tatoeba export that
    rebuilds every Saturday 06:30 UTC** (`docs/ci.md`, why `pack-ci` never digests the gap
    brief). So a scores file written against last week's sheet names exercise ids this
    build does not have, and a rate over `len(scores)` is then a rate over rows belonging
    to no population this pack can show anybody — a number that looks like a measurement
    and is an average of two different builds.

    Hence three published counts instead of one: `sample_size` (what was drawn),
    `scored` (what a reviewer scored), and `joined` (how many scored rows are actually on
    this build's sheet). The rate's denominator is `joined`. With no sheet on disk there
    is no intersection to take, so `joined` is `None` and the rate is `None` — which the
    gate refuses, the same way it refuses an unscored sample.
    """
    scored = len(scores)
    note = "" if reviewer_kind == REVIEWER_KIND_PAID_NATIVE else PROVISIONAL_DEFECT_RATE_NOTE

    if sheet_item_ids is None:
        joined_rows: list[Mapping[str, Any]] = []
        joined: int | None = None
        unjoined: int | None = None
    else:
        sheet = set(sheet_item_ids)
        joined_rows = [row for row in scores if row["exercise_id"] in sheet]
        joined = len(joined_rows)
        unjoined = scored - joined

    wrong = sum(1 for row in joined_rows if row["verdict"] in DEFECT_VERDICTS)
    awkward = sum(1 for row in joined_rows if row["verdict"] == "awkward")
    denominator = joined or 0
    return {
        "reviewer_kind": reviewer_kind,
        "sample_size": sample_size,
        "scored": scored,
        "joined": joined,
        "unjoined": unjoined,
        "wrong_item_rate": (wrong / denominator) if denominator else None,
        "awkward_rate": (awkward / denominator) if denominator else None,
        "note": note,
    }


def gate_passed(summary: Mapping[str, Any]) -> bool:
    """Is the measured rate at or below `MAX_DEFECT_RATE`?

    **Founder ruling B3, 2026-09-12**: P3 proceeds on an agent-scored sample, so an
    `REVIEWER_KIND_AGENT` rate at or under the gate is a pass — the paid native review
    moves to `docs/RELEASE.md` as a release prerequisite. Three things the ruling does
    NOT do, each of which was one line away from being lost:

    * **`None` is still never a pass.** An unscored sample has no rate, and the plan's
      non-negotiable 5 gates on a measurement rather than on the absence of one.
    * **The reviewer kind must be recorded.** A block whose kind is `""` or some string
      nobody defined has no measurer, and B3 is a ruling about who measured.
    * **The rate must rest on a real join.** `joined` is the denominator (see
      `review_summary`); `None` or `0` means the scored rows are not on this build's
      sheet, so there is nothing this pack can show that the rate describes.
    """
    if summary.get("reviewer_kind") not in RECORDED_REVIEWER_KINDS:
        return False
    joined = summary.get("joined")
    if not isinstance(joined, int) or isinstance(joined, bool) or joined <= 0:
        return False
    rate = summary["wrong_item_rate"]
    return rate is not None and rate <= MAX_DEFECT_RATE


def unscored_items(sheet: SampleSheet, scores: Iterable[Mapping[str, Any]]) -> tuple[str, ...]:
    """Sheet rows nobody scored. The denominator's other half."""
    seen = {row["exercise_id"] for row in scores}
    return tuple(item.exercise_id for item in sheet.items if item.exercise_id not in seen)


def derive_review(lang: str, repo_root: Path | None = None) -> dict[str, Any] | None:
    """The `review` block for `validator-report.json`, from what is on disk.

    `None` when no sample has been drawn *and* nothing has been scored — there is then
    nothing to say, and the report's `summarise()` falls back to a null rate with the
    provisional note attached. As soon as either exists the block appears, because a
    drawn-but-unscored sample is a fact a reader needs: it is the difference between "we
    have not measured this" and "we measured it and it was fine".

    Raises `ScoreError` on a malformed scores file; the caller turns that into exit 4.
    A verdict the tool cannot read would otherwise vanish from the denominator.
    """
    scores = read_scores(lang, repo_root)
    summary_file = run_dir(lang) / SAMPLE_SUMMARY_FILENAME
    sample_size = 0
    requested = REVIEWER_SAMPLE_ITEMS
    engines: list[str] = []
    if summary_file.exists():
        drawn = json.loads(summary_file.read_text(encoding="utf-8"))
        sample_size = int(drawn["drawn"])
        # The sheet is named by what was REQUESTED, not by what was drawn: a short draw
        # still writes `sample-300.jsonl`. Reading `drawn` here would look for a file
        # that does not exist and report every scored row as unjoined.
        requested = int(drawn["requested"])
        engines = [str(name) for name in drawn.get("audio_engines", [])]
    if not scores and not sample_size:
        return None
    on_sheet = sheet_exercise_ids(lang, requested)
    # Raises `ScoreError` on an accent verdict against a row with no clip, which
    # `commands/_run.py` turns into exit 4. It runs HERE, on the path `coursekit
    # validate` takes, because the report is where such a verdict would otherwise be
    # published — the check belongs where the number leaves the tool, not where it is
    # written down.
    accent_summary(
        scores=scores,
        sheet_item_ids=on_sheet,
        sheet_audio_ids=sheet_audio_ids(lang, requested),
        engines=engines,
    )
    return review_summary(scores=scores, sample_size=sample_size, sheet_item_ids=on_sheet)


def derive_accent(lang: str) -> dict[str, Any]:
    """The accent block for one language, from what is on disk.

    Separate from `derive_review` and not folded into its return value, for a reason
    that is a cross-lane fact rather than a preference: `validators/report.py` declares
    the `review` block with `additionalProperties: false`, so an extra key there makes
    `write_report` refuse the whole report — and that file belongs to the validator
    lane, not this one. Filed as contract **C1** in
    `docs/owned/p2r4-sample-accent-rate.json`: the report schema needs an optional
    `review.accent` object before this block can be published beside the rate on S023
    and S024. Until then it is computed, checked, and available to a caller.
    """
    summary_file = run_dir(lang) / SAMPLE_SUMMARY_FILENAME
    requested = REVIEWER_SAMPLE_ITEMS
    engines: list[str] = []
    if summary_file.exists():
        drawn = json.loads(summary_file.read_text(encoding="utf-8"))
        requested = int(drawn["requested"])
        engines = [str(name) for name in drawn.get("audio_engines", [])]
    return accent_summary(
        scores=read_scores(lang),
        sheet_item_ids=sheet_exercise_ids(lang, requested),
        sheet_audio_ids=sheet_audio_ids(lang, requested),
        engines=engines,
    )
