# P2 blockers

What is stopping the Spanish pack, in one place, with the evidence each claim rests on.
`docs/P2-REPORT.md` is the phase report at sha 78cfae3 and stays as written; this file is
the live list. Last rewritten **2026-09-12, P2 round 3**, against the founder rulings of
the same date.

**The nine founder decisions were answered on 2026-09-12** — B3, B5, B6, B9, B1b, B16,
B14, B17 and B7, plus a scheduling note about `pnpm format`. They are recorded verbatim
at the foot of this file (§Founder rulings) and quoted in each body below. That changes
what this file is for: no row now waits on a question, and the rows that used to be
questions are rows that wait on **work**, which is a different kind of blocker and has an
owner.

So the status column distinguishes three things, and the distinction is the point:

- **RESOLVED** — this round measured it fixed. Nothing is marked RESOLVED on the strength
  of a ruling; a decision is not a measurement.
- **DECIDED** — the founder answered it. Followed by whether the answer has been **built**,
  because a ruling with no code behind it blocks exactly as much as the open question did.
- **AUTHORED** — used once, for B1: the work the row asked for was done and measured, and
  the row is still not RESOLVED because the stage it exists to unblock still fails. A row
  whose own deliverable landed but whose blocker moved to another row says so, rather than
  going green and leaving the block invisible.
- **OPEN / NON-GATING** — neither.

| Id      | What                                                                                       | Kind                 | Status                                                                                                                                                        |
| ------- | ------------------------------------------------------------------------------------------ | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **B1**  | the candidate sentences do not exist                                                       | authoring            | **AUTHORED 2026-09-12** — 9,687 rows, 481/490 slots; 9 short = B9                                                                                             |
| **B1a** | every G4 gap slot carries empty `known_lemmas`/`new_lemmas`, so no candidate can pass G5   | code                 | **RESOLVED** — p2fix/ledger-freeze                                                                                                                            |
| **B1b** | the committed candidates are keyed in a lesson numbering G4 does not use                   | code + decision      | **DECIDED + BUILT** — course-global is canonical; fixture verified                                                                                            |
| **B2**  | `pack-bake.yml` could not succeed on any dispatch                                          | code                 | **RESOLVED 2026-09-12** — deleted                                                                                                                             |
| **B3**  | the wrong-item rate is `None`, not 2%                                                      | **founder decision** | **DECIDED, MEASURED at 4.00%** (12/300, agent-scored, over the populations G7 would expand); the published rate is still `None` because no sheet exists — B19 |
| **B4**  | `coursekit sample es --n 300` is not a spelling the CLI has                                | docs                 | **RESOLVED 2026-09-12**                                                                                                                                       |
| **B5**  | S152 has a validator, F3, and no row in the product map                                    | **founder decision** | **DECIDED** — Surface 16 written; P4 builds the screen                                                                                                        |
| **B6**  | Azure is dead; Spanish bakes on Kokoro                                                     | **founder decision** | **DECIDED, BUILT** — 5/5 at the round-3 integration                                                                                                           |
| **B7**  | `mutation.yml` has never produced a score                                                  | pre-existing         | **NON-GATING by ruling** — still no score, measured                                                                                                           |
| **B8**  | `build-es` names no language engine, so V8 will block even once B1 is fixed                | code (CI)            | **RESOLVED 2026-09-12** — sidecar                                                                                                                             |
| **B9**  | unit 1 lesson 1 cannot hold a sentence: 5 lemmas, no verb, and `bueno` is unreachable      | **founder decision** | **DECIDED, BUILT** — all three parts landed at the r3 integration                                                                                             |
| **B10** | 218 candidate texts were `usted` in a course that declares `tu` (blocking V6)              | content              | **RESOLVED 2026-09-12** — rewritten                                                                                                                           |
| **B11** | G6 read one candidates file and there are nine, so the rubric engine probed nothing        | code                 | **RESOLVED 2026-09-12**                                                                                                                                       |
| **B12** | the gate's `coursekit validate es --pack … --report …` spelling does not exist             | docs                 | **RESOLVED 2026-09-12** — docs only                                                                                                                           |
| **B13** | `build-es` synced no `align` group                                                         | code (CI)            | **RESOLVED 2026-09-12** — pack-ci.yml                                                                                                                         |
| **B14** | a starved slot crashes G7 instead of failing by name                                       | code                 | **DECIDED, BUILT** — `StarvedSlot(LookupError)`, message verbatim                                                                                             |
| **B15** | G7 made word-bank tiles out of punctuation                                                 | code                 | **RESOLVED 2026-09-12**                                                                                                                                       |
| **B16** | G7 looks a distractor up by SURFACE, and an authored candidate has no analysis             | code                 | **DECIDED, BUILT** — writer (deps) + reader (`_anchor_lemma`)                                                                                                 |
| **B17** | V11 sees mean difficulty fall across 13 unit boundaries                                    | content + code       | **DECIDED, BUILT, MEASURED** — 1 blocking (u10→u11, −1.039, across s1→s2) and 12 within-section warnings, not 13 blocking                                     |
| **B18** | the accent dimension B6 made load-bearing has nothing to listen to                         | code                 | **OPEN, measured** — found 2026-09-12 by this round                                                                                                           |
| **B19** | B9(a)+(c) moved the ledger, so 18 authored slots died and 22 new gap slots appeared        | content              | **OPEN — the phase blocker**; re-key done, 29 slots to author                                                                                                 |
| **B20** | `ci.yml` fails with every test passing: `Timeout calling "onTaskUpdate"`, twice on one sha | infrastructure       | **OPEN, measured** — not a flake any more                                                                                                                     |

**The four rows above were re-measured on `main` at the P2 round-3 integration**, because
each was written on a lane that could not see its sibling's files and each had gone stale
in the same direction — done, and reported undone. `git grep` on `main`, 2026-09-12:
B9(a) `config/g1.py::LEMMA_NORMALISATION_ES` + `adapters/spacy_es.py` (3 references
each); B9(b) `config/g5.py:195 MIN_TOKENS_VERBLESS_LESSON = 1` with
`min_tokens_for_slot`; B9(c) `stages/g3_solve.py:503 unreachable_lexemes` reported in the
stage's own note; B14 `stages/g7_expand.py:130 class StarvedSlot(LookupError)` raised at
`:295`, with the expand lane's test asserting the message verbatim and that no traceback
is printed; B16's reader `stages/g7_expand.py:712 _anchor_lemma`; B17
`validators/pack.py:516 severity=CROSS_SECTION_DIFFICULTY_FALL_SEVERITY` against
`unit_assignment.section_cefr`. **B18 is the only row of this table still open on code.**

---

## B1 — the candidates — AUTHORED 2026-09-12, and the phase is still blocked by B9

Not this task's lane; recorded here because everything below waits on it.

**Where it stands now, measured on this tree 2026-09-12.** The five shards under
`content/es/candidates/` hold **9,687 rows** over **490 distinct slots**, of which **481
carry 20 or more candidates** — the over-generation floor `MIN_CANDIDATES_PER_SLOT`
requires:

```
$ python3 -c "...count content/es/candidates/*.jsonl by slot..."
rows 9687
distinct slots 490
slots with >=20 candidates 481
slots under 20 9
```

The nine short slots are `u1/l1/s0 … s8` and they are **B9**, not an authoring shortfall:
no sentence can fill them until the G1 lemma table and the per-lesson `MIN_TOKENS` land,
which is why B1 is marked as authored rather than as resolved. **`coursekit build es`
still cannot pass G5**, so everything in the paragraph below that says "has never run"
is still true of `coursekit validate es`, `sample es` and `sign es`.

### The original finding, as filed — superseded by the measurement above

Kept because the size of the gap is the reason four authoring shards were commissioned,
and because one number in it turned out to be a join artefact rather than a count.

> G4 emits **918 gap slots**; `content/es/candidates.jsonl` is **160 rows** covering
> **8** of them (8 × exactly 20), which is **0.9%**. The course needs 918 × 20 =
> **18,360**.

Two things in that quotation have since changed and neither is a correction to the
authoring work. `content/es/candidates.jsonl` **no longer exists** — candidates are a
directory of five shards (see B1b, and B11 on the reading side) — and the slot arithmetic
moved with the ledger: the build reproduced below emitted 920 gaps against a ledger that
now yields **490** authorable slots. The "8 slots" figure was also the wrong kind of
number: a lesson-numbering mismatch made the join report 8 where the real join said two,
which is the hazard B1b's last paragraph says is still unguarded.

`coursekit build es` exits 4 at G5, `validate-es` skips on `needs:`, and the whole
downstream half of P2 — `coursekit validate es`, V1–V4 at 100%, V5–V12, the V8 engine
record, the licence sweep, the 120 MB bank on real bytes, `coursekit sample es`,
`coursekit sign es` — has **never run**.

**Reproduced locally on this Mac, 2026-09-12**, so the numbers below are first-hand and
not read off a CI summary. `coursekit build es --set max_pairs=200000` in this worktree,
13 minutes, with the `nlp`, `lm` and `tts` groups and the hermitdave list fetched the way
`build-es` fetches it:

| Stage | What it reported                                                                    |
| ----- | ----------------------------------------------------------------------------------- |
| G0    | 276,203 ingested (tatoeba 180,862 + nllb 95,341), NFC, length window [3, 12]        |
| G1    | `es_core_news_md-3.8.0`, adapter self-test ok, 3.93 mean content words per sentence |
| G2    | ok                                                                                  |
| G3    | ok, `cefr_checked: false`                                                           |
| G4    | **1,584 slots, 664 filled, 920 gaps** (`gap_fraction` 0.5808), ledger yield 0.1452  |
| G5    | **failed, exit 4** — "918 slot(s) authored below the over-generation floor of 20"   |

Every slot G5 names carries `(0)`. The CI run at `281b623` reported 918 gaps and this one
920, on an independently streamed corpus: the figure is curriculum-driven, not a fluke of
one download.

G5 is the only authoring stage and there is no hosted model in this environment, so the
remaining ~18,200 sentences are agent-authoring work, not an integration fix. Four
authoring shards (`p2fix/author-u01-u06`, `-u07-u14`, `-u15-u23`, `-u24-u30`) are the
remedy.

**`MIN_CANDIDATES_PER_SLOT` was not lowered and must not be.** `config/g5.py` argues the
constant and the argument holds: the reject loop has five filter axes, and a slot with
three candidates makes the stage choose between shipping the least bad sentence and
failing.

### B1a — and the slots cannot be filled by authoring either (2026-09-12)

Raised by the `p2fix/author-u07-u14` shard at `8fe05ae`, which committed **empty** rather
than committing rows it had measured to be unfillable. Confirmed here by reading the
stage, independently of that lane:

`stages/g4_select.py`, the `if choice is None` branch that reserves a gap slot, appends
`_item(..., new_lemmas=[], known_lemmas=[])` — **unconditionally**, for every gap it
emits. G5 then computes a slot's permitted vocabulary as `known | new`, which is the
**empty set**. So the only candidate that can survive the `stale_ledger` axis is one
declaring `allowed_lemmas: []`, and every such candidate fails `out_of_vocabulary`
because every lexical lemma it contains is outside an empty set. A text with no lexical
lemma is not a way out: the adapter raises on it.

The shard measured **1,456 of 1,456** gap rows in a local build. **Measured again here,
on this lane's own build tree: 920 of 920.** Two independent builds, two corpora, the
same 100%, which is what a corpus-independent branch looks like:

```python
>>> sum(1 for r in gap_rows if not r["known_lemmas"] and not r["new_lemmas"])
920
>>> len(gap_rows)
920
```

**This changes what B1 is.** It is not "18,200 sentences nobody has written yet"; it is a
G4 defect that makes the authoring work impossible to accept no matter how good the
sentences are. Authoring more shards against the current G4 would produce tens of
thousands of rows that G5 must reject. `stages/g4_select.py` is not in the
`p2fix-downstream` lane; it is the thing to fix before another authoring round is
commissioned.

### B1b — the committed candidates are keyed in a lesson numbering G4 does not use

Found here, 2026-09-12, by joining `content/es/candidates.jsonl` against this build's
`build/es/g4/selected.jsonl` rather than trusting either file's own description.

The eight slots the 160 committed rows name are

```
(1,1,0) (1,2,2) (2,1,1) (2,3,0) (3,1,4) (3,2,1) (4,1,0) (4,2,3)
```

— `(unit_index, lesson_index, slot_index)` with **lesson numbered within its unit**. G4
numbers lessons **across the course**: unit 1 owns lessons 1–6, unit 2 owns **7–12**,
unit 3 owns 13–18, and so on (`selected.jsonl`, and G5's own error prints `u2/l7/s0`).

So of the eight authored slots, **two are gaps in this build** — `(1,1,0)` and `(1,2,2)`,
and only because unit 1's local and global numbering coincide. The other **six name
(unit, lesson) pairs G4 never emits at all**: there is no lesson 1 in unit 2.

That makes "160 rows covering 8 of 918 slots" optimistic, and it is worth saying where
that 8 came from: it is 160 ÷ 20, read off the candidates file, not a join against G4's
gap list. Joined, it is 40 rows against 2 real slots and 120 rows pointing at nothing — and it means the pilot bank the four authoring
shards were told to imitate demonstrates a slot key that does not join. Fixing B1a without
fixing this would produce a second round of rows that G5 silently has no slot for.

**Which numbering is correct is a decision, not a bug report.** Per-unit lesson numbers
are what a human author can hold in their head; course-global ones are what G4 emits. One
of the two has to move, and whichever moves, `content/es/candidates.jsonl` and the gap
brief have to move with it. Neither file was in that lane.

#### The ruling, and it matches what was shipped — DECIDED 2026-09-12

> **B1b** → course-global lesson numbers are canonical.

So G4 does not move and the authored rows do, which is what the round-2 re-filing had
already done. **Verified on this tree rather than read off the report**: the five files
under `content/es/candidates/` hold **9,687 rows**, and their `slot` keys number lessons
across the course exactly as G4 emits them —

```
unit 1 lessons [1, 2, 3, 4, 5, 6]
unit 2 lessons [7, 8, 9, 10, 11, 12]
unit 3 lessons [13, 14, 15, 16, 17, 18]
unit 4 lessons [19, 20, 21, 22, 23, 24]
```

— so the ruling canonises the numbering the committed fixture already uses, and there is
no re-key owed for B1b. Note also that the single file this section was written against,
`content/es/candidates.jsonl`, no longer exists: candidates are a **directory** of five
shards, which is the same change B11 was about on the reading side.

Two things the ruling does **not** do, and they should not be read into it. It does not
make per-unit numbering wrong for a human — a gap brief may still present
`u2/l1`, as long as it converts — and it does not retire the hazard: a key that does not
join produced "160 rows covering 8 slots" where the join said two, and nothing in the
pipeline flagged it. A `selected.jsonl`-vs-candidates join check would have, and there
still isn't one.

---

## B2 — `pack-bake.yml` could not succeed on any dispatch — RESOLVED, deleted

**What was wrong.** `pack-bake.yml` was `workflow_dispatch` on a fresh checkout running
`coursekit bake es`. G8 reads **G7's exercises**; a fresh checkout has no `build/` tree;
so every possible dispatch exited 3/4 naming the missing upstream stage. It was never
dispatched and **no `es-audio-<sha>` artefact has ever existed**. The `docs/ci.md`
workflow table nonetheless advertised it as "rebuilds one language's audio bank and hands
back the artefact" — bake coverage nobody had.

**Decision, 2026-09-12: deleted.** The reasoning is in `docs/ci.md` §"`pack-bake.yml` was
deleted, and why that is the honest option"; in short, the alternative (download
`build-es`'s `es-build-<sha>`) depends on an artefact with `retention-days: 1` and a
cross-workflow `run-id` the operator would have to look up by hand, and the bake already
happens inside `build-es`, which has G7's output, the `tts` group and the same pinned
Kokoro weights. `es-build-<sha>` (`path: build/es`) already carries `g8/bank/`,
`g8/clips.jsonl` and `runlog.jsonl`.

**Loose ends for the integrator** (files outside this lane, comments only, no behaviour):

- `.github/workflows/pack-ci.yml` lines ~50 and ~179 still name `pack-bake.yml` in
  comments.
- `tools/coursekit/docs/pipeline.md` lines ~22 and ~33 still name it in the dependency
  group table.

---

## B3 — the wrong-item rate is `None`, not 2% — DECIDED 2026-09-12

**The fact.** `content/es/review/scores.jsonl` is **0 bytes**, committed empty on
purpose. `coursekit` treats absent and empty the same way: `wrong_item_rate` is `None`
and `gate_passed()` is `false`. An unscored sample does not pass the ≤ 2% gate by having
no numerator. The plan's P2 row — "≤2% gate before P3 builds on the pack" — is therefore
**not met and not failed**; it is unmeasured.

**What is already correct and must not drift.** The honesty string is a constant,
`config/sample.py::PROVISIONAL_DEFECT_RATE_NOTE`:

> PROVISIONAL (unreviewed by a paid native speaker)

It is carried verbatim by `docs/pack-provenance.md` and `tools/coursekit/README.md` and
asserted verbatim in both by `tests/test_sample.py`. **The string stays exactly as
tested.** It is a constant precisely because it will end up in four carriers (those two,
plus the S001 pack card at P3 and the manifest's `review` block at G9), and a string typed
four times says something different in one of them.

**Why this is a founder decision and not a task.** Scoring 300 items costs $300–800 and a
person who speaks Spanish natively. The plan prices it (§Effort, "native reviewers
$300–800 per language ×4") and makes it the P2→P3 gate. Nobody in this environment can
spend that, and the phase's own Opus agent scoring its own output is not an independent
measurement of it — it is the same model marking its own homework, which is why
`REVIEWER_KIND_AGENT` exists as a separate constant from `REVIEWER_KIND_PAID_NATIVE`.

**The question was:** _Do you commission the paid native Spanish reviewer now (≈$300–800,
300 items, turnaround unknown), or does P3 start on a pack whose wrong-item rate is
published as `None` with the PROVISIONAL string and re-gated later?_

### The ruling

> **B3** → P3 proceeds. The 300-item sample is scored by an Opus reviewer as
> `REVIEWER_KIND_AGENT`; the manifest and S001 card carry
> `PROVISIONAL (unreviewed by a paid native speaker)` verbatim; `gate_passed()`
> accepts an agent-scored rate ≤ 2 % for
> the automated run; the paid native review is a **release prerequisite** listed in
> `docs/RELEASE.md`.

So the second branch, with the paid pass moved to release rather than dropped. What rides
on it is unchanged: plan §Risks 7 says a Spanish defect rate above 2% discovered late
invalidates P3–P6, and moving the paid measurement to P8 is accepting exactly that
exposure with the ruling's eyes open. `docs/RELEASE.md` lists it first for that reason.

### What the ruling needs, and what it already has

| Part                                                      | State                                                                         |
| --------------------------------------------------------- | ----------------------------------------------------------------------------- |
| the PROVISIONAL string, verbatim, in the two doc carriers | **already true**, and asserted by `tests/test_sample.py`                      |
| `gate_passed()` accepting an agent-scored rate            | **already true** — and read the paragraph below, because this needs no change |
| the paid review listed as a release prerequisite          | **done this round** — `docs/RELEASE.md`, item 1                               |
| the manifest and S001 card carrying the note              | **not built** — manifest `defectRate` is a bare value; S001 is P3             |
| an actual agent-scored sheet                              | **not drawn** — no pack has ever been built (B9, B16)                         |

**`gate_passed()` needed no change, and that is worth one paragraph rather than a tick.**
It reads `rate is not None and rate <= MAX_DEFECT_RATE` and has never looked at
`reviewer_kind` at all. So the ruling's gate clause was satisfied before it was written —
and the consequence is that **nothing in code now distinguishes the automated pass from
the release gate.** The distinction lives only in `docs/RELEASE.md`, which is prose. A
release build could call `gate_passed()`, get `true` off an agent-scored sheet, and be
correct by the code and wrong by the ruling.

Two honest options for whoever owns `sample.py`: give `gate_passed()` a
`require_paid: bool = False` parameter that the release path passes `True`, or leave it
reviewer-blind and make the release checklist the only gate. The first is a few lines and
turns a prose gate into a code one; the second is what exists. Either way it should be a
decision rather than an accident of a function that predates the ruling. Recorded here
rather than fixed: `sample.py` is not in this lane.

---

## B4 — `coursekit sample es --n 300` — RESOLVED, docs only

**It was never a missing capability.** Per-stage options ride on `--set` for all seven
verbs, by the scaffold's stated decision, and a bare `coursekit sample es` already draws
`REVIEWER_SAMPLE_ITEMS = 300` at `SAMPLE_SEED = 20260911`, which is precisely what the
plan's P2 row asks for. The spelling in the briefs and in `docs/P2-REPORT.md` §B4 was
wrong; the CLI was not.

Measured on this tree, 2026-09-12:

```
$ uv run coursekit sample es --n 300
Error: No such option: --n                                                   exit 2
$ uv run coursekit sample es
sample failed: no exercise artefact at build/es/g7/exercises.jsonl;
`coursekit sample` draws from G7 output, so run `coursekit build es` first.   exit 4
```

Both exits are right. The second is the good one: the stage refuses to draw from nothing
rather than writing an empty sheet with a 0% defect rate.

**One thing the fix uncovered, and it is not cosmetic.** `config/base.py` defines exit
**2** as "the verb exists, the stage or validator behind it is not registered". Click
writes **2** for any usage error, before a command body runs. So to a caller — a CI step,
a script — a mistyped flag and an unwritten stage are the same number. `coursekit` cannot
change that; Click owns the exit. It is therefore pinned rather than fixed:
`tests/test_sample.py::test_the_phantom_n_flag_is_rejected_and_collides_with_exit_2`
asserts both codes and the collision, so adding `--n` to `cli.py` later fails that test
and forces the documentation to be corrected in the same change. The worst outcome — the
flag being _accepted and ignored_, drawing some other number of items under a command line
that says 300 — is what that test exists to prevent.

The hazard entry in `docs/owned/p2-validate-ci.json` → `knownHazards` is now `RESOLVED`
with the measurement attached, rather than `known`.

---

## B5 — S152 has a validator and no screen — DECIDED 2026-09-12

**The fact.** INV-PACK-17 (`docs/invariants.md` line 645) reads:

> Every sentence, voice and derived list whose licence requires attribution is reachable
> from the rendered credits surface (**S152**), itself reachable from the report sheet
> (S045) and About (S137). Gate: an attribution-requiring asset with no reachable credit
> fails the build

`~/duolingo-research/deep/00-PRODUCT-MAP.md` **stops at S151**; the string `S152` appears
in it **zero** times (checked 2026-09-12). The invariant is enforced in code — validator
**F3** in `validators/freelingo.py`, plus G9's own gate in
`test_g9_package.py::test_INV_PACK_17_fails_the_stage_and_writes_nothing` — so the pack
side is real. The **screen** is a screen id in an invariant with no row, no states and no
copy slots anywhere.

This is a departure from the map, not a bug in it: the map is a transcription of
Duolingo's 151 surfaces, and Duolingo has no per-sentence credits surface because it owns
its sentences. Freelingo needs one because its sentences are Tatoeba-attributed and its
frequency ordering is CC BY-SA-4.0 derived. The plan already says so (§Data model,
"Per-sentence credits (S152, new)"), which is why the id exists at all.

**Why this is a founder decision.** The map is the P3/P4 build contract — "every product
map state has a defined render; an undefined state is a build bug" (plan §Non-negotiables
3). S152 is currently a state with no definition, so P4 either builds it from an invariant
sentence or does not build it, and either way something in the non-negotiables is not
true. The map also lives **outside the repo**, in the research corpus, which no phase
agent may rewrite.

**The question was:** _Does S152 get a real row in `deep/00-PRODUCT-MAP.md` — states, copy
slots and its two entry points (S045, S137) — before P4 builds it; and if so, who writes
that row, given the corpus is research and not a repo file?_

### The ruling

> **B5** → S152 now has a product-map row (Surface 16 in `deep/00-PRODUCT-MAP.md`):
> states `list · filtered · sentence-detail · empty · pack-missing`, entry points S137 →
> `Content credits` and S045 → `Credits for this sentence`. P4 builds it.

**Verified, not taken on trust.** The row exists in the corpus as of 2026-09-12:
`~/duolingo-research/deep/00-PRODUCT-MAP.md` line 378 opens "Surface 16 — Credits (S152)
— added 2026-09-12 by founder ruling B5", the S152 row carries the five states above and
**ten** copy slots — nine backticked strings plus the per-row `sentence text` the corpus
writes unbackticked, which is the one a quoter loses — and the file's own count line now
reads "**152 screens/state-groups**
(`S001`–`S152`)" where it used to stop at S151. The string `S152`, which appeared zero
times in the map when this blocker was filed, now appears in it.

So plan §Non-negotiable 3 — "every product-map state has a defined render; an undefined
state is a build bug" — is true again, and INV-PACK-17's screen half has somewhere to be
tested at P4 rather than nowhere.

The copy slots, verbatim from Surface 16, are mirrored in `docs/pack-provenance.md` so a
P4 implementer does not have to read the corpus to build the screen. Two properties of
the row are easy to lose in the build and are worth restating:

- **it reads only the pack's `sentence` / `audio` / `meta` rows, with no network.** A
  credits surface that needed a connection is a credit that vanishes offline, in an app
  whose only network-dependent flow is the pack download;
- **`pack-missing` is one of the five states.** Credits for a pack that is not installed
  is a real state, not an error, and the map says so.

**Still outstanding:** the screen itself (P4), and the invariant's `E` half. INV-PACK-17
is claimed by nobody today; the pack half is enforced by validator F3 and by
`test_g9_package.py::test_INV_PACK_17_fails_the_stage_and_writes_nothing`, and this
documentation lane claims **no** invariant id because it writes no test.

---

## B6 — Azure is dead; Spanish bakes on Kokoro — DECIDED 2026-09-12, BUILT

**What the plan says.** §Approval: "Approving this plan accepts the rulings tables, the
phase order with a founder checkpoint between phases, **Azure as the voice vendor**, and
the 120 MB per-language audio budget." §Content pipeline: "Audio: Azure Neural, one locale
per course, four voices." EC-PACK-17's remedy: "one locale per course (es-ES, fr-FR,
de-DE, ja-JP); cast breadth from Azure Neural within the locale, Polly backup."

**What actually happened.** No cloud credentials exist in this environment — no Azure, no
AWS — so Spanish is baked on **Kokoro** (Apache-2.0 code and weights, `kokoro-onnx`,
`lang_code 'e'`). Recorded by the G8 lane as `OVERRIDE-VOICE-VENDOR` in
`docs/owned/p2-g8.json`. Piper stays a build-time-only tool reserved for German at P7; its
single Japanese voice is ruled out as CC BY-NC-SA.

**Consequence 1, and it must not go unsaid: `locale: es-ES` is now a course claim, not a
fact.** Azure Neural publishes a locale sub-tag per voice, so `es-ES` was vendor-backed
and machine-checkable. Kokoro's Spanish voices declare **no regional accent**. Nothing in
the toolchain can falsify the `es-ES` line in a shipped manifest any more.

The only falsifier left is the 300-item native-reviewer sample of B3 — **so the reviewer
brief must now check accent consistency, not only correctness.** That clause is
load-bearing, not a nicety: without it, `es-ES` is a string the project asserts about
itself with nothing anywhere able to contradict it, and the sample is the last place a
Latin-American-sounding `es-ES` course could be caught. `content/es/review/RUBRIC.md`
must carry it before the sheet is sent.

**Consequence 2: two of the four cast roles are blends.** Kokoro ships **three** Spanish
voices where the cast wants **four**, so two roles are deterministic weighted blends of
stock voices (`D-CAST-ES-02`, `content/es/cast.yaml`). Deterministic, and pinned by the
re-bake key (INV-AUD-08 puts the engine in the key, so a blend on a different engine is a
different clip) — but a blended voice is a founder-visible product choice, not an
implementation detail: it is what a learner hears for half the cast.

**The question was:** _Do you accept Kokoro as the voice engine for es — and by extension
fr/ja — with `locale: es-ES` demoted to a course claim checked only by the reviewer
sample, and two of four cast roles as blends; or do you restore Azure and supply
credentials?_

### The ruling

> **B6** → Kokoro is the voice engine for es/fr/ja (Piper build-time only for de).
> Manifests replace `locale: es-ES` with `language: es` + `accent_claim: unverified`; the
> reviewer rubric checks accent consistency; the two blended cast roles stay, declared in
> `cast.yaml`.

Accepted, and with one thing the question did not offer: the manifest **stops claiming
the locale**. `es-ES` does not become a soft claim, it is replaced by a fact
(`language: es`) plus an explicit absence of a claim (`accent_claim: unverified`). That is
a better answer than the one asked for — an unfalsifiable claim removed beats an
unfalsifiable claim footnoted — and it means the ruling has five parts. **All five are
built**, as re-measured on `main` at the P2 round-3 integration: three landed in the
lane that wrote this file, the manifest part landed with `p2r3/expand-bake-package`, and
the `REVIEW_DIMENSIONS` constant landed at the integration itself. The table below is
the authority.

| Part of the ruling                                        | State          | Where / who                                                                            |
| --------------------------------------------------------- | -------------- | -------------------------------------------------------------------------------------- |
| Kokoro is the engine for es (fr/ja at P7)                 | **built**      | `content/es/cast.yaml` `D-CAST-ES-00`, `config/g8.py`                                  |
| the two blended roles stay, declared in `cast.yaml`       | **built**      | `D-CAST-ES-02`: Rosa and Nico, with weights and rates                                  |
| the reviewer rubric checks accent consistency             | **built here** | `content/es/review/RUBRIC.md` §`accent_consistency`                                    |
| `accent_consistency` **declared** in code                 | **built**      | `REVIEW_DIMENSIONS`, `config/sample.py` — landed at the round-3 integration            |
| manifests carry `language` + `accent_claim`, not `locale` | **built**      | `cast.yaml` (no `locale:` key), `config/g8.py::ACCENT_CLAIMS`, `packbuild/manifest.py` |

Three notes, kept because each of these parts failed in a way that was not obvious, and
because two of them were closed by the integration rather than by the lane that wrote
them down.

**1. The rubric and the constant had to agree on one string, or the sheet was worthless
— and they did not.** `sample.py::read_scores` raises `ScoreError` on any `dimensions`
key outside `REVIEW_DIMENSIONS`, and the caller turns that into exit 4. So a rubric that
says `accent_consistency` against a constant that does not carry it does not produce a
slightly wrong rate — it produces **no rate at all**, for the whole file, including the
five text dimensions that were scored correctly. `RUBRIC.md` shipped the sixth dimension
and `config/sample.py` did not, in two different lanes' file lists, and the reviewer lane
was already drawing against the rubric.

**Closed at the P2 round-3 integration**: `accent_consistency` is the sixth member of
`REVIEW_DIMENSIONS`, with the spelling this file filed
(`docs/owned/p2r3-provenance-docs.json` → `crossLaneContracts`) and for the reason it
gives — `accent` alone reads as the orthographic diacritic in a Spanish rubric. Declaring
it cannot move a published rate on its own: RUBRIC.md gives an `accent_consistency`-only
failure the `awkward` verdict and `DEFECT_VERDICTS` counts only `wrong`. `RUBRIC.md`
§"If the constant does not carry it yet" is kept as a fallback for a tree where the
constant has been reverted or renamed, not as a description of this one.

**2. `cast.yaml` said `locale: es-ES` on the lane that wrote this note, and does not on
`main`.** Re-measured on `main` after `p2r3/expand-bake-package` merged, 2026-09-12:
`content/es/cast.yaml:12` reads `language: es`, `:23` reads `accent_claim: unverified`,
and there is **no `locale:` key** — `grep -n '^locale:' content/es/cast.yaml` matches
nothing. `config/g8.py:61` defines `ACCENT_CLAIMS = ("unverified",)` with no `verified`
member, because the only thing that could produce that claim is B3's 300-item sample.
`packbuild/manifest.py:244` writes `"accentClaim": accent_claim_for(inputs.lang)` into
the manifest's `audio` block and `:325` refuses a manifest whose `accentClaim` is outside
`ACCENT_CLAIMS`. `content/es/audio-manifest.json:4` carries `"accent_claim":
"unverified"`.

The note the lane left here — that `cast.yaml` carried both the fact and the withdrawn
claim at once — was true at that branch's sha and is false at this one. It is recorded as
history rather than deleted because the thing it warns about is generic: prose that
reports a build state is only true at the sha it was measured on, and the merge queue is
where it gets re-measured. The commands used are in
`docs/owned/p2r3-provenance-docs.json` → `integratorMustRemeasure`.

**3. The manifest declares the absence now.** The lane's measurement — `config/g9.py`'s
`MANIFEST_EXTRA_FIELDS` carrying neither `accent_claim` nor `locale`, so a shipped
manifest made **no** accent claim and was only accidentally compliant — is superseded by
the same merge: the `audio` block carries `accentClaim`, and an absence _declared_ is
what the ruling asked for. An unstated claim and a claim stated as unverified read the
same to a validator and differently to a learner on S137, which is why the distinction
was worth the field.

**And the thing that makes all of this matter is B18**, below: even with the rubric, the
constant and the manifest field all in place, the drawn sheet carries no clip reference
and no voice role, so there is nothing for a reviewer to listen to. The accent claim's
only falsifier does not currently reach the falsifier's hands.

---

## B7 — `mutation.yml` has never produced a score — NON-GATING by ruling, measurement kept

Pre-existing, **non-gating**, and not caused by P2. Recorded here with the measurement so
that no report has to quote a number that did not print.

### The ruling

> **B7** → stays non-gating; Stryker `coverageAnalysis: off` and tighter INV-DAT
> generators as a P3 chore.

So this is **explicitly not a P2 or P3 gate**, and the whole measurement below stays on
the page anyway. Two reasons it is kept rather than collapsed to one line: the ruling
picks `coverageAnalysis: off` specifically, and the measurement is what rules out the two
fixes that look right and are not (raising `dryRunTimeoutMinutes`, lowering
`PROPERTY_RUNS`) — a reader who has only the ruling would re-derive both. And the plan's
P1 gate row does ask for a mutation score ("Stryker score ≥ threshold nightly"), so
"non-gating" is a founder override of a plan line, not a restatement of it.

`coverageAnalysis: off` is the right lever for the reason the numbers below give: the
property is 4,350 ms un-instrumented and >300 s under `perTest`, so it is the
instrumentation mode and not the property that is the problem. Turning coverage analysis
off costs wall-clock on the nightly (every mutant runs the whole suite) and buys a score
that exists. **Nothing about that is done**: no score exists for any sha, and the P3
chore is still a chore.

**What happens.** Stryker instruments **118 of 844 files** with **10,765 mutants**, starts
the initial test run with `perTest` coverage analysis, and dies in the **dry run** on an
`INV-DAT-` property at the **300,000 ms** timeout. Identical failure on the P1 sha
`75d6242`, and P2 touched nothing under `packages/core/src/`. The job reports success only
because `continue-on-error: true` holds it; the "Record the score" step then finds no
`reports/mutation/mutation.json` and writes "Stryker did not get far enough to score" into
the run summary. **No mutation score exists for any sha in this repository.**

**Reproduced locally, 2026-09-12**, `stryker run stryker.config.json --dryRunOnly` on this
Mac (log: `stryker-dryrun.log`, path in the task report):

```
04:43:03 INFO Instrumenter Instrumented 118 source file(s) with 10765 mutant(s)
04:43:04 INFO DryRunExecutor Starting initial test run (vitest test runner with "perTest" coverage analysis)
04:56:33 ERROR DryRunExecutor One or more tests failed in the initial test run:
  INV-DAT-09 import writes no economy config and resolves no unknown pack
    [INV-DAT-09] an archive whose config raises the freeze cap never raises this build s cap
      Test timed out in 300000ms.
04:56:33 ERROR Stryker There were failed tests in the initial test run.
```

Three numbers worth having:

- **13 m 29 s** of dry run before it died — comfortably inside
  `dryRunTimeoutMinutes: 30`, which settles that the dry-run budget is not the clock that
  fired;
- the offending property is **`packages/core/src/data/import.test.ts:392`**, a fast-check
  property at `numRuns: PROPERTY_RUNS` (10,000). CI reported an **INV-DAT-04** property and
  this run an **INV-DAT-09** one; they are neighbours in the same file and the same
  `describe` neighbourhood, and which one is reached first depends on worker scheduling.
  The class of failure is identical;
- the same test takes **4,350 ms** un-instrumented (`vitest run --project core
src/data/import.test.ts`, 25 tests, 18.75 s total). So `perTest` instrumentation makes
  it at least **69× slower** — not a property that got slower, a different execution mode.

**Where the 300,000 ms comes from, and why it is not `dryRunTimeoutMinutes`.** It is
Vitest's per-test timeout, not Stryker's dry-run budget:
`vitest.config.ts` sets `TEST_TIMEOUT_MS = 60_000` and multiplies it by
`STRYKER_TIMEOUT_FACTOR = 5` when `STRYKER_MUTATOR_WORKER` is set — 60,000 × 5 =
**300,000**. `stryker.config.json`'s `dryRunTimeoutMinutes: 30` is a different clock and
is not the one that fired. **Raising `dryRunTimeoutMinutes` would therefore change
nothing**, which is why this round did not raise it: the individual test dies first and
Stryker refuses to score a tree whose initial run is red.

**Why `PROPERTY_RUNS` was not lowered.** Out of the question, and the brief says so.
`packages/testkit/src/property-gates.test.ts` fails if any `numRuns` in the tree is below
`PROPERTY_RUNS = 10_000`, deliberately: a property that is too slow has a loose generator,
and buying a mutation score by weakening every property is buying the wrong number.

**What the real fix is, and why it is not in this lane.** The property this run died on
is `packages/core/src/data/import.test.ts:392`,
`it('[INV-DAT-09] an archive whose config raises the freeze cap never raises this build s cap')`;
the one CI named is `:277`,
`it('[INV-DAT-04] the classifier puts history before the gap, for any generated overlap')`.
Both are fast-check properties over generated import archives, in
`packages/core/src/data/`, and either can be the first to blow the clock. The
`p2fix-downstream` file lane grants `packages/core/src/day/` (DAY, the civil-date module),
not `packages/core/src/data/` (DAT, import/export). They are different modules and the id
prefix `INV-DAT-` belongs to the second. So the two things that would actually work — a
cheaper generator for that property, or a `stryker`-mode carve-out for it — are both
outside the lane, and the two things inside the lane (`stryker.config.json`'s dry-run
budget; `packages/core/src/day/`) are both the wrong file.

**What to do, for whoever owns `packages/core/src/data/`:** tighten that property's
generator until the dry run completes under `perTest` instrumentation, then run
`stryker run --dryRunOnly` to confirm, then a full nightly. The commit that records a
measured whole-engine score in `docs/P1-REPORT.md` is also the one that takes
`continue-on-error: true` off `mutation.yml` — `stryker.config.json`'s `thresholds_comment`
already says so.

---

## B8 — `build-es` names no language engine, so V8 blocks even after B1 — FOUND 2026-09-12

**This one is new, and it matters because it is invisible until B1 is fixed.** The
authoring shards will unblock G5; this will then stop the build one stage later, and the
failure will read as "the new candidates are bad".

`pack-ci.yml`'s `build-es` runs exactly:

```
uv run coursekit build es --set max_pairs="$COURSEKIT_MAX_PAIRS"
```

No `--set languagetool_url=`, no `--set kenlm_model=`. G6 treats that the way its
docstring says it must — "no `--set languagetool_url=` means nobody started a sidecar:
`grammar_engine: none`, degrade, carry on, and let V8 decide whether a pack may ship that
way" — and V8 decides no (`validators/language.py`, the `len(dead) == len(...)` branch):

> no engine that can find an error ran: grammar_engine, perplexity_engine are all 'none'.
> G6 reported {} over N candidate(s), which is zero errors from nothing — the exact
> reading INV-PACK-14 fails.

**Both engines are absent for structural reasons, not by oversight.**

- **LanguageTool** is a Java sidecar. `build-es` installs Python and `opus-tools` and
  starts no server, so there is nothing at any URL to ask.
- **KenLM** is worse: the pip package ships the **query** module only, no `lmplz`
  (`engines/kenlm.py` says so and refuses to fall back to a home-made ARPA, correctly).
  Training needs binaries built from source with Boost, so a runner with the `lm` group
  synced still cannot train a model, and without a model there is no band.

So today `coursekit build es` can complete and `coursekit validate es` **cannot exit 0**,
for any content whatsoever. The gate this fix round was asked to turn green — "validate-es
exits 0 … V8 naming the engines it actually used" — is unreachable from the current
workflow, and no amount of authoring changes that.

**The remedy is one step in `build-es`, the licence is already cleared, and it is
proven, not proposed.** LanguageTool is on the ingest allow-list as `grammar_rules ·
languagetool · shippable · LGPL-2.1-or-later` (`coursekit doctor es`), Java is on
`ubuntu-latest`, and the server is one jar:

```sh
curl -fL -o LanguageTool-6.6.zip https://languagetool.org/download/LanguageTool-6.6.zip
unzip -q LanguageTool-6.6.zip
java -cp LanguageTool-6.6/languagetool-server.jar \
     org.languagetool.server.HTTPServer --port 8081 &
uv run coursekit build es --set max_pairs=200000 --set languagetool_url=http://localhost:8081
```

**The URL is the server base, not an endpoint.** `LanguageToolEngine` appends
`/v2/languages` and `/v2/check` itself; passing `…/v2/check` fails the stage with a 404 on
`/v2/check/v2/languages`. That is measured, and it is written down here because it is the
mistake anyone copying the LanguageTool API docs will make once.

**Measured on this Mac, 2026-09-12**, against a real LanguageTool **6.6** server (build
2025-03-27, Java 22.0.1):

- probe: `POST /v2/check language=es text="Yo tengo un qwzxvb grande."` →
  `MORFOLOGIK_RULE_ES`, which reproduces `config/g6.py`'s claim that Spanish has a spell
  checker as well as grammar rules;
- `test_live_languagetool_spanish_has_a_spell_checker_and_g6_says_so` — **passed**:
  `grammar_engine` starts `languagetool/`, `spellcheck_engine` is not `none`, and neither
  is a mock;
- `test_live_languagetool_alone_is_enough_to_stop_v8_blocking` — **passed**: with
  **no KenLM model at all**, `degraded_to` is `grammar_only` and V8 returns **no blocking
  finding**.

So the sidecar alone is enough. KenLM can stay absent; the pack ships with the
`grammar_only` warning naming what it lost, which is the honest state and a state the
suite already has a name for.

Both live tests are in `tests/test_g6_validate_language.py`, gated on
`COURSEKIT_LANGUAGETOOL_URL` the way `test_g2_band.py` gates ELELex, so they skip on a
runner with no Java and run on one that has a server. Beside them,
`test_the_invocation_build_es_uses_today_leaves_v8_with_nothing` runs **everywhere** and
pins the broken state by name: the day a sidecar step lands in `build-es`, that test fails
and the failure says which paragraph of this file to delete.

`.github/workflows/pack-ci.yml` is **not in the `p2fix-downstream` file lane**, so this is
written down rather than done. It is the single highest-value line left in P2 after the
candidates: without it, the first green G5 buys a red V8.

**Do not reach for the mock.** `engines/mock_lt.py` exists for tests and G6 announces it
(`test_INV_PACK_14_a_mock_engine_is_a_warning_and_never_a_silent_pass`); a pack validated
against a stand-in is a pack whose grammar was checked by nothing, wearing a label that
says so. That is a worse outcome than the block.

---

## B9 — unit 1 lesson 1 cannot hold a sentence — DECIDED 2026-09-12, NOT BUILT

**This is the only thing between `coursekit build es` and G6.** 481 of 490 gap slots are
filled. The nine that are not are `u1/l1/s0` … `u1/l1/s8`, and no amount of authoring
changes that, so it is written up here as a decision rather than as work.

### What the ledger permits in lesson 1

G4 emits the first lesson of the first unit with a permitted vocabulary of **five
lemmas** — `bueno`, `día`, `hola`, `noche`, `tarde` — because `index.known` at that point
holds only what `_split_new_lemmas` has dealt to that lesson. There is **no verb** (`ser`
arrives at lesson 3), **no article** (`el` at lesson 19), no preposition, and no proper
noun anywhere in the course ledger. A Spanish sentence needs at least one of those.

### And the one greeting that should have worked does not

`es_core_news_md` 3.8.0, which is pinned and which G1, G5 and the validators all read,
lemmatises every **prenominal** form of `bueno` to something that is not `bueno`:

```
'Hola, buenos días.'    -> ['hola', 'buen', 'día']      buen  is not a ledger lemma
'Hola, buenas noches.'  -> ['hola', 'buena', 'noche']   buena is not a ledger lemma
'Buenas tardes.'        -> ['buenas', 'tarde']          2 display tokens, under MIN_TOKENS
```

So `Buenos días.` is **out of vocabulary in the lesson that teaches both `bueno` and
`día`**, and the only surface that reaches the lemma `bueno` is the bare discourse marker
(`Bueno, hola.` → `['bueno', 'hola']`, two tokens, under the floor).

What is left inside the window is word lists: `Hola, hola, hola.`, `Día, tarde, noche.`,
`Hola, bueno, día.` Eleven such strings exist, `p2fix-author-u01-u06` found the same
eleven independently, and **this lane will not ship them as the first lesson of a Spanish
course.** Padding nine slots with them would turn the gate green and teach nobody
anything, which is the failure mode the ≤2% reviewer gate exists to catch two months
later and at a native speaker's expense.

### The three ways out, with what each costs

| Option                                                                                                               | What it changes                                                                 | Cost                                                                                                                                                                                                                                                                                                                                                |
| -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1. Re-chunk unit 1** so lesson 1 also deals a verb (`ser`)                                                         | `content/es/curriculum.yaml` unit 1 target order, or `_split_new_lemmas`'s deal | Unit 1's lesson windows move, so unit 1's gap SET and its `ledger_digest`s move with them. Units 2-30 keep their windows (the unit total is unchanged), so the blast radius is the ~40 unit-1 slots `p2fix-author-u01-u06` authored, which must be re-keyed against a regenerated brief.                                                            |
| **2. Declare the lemmas the model actually produces** — add `buen`/`buena` beside `bueno` in unit 1's target lexemes | `content/es/curriculum.yaml`                                                    | `index.known` gains an element from lesson 1 onward, so **every** slot's `ledger_digest` changes and all 9,682 authored rows go `stale_ledger` at once. Needs a full re-key, and the wider window may also un-gap slots that are currently authored, which G5 treats as a hard error (orphans). The most correct fix and by far the most expensive. |
| **3. Let lesson 1 be phrases, not sentences** — a per-lesson `MIN_TOKENS` of 1 for a lesson whose window has no verb | `config/g0.py` / G5's length axis                                               | Cheapest, and it makes `Hola.` and `Buenas tardes.` shippable items, which is what lesson 1 of a real course is. It does not fix `buenos → buen`: `Buenos días.` stays out of vocabulary, so lesson 1 would teach `hola`, `día`, `tarde`, `noche` as bare words and `bueno` not at all.                                                             |

### The ruling — none of the three options, and all three problems

> **B9** → three changes together: (a) a G1 adapter lemma-normalisation table
> (`buen/buena/buenos/buenas → bueno`, and any prenominal/apocopated form the curriculum
> names) so the taught phrase is in vocabulary; (b) per-lesson `MIN_TOKENS = 1` for a
> lesson whose window holds no verb — lesson 1 is words and fixed phrases, as the live
> capture shows Duolingo's level-1 lessons are; (c) a G3 validator failing the build when
> a declared target lemma is unreachable by the pinned lemmatiser for every form the
> course teaches. Re-key only rows whose `ledger_digest` changes.

Read against the three options costed above, this is **option 2's correctness at option
3's price**, plus the validator. (a) fixes `buenos → buen` where it happens — in the
adapter, not in the curriculum — so `index.known` does not gain an element and
`ledger_digest` does not move for every slot in the course, which is what made option 2
cost a full re-key of all 9,687 rows. (b) is option 3, scoped to the lessons that need it
instead of applied globally. (c) is the general defect the last paragraph of this section
asked for, adopted as part of the ruling rather than left as a suggestion.

"Re-key only rows whose `ledger_digest` changes" is the clause that keeps the cost down
and the clause most likely to be got wrong: (a) changes lemmatiser output, so any row
whose analysis contained a normalised form has a different digest even though no
curriculum line moved.

### What is built: nothing

Checked on this tree, 2026-09-12, rather than assumed:

| Part                                                 | State         | Evidence                                                                                                                   |
| ---------------------------------------------------- | ------------- | -------------------------------------------------------------------------------------------------------------------------- |
| (a) G1 lemma-normalisation table                     | **not built** | `adapters/spacy_es.py` normalises to NFC and lowercase and nothing else — no form map anywhere, and none in `config/g1.py` |
| (b) per-lesson `MIN_TOKENS = 1` for verbless windows | **not built** | `config/g0.py` and `config/g5.py` both carry a flat `MIN_TOKENS: Final[int] = 3`                                           |
| (c) G3 validator for unreachable target lemmas       | **not built** | no such validator is registered                                                                                            |

So **B9 is still the phase blocker it was**, with a decision attached. `u1/l1/s0 … s8`
remain the nine unfilled slots of 490, `coursekit build es` still cannot pass G5 for
unit 1, and none of that changes until (a) and (b) land. The difference the ruling makes
is that the work is now specified, and that the eleven word-list strings this round
refused to ship stay refused: (b) makes `Hola.` and `Buenas tardes.` legitimate one- and
two-token **phrases**, which is not the same thing as padding a slot with
`Hola, bueno, día.`

The general defect behind all three — **a curriculum may declare a target lemma the
pinned lemmatiser never produces for the forms the course intends to teach** — is exactly
what (c) is, and it is worth naming why it must be a validator and not a fix to the one
case: `bueno` was found by hand, by one lane, at one slot. Nothing would have found the
second instance.

---

## B12 — `coursekit validate es --pack … --report …` — RESOLVED, docs only

Same class as B4. The phase gate spells the validate step

```
uv run coursekit validate es --pack build/es/es.pack --report build/es/validator-report.json
```

and neither option exists: `coursekit validate` takes `{language}` and an optional
`--only V1…F5`. The pack and the report are **derived** from the build root
(`validators/report.py::report_path` is `<build root>/<lang>/validator-report.json`), which
is the design — a validator report that could be pointed somewhere else is a report that
can be pointed at a file nobody reads. `.github/workflows/pack-ci.yml` already runs the
real spelling, `uv run coursekit validate es`. Nothing to fix in the tool; the gate text
is what was wrong.

## B13 — `build-es` synced no `align` group — RESOLVED

`uv sync --locked --group nlp --group lm --group tts` and G7 needs `align`. It exits 3 by
name and refuses to degrade, because a fallback aligner produces word-bank hints that are
wrong in a way no row-level validator can see. Invisible until G5 passed, exactly like B8.
Fixed in `pack-ci.yml`; `torch` is routed to the CPU index on Linux by the deps lane's
explicit `[[tool.uv.index]]`, so it is CPU wheels. The job's timeout goes 60 → 90 minutes
in the same change.

## B14 — a starved slot crashes G7 instead of failing by name — DECIDED 2026-09-12, NOT BUILT

Measured here: with `u1/l2/s0` left with no G6 survivor, G7 raises

```
KeyError: 'selected slot (1, 2, 0) is a gap and no accepted candidate exists for it.
G5 over-generates and G6 rejects; a slot with no survivor is a content failure, not
something G7 may fill.'
```

The sentence is right and the exception type is wrong: every other stage returns
`StageResult(ok=False, …)` and the dispatcher exits 4, so this one prints a Python
traceback where the others print one line. It does not change what is true about the pack
and it is not what stopped this round, so it is recorded rather than fixed — the round's
budget went to the content.

### The ruling

> **B14** → `StageResult(ok=False)`, message verbatim.

Which is what the paragraph above proposed, now decided: the shape changes, the sentence
does not. Keeping the message verbatim matters more than it looks — it is the only place
that explains why G7 is not allowed to fill a starved slot, and a rewrite during the
refactor would lose the argument and keep the error.

**Not built.** Checked on this tree, 2026-09-12: `stages/g7_expand.py:157` still reads
`raise KeyError(` with that message, and the `_anchor_lemma` neighbourhood is unchanged.
One line below it there is a second `raise KeyError` — "selected item names sentence
{sid} which G0 never ingested" — which is the same defect on the corpus path, and whoever
does the first should do the second in the same change.

## B15 — G7 made word-bank tiles out of punctuation — RESOLVED 2026-09-12

An authored candidate has no `analysed_sentence`, so G7 fell back to a bare whitespace
split and `Hola,` and `noche.` became word-bank tiles. The distractor core is then asked
for two same-POS same-band lexemes for a string that is in no lexicon:

```
g7 failed: NotEnoughDistractors: concept:subject_pronouns: needed 2 distractors for
'Hola,' (POS , band unbanded) and the rule core found 0.
```

The asymmetry in the same file was the tell — `_lemmas_for`'s fallback already stripped
the same characters, so one sentence produced clean lemmas and dirty tiles. Fixed: the
fallback strips edge punctuation and drops what is left empty, which is the shape G1's
`display_tokens` have. No lemmatiser runs there.
`test_INV_PACK_40_an_authored_candidates_tiles_carry_no_punctuation` pins it. This would
have stopped the build on ordinary authored sentences, not only on the diagnostic ones.

## B16 — G7 looks a distractor up by SURFACE, and an authored candidate has no analysis — OPEN (writer landed, reader outstanding)

Found immediately after B15, by the same run. With the tiles clean, G7 stops one line
later:

```
g7 failed: NotEnoughDistractors: concept:subject_pronouns: needed 2 distractors for
'Hola' (POS , band unbanded) and the rule core found 0.
```

`_decoys(..., lemmas=[target_tokens[gap_index]], ...)` passes the **surface** where a
lemma is expected. For a corpus sentence that mostly works by accident — a mid-sentence
lowercase surface often equals its lemma — and for an authored candidate there is no
analysis at all, so POS is empty and the band is `unbanded` and the rule core has nothing
to choose from. Every authored item whose gap lands on a capitalised or inflected surface
is exposed.

**Half of it is fixed here and the half that is left is the half that needs a decision.**
`_anchor_lemma` now hands `_decoys` the lemma at the gap index instead of the surface at
the gap index, and for a corpus sentence that is the real lemma from G1. For an authored
candidate the "lemma" is still only the casefolded stripped surface, because there is no
analysis to take a real one from, so the next run stops one item later:

```
g7 failed: NotEnoughDistractors: authored:1:1:Bueno, tardes, noches.: needed 3
distractors for 'tardes' (POS , band unbanded) and the rule core found 0.
```

`tardes` is a surface; `tarde` is the lemma. Every authored item whose gap lands on an
inflected form is exposed, which over 490 authored items is most of them.

### The ruling — DECIDED 2026-09-12

> **B16** → option 2: carry G1's analysis across G5→G7 by extending the frozen
> `CANDIDATE` contract (bump the digest; deps lane owns it).

Option 2 of the two below, and the ruling settles the objection that made it hard: the
frozen contract may be extended and the digest may move, and the deps lane owns doing it.
It also implicitly rules out option 1's open question — what G7 does on a runner with
`align` and not `nlp` — by never making G7 depend on `nlp` at all.

Two possible fixes, and the choice was a design decision for the G7 lane rather than an
integration patch:

1. **Analyse authored candidates in G7 with the registered adapter.** It is the same
   adapter and the same pinned model G5 already runs over the same text, so it is not the
   "second analyser version" the docstring worries about — but it is another full pass
   over every authored item, and it makes G7 depend on `nlp` as well as `align`, which
   means deciding what G7 does on a runner that has `align` and not `nlp`.
2. **Carry the analysis across the G5 → G7 boundary.** Cleaner and cheaper, and it
   changes `coursekit.artifacts.CANDIDATE`, which is frozen
   (`additionalProperties: false`, `required == properties`, contract digest
   `3e2f6a68…`). That is the deps/scaffold lane's contract, not this one's.

Until it is fixed, **G7 has never completed a run over authored content**, so G8, G9,
`coursekit validate`, `coursekit sample` and `coursekit sign` are still unproven on a real
course — the same list as round 1, now for a different and much narrower reason.

### B16 status after the round-3 merge (2026-09-12, `61bc272`) — the WRITER is done, the READER is not

Option 2 was taken, and two of its three parts have landed:

1. **The contract** (`p2r3/deps-contract`, merged as `d73d295`). `CANDIDATE` carries
   `analysis` — required, nullable, in G1's shape `{analyser, tokens, lemmas,
display_tokens}` — and `Token`/`Adapter` are now one shared object each rather than
   two copies, so `analysed_sentence` and `candidate.analysis` cannot drift. The contract
   digest moved off `3e2f6a68…` for this and nothing else.
2. **The writer** (`61bc272`). G5 puts its own adapter pass on every row it analysed;
   only the two `stale_ledger` short-circuits above the adapter call carry `null`. Pinned
   by `test_an_emitted_candidate_carries_the_analysis_g7_will_read`, which re-derives the
   analysis from a second independent call to the registered adapter.
3. **The reader — NOT DONE, and this is what keeps B16 open.** Re-checked on this tree,
   2026-09-12: `grep -n analysis
tools/coursekit/src/coursekit/stages/g7_expand.py` still returns the same four
   comments (lines 195, 485, 494, 743) and no code:
   `_anchor_lemma` still casefolds the surface for an authored row. So `tardes` is still
   handed to the rule core where `tarde` belongs, and the failure in the block above is
   unchanged. The data G7 needs is now on the row; nothing reads it yet.

The coded rule the contract's docstring promises is also still owed: an authored row that
G7 is asked to expand and whose `analysis` is `null` must stop the stage **naming the
candidate_id**, never fall back to the surface — which is the bug the field exists to
delete. A schema keyword cannot express "non-null exactly when G7 will read it", so that
check belongs in the expand lane and has no owning test today.

Evidence for the two parts that did land: `coursekit lint + tests` green in CI on
`61bc272` (pack-ci run 34695857430), and locally `uv run pytest` 837 collected / 0
failures / exit 0 over three runs. Before the fix the same tree was 59 failures and 15
collection errors, 148 of them the one message `candidate in candidates.jsonl line 1:
<root>: 'analysis' is a required property`.

## B17 — the course gets easier 13 times — DECIDED 2026-09-12, NOT BUILT

`coursekit validate es` ran here for the first time (diagnostic tree, so G7-dependent
validators raised; V8, V11 and F5 are independent of G7 and did measure something). V11
reports **13 unit boundaries where mean difficulty falls**:

```
V11 [u18->u19]: mean difficulty falls from 12.032 in unit 18 to 8.810 in unit 19 (-3.222)
V11 [u22->u23]: 10.491 -> 8.702 (-1.789)
V11 [u15->u16]: 10.265 ->  8.945 (-1.320)
… ten more, the smallest -0.188
```

It is not obviously wrong and it is certainly not random: an authored gap-fill sentence is
shorter and plainer than a corpus sentence that happened to fit the same window, so a unit
with many gaps reads _easier_ than the unit before it even though its vocabulary is
strictly larger. Units 19, 23 and 16 are the gap-heavy ones.

What to do with it was a content question this round did not have the budget to answer,
and it needed the reviewer sample (B3) to say whether the learner experiences it as a
regression.

### The ruling

> **B17** → V11 hard-fails only across section boundaries; within a section a fall is a
> warning in the report.

That is a change to what V11 **means**, not a waiver of the 13 findings. The reading is
that difficulty is a **section**-level promise — a section is the CEFR-labelled unit of
the course (S023/S024 render the band), and the ordering inside one is allowed to breathe
around a gap-heavy unit. All 13 findings stay in the report; twelve of them stop blocking
if they are inside a section, and any that crosses a section boundary still fails the
build.

Nobody has checked which of the 13 cross a boundary. `content/es/curriculum.yaml` has
three sections over 30 units, so the boundaries are two; the largest fall, `u18→u19` at
−3.222, is the one to look at first.

**Not built.** V11 (`validators/pack.py::mean_difficulty_is_non_decreasing`, registered
at line 381) walks unit indices and knows nothing about sections: the string `section`
does not occur **anywhere in `validators/pack.py`**, and `config/validate.py` carries no
section constant. So today every one of the 13 is a blocking finding, which is stricter
than the ruling and would fail a build the ruling says should pass with warnings. The
change needs the unit→section map, which is a curriculum output G3 already derives
(`section_cefr` is computed from which grammar concepts a section contains), so the
validator needs a way to read it rather than a new source of truth.

## B18 — the accent dimension has nothing to listen to — OPEN, found this round

**New, and created by a ruling rather than by a bug.** B6 makes the 300-item sample the
only check on how a shipped bank sounds, and the drawn sheet does not carry the audio.

`SampleItem` (`tools/coursekit/src/coursekit/sample.py`, the dataclass whose docstring is
"One row a reviewer scores") carries exactly ten fields:

```
exercise_id  unit_index  lesson_index  exercise_type  provenance
prompt  accepted_answers  distractors  source_text  source_translation
```

**No clip reference and no voice role.** So a reviewer handed
`build/es/sample-300.jsonl` has nothing to play and no way to know which of the four cast
roles a row would have been spoken by — which matters twice over, because `cast.yaml`'s
`D-CAST-ES-02` caveat asks the reviewer a role-specific question ("whether Rosa reads as
a different speaker from Plumas") that cannot be answered by someone who cannot tell
Rosa's rows from Plumas's.

Where that leaves the accent claim: `accent_claim: unverified` is falsifiable **in
principle** by the reviewer rubric and **not in practice** by the sheet the rubric is
scored against. `content/es/review/RUBRIC.md` says so at the point of use rather than
letting a scorer discover it, and tells them to omit the dimension rather than write
`"pass"` for a clip nobody played.

### What it needs

Two fields on `SampleItem` and its `to_json()`, plus the bank beside the sheet:

- **`audio_clip`** — the content-addressed clip id or its path inside `g8/bank/`, for the
  item's spoken text. G8 writes `g8/clips.jsonl`, so the join exists; the sheet does not
  make it;
- **`voice_role`** — which of `narrator` / `adult_male` / `adult_female` / `young` spoke
  it, so a role-level finding ("every Rosa row") can be stated as one;
- the **clips a sheet references** have to travel with the sheet. `build/` is gitignored
  and `es-build-<sha>` has a 7-day retention, so "the reviewer downloads yesterday's CI
  artefact" is the same failure mode that killed `pack-bake.yml` (B2). A reviewer package
  — the sheet plus its ~300 clips — is the thing to produce, and nothing produces it.

Also worth deciding at the same time, because it changes the draw rather than the row:
`SAMPLE_STRATA` is `(unit_index, exercise_type, provenance)` and does **not** stratify
over voice role. A 300-row sheet could legitimately contain almost no Rosa rows, which
would answer the blend question with a sample of four. Adding role to the strata is a
bigger change than adding two fields and should not be done by accident.

**Owner:** whoever owns `tools/coursekit/src/coursekit/sample.py` and `config/sample.py`
— the same lane that owns `REVIEW_DIMENSIONS`, so the constant and these two fields are
one change. Neither file is in the documentation lane.

**Not a gate on P3.** The text dimensions are scoreable today, so an agent-scored
wrong-item rate can exist without this. It is a gate on the **release**, because item 1
of `docs/RELEASE.md` is a paid reviewer pass and B6 put accent consistency on that
reviewer's sheet.

---

## Founder rulings — 2026-09-12 (recorded by the orchestrator; source: ~/duolingo-research/DECISIONS-LOG.md)

Verbatim, as recorded. Each is quoted again in its own section above with what it needs
and what has been built; **only** the sections above say anything about build state.

- **B3** → P3 proceeds. The 300-item sample is scored by an Opus reviewer as `REVIEWER_KIND_AGENT`; the manifest and S001 card carry `PROVISIONAL (unreviewed by a paid native speaker)` verbatim; `gate_passed()` accepts an agent-scored rate ≤ 2 % for the automated run; the paid native review is a **release prerequisite** listed in `docs/RELEASE.md`.
- **B5** → S152 now has a product-map row (Surface 16 in `deep/00-PRODUCT-MAP.md`): states `list · filtered · sentence-detail · empty · pack-missing`, entry points S137 → `Content credits` and S045 → `Credits for this sentence`. P4 builds it.
- **B6** → Kokoro is the voice engine for es/fr/ja (Piper build-time only for de). Manifests replace `locale: es-ES` with `language: es` + `accent_claim: unverified`; the reviewer rubric checks accent consistency; the two blended cast roles stay, declared in `cast.yaml`.
- **B9** → three changes together: (a) a G1 adapter lemma-normalisation table (`buen/buena/buenos/buenas → bueno`, and any prenominal/apocopated form the curriculum names) so the taught phrase is in vocabulary; (b) per-lesson `MIN_TOKENS = 1` for a lesson whose window holds no verb — lesson 1 is words and fixed phrases, as the live capture shows Duolingo's level-1 lessons are; (c) a G3 validator failing the build when a declared target lemma is unreachable by the pinned lemmatiser for every form the course teaches. Re-key only rows whose `ledger_digest` changes.
- **B1b** → course-global lesson numbers are canonical.
- **B16** → option 2: carry G1's analysis across G5→G7 by extending the frozen `CANDIDATE` contract (bump the digest; deps lane owns it).
- **B14** → `StageResult(ok=False)`, message verbatim.
- **B17** → V11 hard-fails only across section boundaries; within a section a fall is a warning in the report.
- **B7** → stays non-gating; Stryker `coverageAnalysis: off` and tighter INV-DAT generators as a P3 chore.
- `pnpm format` is the first commit of P3's deps task.

---

## B19 — the B9 ruling's own other clauses moved the gap list — OPEN, the phase blocker

**Found by running the pipeline after the round-3 merge queue, 2026-09-12.** Not a
contradiction between two specs and not a lane's mistake: two clauses of one founder
ruling, both implemented correctly, have a consequence the ruling's third clause
under-costed.

### What moved

B9(a) added `config/g1.py::LEMMA_NORMALISATION_ES` and B9(c) made G3 fail the build on a
target lexeme no form of which the pinned lemmatiser can reach. To satisfy (c),
`content/es/curriculum.yaml` had to declare the lemmas `es_core_news_md` actually
produces and drop the ones it merges (`ella`/`nosotros`/`ellos` → `él`, the reflexive
infinitives, `vacaciones` → `vacación`). Measured on `main`:

|                                         | frozen build                 | after B9(a)+(c)                  |
| --------------------------------------- | ---------------------------- | -------------------------------- |
| lexemes authored / assigned / deferred  | 990 / 928 / 63               | 952 / 945 / 7                    |
| `unreachable_lexemes`                   | 92 of 990                    | **0**                            |
| G4 slots / filled / gaps / gap_fraction | 1,584 / 1,094 / 490 / 0.3093 | 1,584 / 1,090 / **494** / 0.3119 |

A different ledger admits different corpus sentences, so the gap list is a different set
— not merely four larger.

### The blast radius, measured

```
18 authored slots no longer exist            363 rows
22 gap slots appeared with no author           0 rows
463 of 472 surviving slots moved digest    9,269 rows of 9,812
```

`coursekit build es` stopped at G5: `18 authored slot(s) are not in G4's gap list`. **Its
message misdiagnoses this case** — it blames the B1b per-unit-vs-global lesson keying,
which was a real bug once and is not this one. These slots were correctly keyed and then
ceased to exist. A message that names one cause for a check with two is worth fixing when
someone is next in that file.

### What the re-key fixed, and what it did not

B9's last clause — _"Re-key only rows whose `ledger_digest` changes"_ — is the sanctioned
remedy and it is now a script,
`tools/coursekit/scripts/rekey_authored_candidates.py` (dry-run by default). After it,
G5 on the same tree:

```
read 9,449 · written 9,449 · rejected 3,646 · reject_rate 0.3859
stale_ledger 0 · out_of_vocabulary 283 · duplicate 2,965 · length 398 · new_lemma_budget 0
orphan_authored_slots []
494 gap slots · 465 filled
g5 failed: 22 slot(s) authored below the over-generation floor of 20
```

`stale_ledger` went 9,269 → 0, and 283 rows were caught by the **new** window instead —
by name, in the census, which is the axis doing its job rather than being bypassed. The
363 orphaned rows are in `content/es/candidates-orphaned/` with their reason, outside the
glob G5 reads, because INV-PACK-10 forbids patching a candidate into a window it was not
written for.

### The brief was regenerated too

`content/es/authoring/gap-brief.jsonl` is a derived snapshot and G5 never reads it, but it
is the authoring input, and a 490-slot brief beside a 494-slot gap list is a trap for
whoever takes this blocker. `coursekit gaps es` regenerated it: **494 slots, 9,880
candidates required, 26 verbless slots, ledger digest `e041abe57f6f0836`**. Checked
against the CI artefact `es-gap-brief-86f2430…` — same 494 slots, **0 rows differing**,
only `generated_at` and `g4_run_id` differ in the header. Two machines, two ingests, one
gap list.

### What is left, and it is authoring

**22 slots with no candidate at all** (20 each = 440 rows). The windows are not the B9
five-lemma trap — most are wide — which is why this is work rather than a decision:

| Slot                                                                | reserves          | known lemmas | concept                 |
| ------------------------------------------------------------------- | ----------------- | ------------ | ----------------------- |
| `u1/l3/s1`                                                          | `yo`              | 14           | subject_pronouns        |
| `u1/l3/s3`                                                          | `usted`           | 14           | subject_pronouns        |
| `u1/l3/s4 s5 s6 s7`                                                 | —                 | 14           | subject_pronouns        |
| `u4/l24/s6`                                                         | `suelo`           | 127          | definite_articles       |
| `u16/l96/s6`                                                        | `mediodía`        | 521          | time_expressions        |
| `u17/l102/s6`                                                       | —                 | 530+         | time_expressions        |
| `u21/l121/s8`                                                       | `peinar`          | 658          | reflexive_daily_routine |
| `u23/l131/s6`                                                       | `molestia`        | 712          | formal_informal_address |
| `u23/l132/s7`, `u23/l134/s6`                                        | —                 | 712+         | formal_informal_address |
| `u25/l145/s4`                                                       | `ojo`             | 787          | estar_gerund            |
| `u27/l154/s4 s5 s6`, `u27/l156/s3`, `u27/l157/s5 s6`, `u27/l158/s7` | `doble` … `total` | 834–855      | comparatives_basic      |
| `u29/l168/s6`                                                       | `cortado`         | 906          | yes_no_questions        |

**7 slots that have 20+ candidates and no survivor**, which is a different job — fresh
candidates against the new window, not a re-key:

```
u1/l2/s2   20 rows: out_of_vocabulary 3,  duplicate 17
u1/l2/s4   20 rows: out_of_vocabulary 4,  duplicate 16
u1/l2/s6   22 rows: out_of_vocabulary 7,  duplicate 15
u1/l2/s7   20 rows: out_of_vocabulary 4,  duplicate 16
u17/l101/s8  20 rows: out_of_vocabulary 20
u25/l143/s8  20 rows: out_of_vocabulary 20
u25/l144/s8  20 rows: out_of_vocabulary 20
```

The four `u1/l2` slots are duplicate-starved (the unit's window admits few enough strings
that the earlier slots consume them); the other three are wholly out of vocabulary under
the new ledger and need rewriting, not re-keying.

### And one contradiction inside the new gap list

**`u1/l3/s3` is reserved to teach the lemma `usted`** (`content/es/curriculum.yaml:420`),
in a course whose register is `tu` (`config/g7.py::DEFAULT_REGISTER_BY_SLOT['binary_t_v']`),
where V6 treats an `usted` marker in an accepted answer as a **blocking** finding — the
rule 218 rows were rewritten for at the P2 fix round (B10). So no candidate that teaches
that slot's reserved lemma can pass V6, and no candidate that passes V6 can teach it. It
is not authorable as it stands. Whoever takes B19 has to either scope V6's rule to
exclude the slot that introduces the pronoun, or drop `usted` from the course's target
lexemes and teach the form inside `formal_informal_address` (u23) as a grammar concept,
which is the shape Q2 option C already allows.

### The question for the founder

Not "may we re-key" — B9 already said yes, and it is done. Two things are left, and only
the second needs a decision:

1. **Who authors the 29 slots.** 440 candidates for the 22 empty ones and fresh texts for
   the 7 starved ones. Ordinary authoring-lane work: 21 of the 22 windows are wide (127 to
   906 known lemmas), not the five-lemma trap B9 was about. Not done here because
   authoring 440 candidates inside an integration pass, unreviewed, is what produced the
   starved-slot defect at the last one.
2. **Does `usted` stay a target lexeme?** The two ways out are above — scope V6's rule to
   exempt the slot that introduces the pronoun, or drop `usted` from the target lexemes
   and teach the form as a grammar concept inside `formal_informal_address` (u23), which
   Q2 option C already allows. The second costs one line of `curriculum.yaml` and moves
   every `ledger_digest` in unit 1 again; the first costs a V6 exemption that a reviewer
   would have to be told about. Neither is taken here.

A third thing is worth naming but is not a decision: **G5's orphan message names one of
its two causes** ("G4 emits a GLOBAL lesson index …"), which is a real bug once and not
this one. Whoever is next in `stages/g5_gapfill.py` should make it say "the slot is not in
this build's gap list" and offer the keying explanation as one possibility.

---

## B20 — `ci.yml` intermittently fails with 1,316 of 1,316 tests passing — OPEN, measured

`Error: [vitest-worker]: Timeout calling "onTaskUpdate"`, with
`Test Files 114 passed | 1 skipped`, `Tests 1316 passed | 6 skipped`, on a 227-second
wall / 604-second test-time run. It is the reporter's RPC to the worker timing out, not a
test.

`docs/P2-REPORT-round2.md` saw it once, re-ran the job, got green, and wrote it down as a
flake. **This round it failed on both attempts of the same sha** — `86f2430` attempt 1 and
attempt 2 — and then **passed first time on `859f3fb`**, a tree that differs from it by
content, one script and documentation and by no TypeScript at all. So it is a flake, and
the thing worth recording is its hit rate rather than its existence: two consecutive
failures on one sha and a clean pass on the next, over an identical suite.

Every attempt, in order:

| sha       | attempt | run                                                                    | result                              |
| --------- | ------- | ---------------------------------------------------------------------- | ----------------------------------- |
| `86f2430` | 1       | <https://github.com/Blueturboguy07/freelingo/actions/runs/34704497896> | FAILURE, 1,316/1,316 pass, 2 errors |
| `86f2430` | 2       | same run, `gh run rerun --failed`                                      | FAILURE, 1,316/1,316 pass, 1 error  |
| `859f3fb` | 1       | <https://github.com/Blueturboguy07/freelingo/actions/runs/34705920961> | **SUCCESS**, 1,316/1,316 pass       |

A re-run on the same sha is therefore not a reliable way to clear it, which is what the
"re-run once before calling it a regression" rule assumes.

Not fixed here on purpose. The suite is 27 s wall on this Mac and 227 s on the runner, so
there is no way to reproduce the timing locally, and a change pushed as a fix that cannot
be measured is the "fixed it five times without fixing it" failure this project has
already paid for once. The levers, for whoever takes it: a quieter CI reporter (the
default reporter's per-task RPC is what times out), `fileParallelism` so no single worker
holds a 15–25-second property test while the reporter waits, or splitting
`packages/core/src/day/recovery.test.ts` (four properties, 25 s together) out of the main
run. **Not** `PROPERTY_RUNS`: the floor is a gate on purpose
(`docs/ci.md` §The property floor).
