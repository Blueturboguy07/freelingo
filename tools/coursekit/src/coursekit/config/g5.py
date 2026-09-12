"""Constants owned by G5, gap-fill — the only authoring stage.

`config/gapfill.py` was created empty by `p2-deps-scaffold` for a lane called
`p2-g5-gapfill`. The lane that landed is `p2-g5-g6-gapfill-language` and its file
ownership names `config/g5.py` and `config/g6.py`, so these are the two files G5/G6
constants live in. `config/gapfill.py` and `config/validate.py` are left as the scaffold
wrote them — empty — and should be deleted by whoever integrates the phase; nothing
imports them.

## Why there is no model id in here

`deep/10` §S5 prices gap-fill on `claude-opus-5` / `claude-sonnet-5` over the Batch API
and notes (R10) that the request shape is per model. **None of that is reachable: this
environment has no API key for any provider.** The plan's ruling stands — the Opus
agent building the lane is the author, and it writes its candidates into
`content/<lang>/candidates.jsonl`, which this stage reads the way the hosted path would
have read a batch result. `author` on every row is that agent, not a model id, and the
manifest's machine-authored percentage is therefore real rather than aspirational.

## Why over-generation is a constant and not a flag

§S5's recommended shape is **G5-A: over-generate ~20 per slot, then generate-and-reject
against the lemma ledger** — because closed-vocabulary constrained decoding does not
exist against a hosted API (Outlines' OpenAI backend is JSON-schema only; its Anthropic
page documents no structured-output types, which R18 softens to "documents nothing"
rather than "documented absence"). The constraint is enforced AFTER generation. That
only works if the over-generation is real: a slot with three candidates cannot survive
five filter axes, and the stage would then be choosing between "ship the least bad one"
and "fail". `MIN_CANDIDATES_PER_SLOT` removes that choice at the authoring boundary.

Owner: p2-g5-g6-gapfill-language
"""

from __future__ import annotations

from typing import Final

# ---------------------------------------------------------------------------
# Where the authored candidates live
# ---------------------------------------------------------------------------

#: `content/<lang>/` in the repository. Authored by a human or, here, by the agent —
#: never generated into `build/`, which is reproducible output and is gitignored.
CONTENT_ROOT_DIRNAME: Final[str] = "content"

#: Points `content/` somewhere else. Tests use it; nothing in a build does.
CONTENT_ROOT_ENV_VAR: Final[str] = "COURSEKIT_CONTENT_ROOT"

AUTHORED_CANDIDATES_FILENAME: Final[str] = "candidates.jsonl"

#: The SHARD directory beside it: `content/<lang>/candidates/*.jsonl`, read in sorted
#: filename order after the legacy single file.
#:
#: Four authoring lanes run in parallel over one course. One file means four lanes
#: appending to one 18,000-line JSONL and four rebases over it, which is a merge
#: conflict per lane per push and, worse, a conflict resolution nobody can review: two
#: identical-looking 20-row blocks whose only difference is the slot they name.
#: One file per lane is a diff that reads.
#:
#: The legacy path is still read, and not only for compatibility: a one-language course
#: written by one person has no reason to shard, and a rule that FORBADE the single file
#: would make the smallest case the special case.
AUTHORED_CANDIDATES_DIRNAME: Final[str] = "candidates"

#: Shards are `.jsonl`, so a README, a `.gitkeep` or an editor backup in the shard
#: directory is not read as content. The suffix is matched, never the whole name: a lane
#: names its own shard and nothing here has to know the names in advance.
AUTHORED_SHARD_SUFFIX: Final[str] = ".jsonl"

#: Where `coursekit gaps <lang>` writes the authoring brief, and the one thing that file
#: must say about itself. It is a DERIVED SNAPSHOT of one build: G5 never reads it, and
#: `tests/test_gaps_command.py` asserts that no stage imports it. The enforcer is the
#: `stale_ledger` axis against the ledger G4 actually emitted; a brief that could also
#: enforce would be the second source of truth INV-PACK-40 exists about.
GAP_BRIEF_DIRNAME: Final[str] = "authoring"
GAP_BRIEF_FILENAME: Final[str] = "gap-brief.jsonl"
GAP_BRIEF_KIND: Final[str] = "derived-snapshot"

#: The brief's own schema number, on its header line. A brief written by an older
#: coursekit is still readable and is not the same document, and an author should be told
#: which one they are holding rather than discovering it from a missing field.
GAP_BRIEF_SCHEMA: Final[int] = 1

#: The back-translation rubric G6 scores against, and the file that has to say in
#: writing that the score is agent-authored rather than a model round-trip.
GAPFILL_RUBRIC_FILENAME: Final[str] = "gapfill-rubric.md"

# ---------------------------------------------------------------------------
# Over-generation
# ---------------------------------------------------------------------------

#: What §S5 calls "over-generate ~20 per slot".
OVERGENERATION_TARGET: Final[int] = 20

#: The hard floor. A slot authored with fewer candidates fails the stage by name
#: rather than quietly giving the reject loop nothing to resample from.
MIN_CANDIDATES_PER_SLOT: Final[int] = 20

# ---------------------------------------------------------------------------
# The filter axes
# ---------------------------------------------------------------------------

#: The closed set of reasons a candidate can be discarded, in evaluation order. A
#: reject reason outside this tuple is a bug, not a new policy — `reject_reason` is
#: read by the manifest and by whoever is deciding whether the ledger window is too
#: tight, and a free-text reason makes that number uncountable.
#:
#: There is deliberately no axis whose remedy is an edit. INV-PACK-10: content that
#: fails an axis is discarded and resampled, never patched.
REJECT_AXES: Final[tuple[str, ...]] = (
    # The ledger the candidate was authored against is not the ledger G4 emitted.
    # Authoring is offline, so this is the one that catches a stale file, and it has
    # to run FIRST: every axis below it would otherwise be measured against the
    # wrong vocabulary and pass for the wrong reason.
    "stale_ledger",
    # V1: a lemma the learner has not met. The ledger is lemma-level, never surface.
    "out_of_vocabulary",
    # V2: more than one new lemma-or-inflection in one item.
    #
    # HONEST NOTE, 2026-09-12: while G4 reserves AT MOST ONE new lemma per gap — which
    # it does, because one new item per exercise is V2's own rule — this axis cannot
    # fire. `introduced` is the candidate's lemmas intersected with the gap's
    # `new_lemmas`, so its size is bounded by that set's. The axis is kept rather than
    # deleted because it is V2's enforcement point and the bound it depends on lives in
    # another stage's config (`config/g4.py MAX_NEW_LEMMAS_PER_EXERCISE`); removing it
    # would mean the day that number changes, nothing here notices. It is recorded as
    # currently-unreachable rather than quietly counted as coverage.
    "new_lemma_budget",
    # G0's length filter, applied to an authored sentence exactly as to a corpus one.
    "length",
    # V9: the same sentence twice inside a unit.
    "duplicate",
)

#: G0 filters corpus sentences to 3-12 tokens for A1 (`scope2/00` §2.3). An authored
#: sentence goes through the same window: "the same path as a corpus sentence" is not
#: a slogan if the authoring path gets its own, looser numbers.
#:
#: This is G5's own copy and it should not stay that way. `config/ingest.py` (G0's) is an
#: empty scaffold today and `config/base.py` — where the repo's own rule puts a constant
#: two stages share — declares no length window, and neither file is in this lane's
#: ownership, so there is nothing to import yet. What holds the claim in the meantime is
#: `tests/test_g5_gapfill.py::test_the_length_window_cannot_drift_from_g0s`: it scans
#: every other config module for a window under any of the plausible names and fails the
#: build on a disagreement with these two numbers. When G0 lands its window, delete these
#: two lines and import it — the test is the thing that makes that a one-line change
#: instead of a silent divergence.
MIN_TOKENS: Final[int] = 3
MAX_TOKENS: Final[int] = 12

#: V2. One new lemma-or-inflection per exercise, which is Duolingo's own rule.
MAX_NEW_LEMMAS_PER_ITEM: Final[int] = 1

#: What `provenance` every authored row carries, and the only value G5 emits.
AUTHORED_PROVENANCE: Final[str] = "llm"

# ---------------------------------------------------------------------------
# The ledger digest
# ---------------------------------------------------------------------------

#: How many hex characters of the ledger digest an authored row carries.
#:
#: `stale_ledger` used to be "the authored row's `allowed_lemmas` list, as a set, equals
#: the gap's `known | new`". That is the right CHECK and the wrong CARRIER. The allowed
#: set at a late unit is the whole course-so-far vocabulary — hundreds of lemmas — and
#: the check demanded that all 20 candidates for all 490 slots each spell it out, which
#: is the same list written 9,800 times and a candidates file measured in tens of MB.
#: Worse, it is a list a hurried author edits to make a row pass.
#:
#: A digest of the sorted set carries the same claim in 16 characters and cannot be
#: edited into agreement. 16 hex characters is 64 bits over a per-slot namespace of one:
#: there is exactly one right answer per slot, so this is an equality check with a short
#: witness, not a collision-resistance argument about an adversary.
LEDGER_DIGEST_CHARS: Final[int] = 16
