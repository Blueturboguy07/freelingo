# P2 blockers

What is stopping the Spanish pack, in one place, with the evidence each claim rests on.
`docs/P2-REPORT.md` is the phase report at sha 78cfae3 and stays as written; this file is
the live list, updated by the P2 fix round.

Three of these (**B3**, **B5**, **B6**) are **founder decisions**. They are written here
with the one question each needs answered and nothing else: they are not answered in this
file, and an agent answering them would be inventing the decision rather than recording
it.

| Id      | What                                                                                     | Kind                     | Status                            |
| ------- | ---------------------------------------------------------------------------------------- | ------------------------ | --------------------------------- |
| **B1**  | 18,200 candidate sentences do not exist                                                  | authoring                | **OPEN — the phase blocker**      |
| **B1a** | every G4 gap slot carries empty `known_lemmas`/`new_lemmas`, so no candidate can pass G5 | code                     | **OPEN — measured 920/920**       |
| **B1b** | the committed candidates are keyed in a lesson numbering G4 does not use                 | code + decision          | **OPEN — found 2026-09-12**       |
| **B2**  | `pack-bake.yml` could not succeed on any dispatch                                        | code                     | **RESOLVED 2026-09-12** — deleted |
| **B3**  | the wrong-item rate is `None`, not 2%                                                    | **founder decision**     | **OPEN**                          |
| **B4**  | `coursekit sample es --n 300` is not a spelling the CLI has                              | docs                     | **RESOLVED 2026-09-12**           |
| **B5**  | S152 has a validator, F3, and no row in the product map                                  | **founder decision**     | **OPEN**                          |
| **B6**  | Azure is dead; Spanish bakes on Kokoro                                                   | **founder decision**     | **OPEN**                          |
| **B7**  | `mutation.yml` has never produced a score                                                | pre-existing, non-gating | **OPEN, measured**                |
| **B8**  | `build-es` names no language engine, so V8 will block even once B1 is fixed              | code (CI)                | **OPEN — found 2026-09-12**       |

---

## B1 — 18,200 candidates do not exist (the phase blocker)

Not this task's lane; recorded here because everything below waits on it.

G4 emits **918 gap slots**; `content/es/candidates.jsonl` is **160 rows** covering **8**
of them (8 × exactly 20), which is **0.9%**. The course needs 918 × 20 = **18,360**.
`coursekit build es` therefore exits 4 at G5, `validate-es` skips on `needs:`, and the
whole downstream half of P2 — `coursekit validate es`, V1–V4 at 100%, V5–V12, the V8
engine record, the licence sweep, the 120 MB bank on real bytes, `coursekit sample es`,
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
brief have to move with it. Neither file is in this lane.

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

## B3 — the wrong-item rate is `None`, not 2% — FOUNDER DECISION

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

**The question:** _Do you commission the paid native Spanish reviewer now (≈$300–800,
300 items, turnaround unknown), or does P3 start on a pack whose wrong-item rate is
published as `None` with the PROVISIONAL string and re-gated later?_

Note what rides on the answer: the plan's §Risks item 7 says a Spanish defect rate above
2% discovered late would invalidate P3–P6, which is exactly why the sample was scheduled
at the end of P2 rather than at P8.

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

## B5 — S152 has a validator and no screen — FOUNDER DECISION

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

**The question:** _Does S152 get a real row in `deep/00-PRODUCT-MAP.md` — states, copy
slots and its two entry points (S045, S137) — before P4 builds it; and if so, who writes
that row, given the corpus is research and not a repo file?_

Until it is answered, INV-PACK-17's **pack half** is enforced and its **screen half**
(the `E` in its `C, E` kind column) has nowhere to be tested.

---

## B6 — Azure is dead; Spanish bakes on Kokoro — FOUNDER DECISION

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

**The question:** _Do you accept Kokoro as the voice engine for es — and by extension
fr/ja — with `locale: es-ES` demoted to a course claim checked only by the reviewer
sample, and two of four cast roles as blends; or do you restore Azure and supply
credentials?_

---

## B7 — `mutation.yml` has never produced a score

Pre-existing, **non-gating**, and not caused by P2. Recorded here with the measurement so
that no report has to quote a number that did not print.

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

**What the real fix is, and why it is not in this lane.** The timing-out property is
`packages/core/src/data/import.test.ts:277`,
`it('[INV-DAT-04] the classifier puts history before the gap, for any generated overlap')`
— a fast-check property over generated import archives, in `packages/core/src/data/`. The
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
