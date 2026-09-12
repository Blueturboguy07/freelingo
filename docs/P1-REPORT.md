# P1 — engine: what is actually green

Repository: <https://github.com/Blueturboguy07/freelingo> (public, AGPL code / CC BY-NC-SA packs)

Written at the P1 founder checkpoint (plan §The build workflow, step 6), in the shape of
`docs/P0-REPORT.md`. Every row says what was run, where the evidence is, and where it is
missing. **A gate with no run behind it is listed as NOT PROVEN, not as done.**

## What this report was measured against

P1 is nine parallel tasks. At the time of writing, `origin/main` is still at P0 + the P1
deps commit (`7914980`) and none of the eight module lanes has been merged, so the numbers
below come from a **local integration**: a scratch worktree at `origin/main` with all nine
P1 branches merged in, at these shas.

| Branch                         | sha       |
| ------------------------------ | --------- |
| `p1/foundation-economy-schema` | `5e8913e` |
| `p1/day-freeze-recovery`       | `d4ace03` |
| `p1/session-runtime`           | `b186efb` |
| `p1/grading`                   | `df12cbe` |
| `p1/scheduler`                 | `1ea9096` |
| `p1/path-and-ceremony`         | `ff402e3` |
| `p1/packs-data-security`       | `5b423b5` |
| `p1/art-and-sound`             | `537e24a` |
| `p1/journey-and-gate`          | `d40b35b` |

All nine merged with **zero conflicts**. Every number below is from that tree, run locally
on this Mac. **There is no CI run behind any of it**, because nothing has been pushed: the
plan reserves pushing for the integrate task. Where P0's report could cite a CI job, this
one cannot, and that is the single largest caveat on the page.

**Two things about that last sha.** It is the code commit; the only commit after it on the
branch is this report, which changes no `.ts`. And it is a **second** measurement: the
first version of this page was measured at `292ced9`, a refuter rejected it, and every
number here was re-run on a tree rebuilt from these nine shas after the fixes. What the
refuter found, and what it cost, is in _Refuted_ below.

**This branch's own worktree is red, and that is expected.** `p1/journey-and-gate` is cut
from `origin/main`, where none of the eight module lanes exists; `pnpm test` there is
`Test Files 3 failed | 14 passed (17)`, `Tests 14 failed | 129 passed (143)`, because
`bind.ts` can resolve almost nothing and the roster and corpus gates have no modules to
find. A gate branch can only be measured on the tree it gates, which is why every figure on
this page names the merged tree.

That red run is also the proof for one of this round's fixes. Before it, the same tree
failed **11** tests; the three that were added to the failure list are `[INV-DAY-09]`,
`[INV-REC-01]` and _"the engine agrees with an independent reference all thirty days"_ —
the three that used to PASS over the empty ledger a journey with unbound ports returns.
They now fail where they should, and pass 14/14 on the merged tree.

## The P1 gate, clause by clause

The plan's P1 gate is: _"Every id in §1–§10, §13, §14 (engine parts), SEC-01/02 green;
committed falsifier inputs per invariant; Stryker score ≥ threshold nightly."_

| Gate clause                                              | Status                                                           | Evidence                                                                                                                                                                                                                                                                                    |
| -------------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Every id in the P1 families has an owning test           | **GREEN, with 13 declared deferrals**                            | `pnpm test:coverage-map`: 217 owned, 217 with an owning test. The 13 deferrals are listed below with reasons.                                                                                                                                                                               |
| The union of the ownership files **is** the phase roster | **RED — one duplicate claim**                                    | `phase-roster.test.ts`. `INV-CER-01` is claimed by both `docs/invariants-owned.json` and `docs/owned/ceremony.json`. See _Blockers_.                                                                                                                                                        |
| Committed falsifier inputs per invariant                 | **RED — 42 of 217 owned ids have none**                          | `pnpm test:falsify`: 176 committed inputs covering 175 ids across 9 module directories; 42 owned ids have no input. See _The falsifier corpus_.                                                                                                                                             |
| Every committed falsifier input is **executed**          | **GREEN for consumption; zero inputs are executed BY THIS GATE** | All 9 `__falsifiers__` directories are read by a test **in their own module** whose names carry the `test:falsify` filter term (consumer counts 1–12, not a constant). Execution is the lanes' runners': no fixture uses the `{check, cases}` contract. See _Refuted_.                      |
| Headless 30-day two-course four-zone journey             | **GREEN**                                                        | `journey.test.ts`, 14/14 against the merged tree; every port bound, nothing substituted. See _The journey_.                                                                                                                                                                                 |
| Stryker score ≥ threshold nightly                        | **NOT MET — no whole-engine score exists**                       | `packages/core/src/day/` alone scores **71.28%** over 968 mutants. The engine is **9,802** mutants in 115 files; 8,834 of them have never been run. The nightly therefore REPORTS (`continue-on-error`) rather than gating on a threshold derived from a tenth of the tree; see _Mutation_. |

## The journey

`packages/core/src/journey/` — the P4 gate's _"headless 30-day journey across two courses
and four zones"_, brought forward because P1 is where the engine that has to survive it is
written. One learner, thirty simulated local days, two installed courses, four matrix
zones plus one declared stopover, driven through the real modules.

**It never substitutes.** `bind.ts` resolves each capability from the lanes' own exports
and reports what it cannot find; there is no fallback implementation anywhere in the
directory, because a green journey computed by the driver's own arithmetic proves nothing.
A port that does not resolve becomes a named line in `notProven`, not a quiet pass.

Result on the merged tree: **14/14, with `notProven`, `refutations` and
`replayViolations` all empty**, and every port bound to a real module (`bind.missing` is
empty). `script.test.ts` 25/25, `driver-detectors.test.ts` 13/13.

### The end-state ledger it asserts

The whole point of the exercise, in one table — thirty days of one learner, computed by the
real engine and cross-checked:

|                                  |                                                                                                                                                                                              |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Lifetime XP                      | **280** = 230 (es) + 50 (fr), the two counters summing exactly                                                                                                                               |
| Sessions committed               | **27**, one row each, none committed twice                                                                                                                                                   |
| Streak                           | **9** after the closing rollover (`account.streakAtEnd`); the per-day curve, snapshotted before each day's close, is `0,1,2,2,3,4,5,6,7,8,9,10,10,10,11,11,12,13,14,15,15,0,1,2,3,4,5,6,7,8` |
| Dispositions over 31 civil dates | 24 `completed`, 3 `frozen`, 2 `recovered`, 1 `unlived`, 1 `missed`                                                                                                                           |
| Freezes                          | 3 granted (2 owned from day 1, 1 bought), 3 consumed                                                                                                                                         |
| Goal chests                      | 3 days crossed the goal in force on that day                                                                                                                                                 |
| Streak Repairs                   | 1, in `2026-10`, restoring 15 and repainting `2026-10-10`                                                                                                                                    |
| Months settled                   | `2026-09`, `2026-10`, once each                                                                                                                                                              |
| Unlived                          | `2026-10-05`, exactly one date, never `missed`                                                                                                                                               |

The single `missed` date is `2026-10-11`: the day the monthly repair fired, which leaves
today unsatisfied by design. The two `recovered` dates are the ones the challenge and the
repair repainted. Nothing in that ledger is a coincidence and all of it falls out of the
trace.

| What the trace exercised                                                                              | How it is asserted                                                                                                                                     |
| ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Two courses installed, both live to day 29                                                            | `courses` ledger; both carry sessions and XP                                                                                                           |
| 30 local days across `Asia/Tokyo`, `America/Los_Angeles`, `Pacific/Kiritimati`, `Australia/Lord_Howe` | every day's zone is resolved through the engine and cross-checked against the local date the script declares                                           |
| Rollover, every day, **replayed**                                                                     | `rolloverTo` is called twice per day with the same arguments; the second call must decide nothing (INV-DAY-09, INV-FRZ-05)                             |
| The ceremony commit, **replayed**                                                                     | every session is committed twice with a later wall clock; the two rows must be identical (INV-CER-01, INV-DAY-15)                                      |
| A freeze walk, three covered days and two uncovered                                                   | freezes consumed ≤ granted, and a grant that applies nothing asks for no ceremony screen (INV-FRZ-01, INV-FRZ-06)                                      |
| A civil date deleted by travel                                                                        | `2026-10-05` is `unlived`, not `missed` (INV-DAY-03)                                                                                                   |
| A recovery challenge, 3 lessons inside the 2-day window                                               | the offer must be armed, and the third lesson must restore (INV-REC-02/04/05/06)                                                                       |
| A monthly Streak Repair, then a second attempt in the same month                                      | the second must be declined **because the month is spent**, not because there is nothing to repair (INV-REC-01)                                        |
| A goal change mid-day                                                                                 | the goal in force on a day is the lower of the two (EC-ECO-01)                                                                                         |
| A course switch with a parked session                                                                 | the parked row survives the switch and a zone change, and restores byte-identically (INV-SESS-01/07)                                                   |
| A boost that expires past `boostGraceSeconds`                                                         | the commit applies ×1 and carries the explanation exactly when the learner is paid less than promised (EC-ECO-02, INV-ECO-30)                          |
| A kill at a pseudo-random instant                                                                     | checkpoint → serialise → deserialise → serialise must round-trip (INV-SESS-01/06)                                                                      |
| A pack major bump with quarantined rows                                                               | three items vanish; the retired count matches and **no row is dropped** (INV-PACK-02)                                                                  |
| Every answered exercise applied to the scheduler, then applied again                                  | the replay writes no second attempt row (INV-SCH-03)                                                                                                   |
| Export → wipe → import                                                                                | lifetime XP and the streak survive; `unlivedDays` and `restampedDays` are empty; `writtenFields` never intersects `ECONOMY_CONFIG_FIELDS` (INV-DAT-04) |

### The journey's detectors were shown to fire

`journey.test.ts` asserts three empty lists, and a driver that can never fill them passes
forever. `driver-detectors.test.ts` runs the whole trace against a reference engine and
then against nine engines each breaking exactly one rule. **All nine detectors fire**: a
rollover that never advances its marker (EC-FRZ-14's double-decrement), a commit not keyed
by `session_id`, a streak that disagrees with its own disposition ledger, an unbounded
rollover deferral, a boost that never lapses, a second repair in one month, a major bump
that retires nothing, an import that loses lifetime XP, and a lane that moved a signature.
Two more prove that a missing lane is reported as NOT PROVEN naming the task that owes it,
and that a tree with no day lane runs nothing and says so.

The reference engine in that file is evidence about the **driver** only. Nothing in it is
reachable from `journey.test.ts`.

### Four defects the journey found in itself, and one it found in its own cross-check

Worth recording, because they are the reason to believe the rest:

1. **The trace claimed a date-line skip that cannot happen.** The first version flew Los
   Angeles → Kiritimati and asserted a civil date was deleted. Measured against the tz
   database: that jump is 21 hours and the local date advances by exactly one, whenever the
   flight departs. Deleting a whole date needs **more than 24 hours**. The trace now stops
   at `Pacific/Midway` (−11) and crosses to Kiritimati (+14) at a declared instant,
   `2026-10-05T10:00:00Z`, where Midway reads `2026-10-04` and Kiritimati reads
   `2026-10-06`. `script.test.ts` now classifies every flight against `Intl` rather than
   trusting the header.
2. **Every day's disposition was read one rollover too early.** `rolloverTo` decides
   everything strictly _before_ today and never today itself, so the snapshot recorded
   thirty nulls and the "every day is decided" assertion was vacuous. Filled in
   retrospectively after the closing rollover.
3. **The day-22 "second repair is refused" assertion passed for the wrong reason.** Without
   a live break it would be refused as `no-break`, which says nothing about the monthly
   cap. The script now declares `expectDeclinedBecause: 'month-already-repaired'`.
4. **The trace broke a streak nobody had declared.** Dumping the end-state ledger showed
   the learner finishing thirty days on a streak of 3. Day 26 spent the whole day exporting
   and importing and took no lesson, so `2026-10-16` rolled over `missed` — a third
   uncovered day in a trace whose header says there are two. The learner now practises
   after the import, and `script.test.ts` carries the assertion that would have caught it:
   every day either commits a session, is declared `idle`, or states in its own detail that
   it ends unsatisfied on purpose. Exactly one day is allowed to say that.
5. **The journey's first run against the real engine refuted its own cross-check.** From
   day 15 the engine reported streak 11 where the independent reference said 12. The engine
   is right: `dispositions.ts` rules `recovered` as _"Preserves, never increments"_, and
   INV-REC-02 restores `previous_streak` and marks **today** satisfied, so the restore adds
   nothing and today's own lesson adds the one day INV-REC-07 allows. The reference counted
   a restored day as practised and was corrected. **No defect in the day lane.**

## Invariant coverage

`pnpm test:coverage-map` on the merged tree: **424** ids in the registry, **217** owned,
**217** with an owning test whose name carries the id in brackets, 207 pending for later
phases.

That 217 is the plan's P1 row: 211 ids this phase owns plus P0's six.

| Family   | Owned |     | Family   | Owned |
| -------- | ----- | --- | -------- | ----- |
| INV-SESS | 27    |     | INV-PATH | 22    |
| INV-GRD  | 28    |     | INV-PER  | 9     |
| INV-ECO  | 32    |     | INV-PACK | 10    |
| INV-DAY  | 17    |     | INV-DAT  | 8     |
| INV-CER  | 15    |     | INV-SCH  | 12    |
| INV-COM  | 11    |     | INV-MIS  | 8     |
| INV-REC  | 7     |     | INV-FRZ  | 6     |
| INV-SEC  | 2     |     | INV-PLAT | 2     |
| INV-AUD  | 1     |     |          |       |

Ownership is the union of `docs/invariants-owned.json` and eleven `docs/owned/<task>.json`
files. `phase-roster.test.ts` derives the roster from `docs/invariants.md` — the P1
invariant families plus `INV-SEC-01/02` — and compares it with that union **both ways**, so
an id nobody claimed is a failure and not an absence. A hand-written list of 217 ids would
have gone stale the first time the registry moved and nothing would have said so.

### The 13 ids P1 does not own, and why

Every one is a screen, native or device check with no engine part to write at P1. Full
reasons are in `docs/owned/journey.json`; the short form:

| id          | Kind                                                                 | Moves to                        |
| ----------- | -------------------------------------------------------------------- | ------------------------------- |
| INV-CER-12  | E — a back press on each ceremony screen                             | P4 (S067–S090)                  |
| INV-CER-16  | S — every Score-chain CTA resolves to the `macaw` token              | P3 token conformance            |
| INV-COM-05  | S — a colour transition never rewinds a width tween                  | P3                              |
| INV-DAT-06  | P, E — no notification or widget entry derives from pre-import state | P4 / P5                         |
| INV-DAT-08  | P, E — import never opens a `content://` URI directly                | P5, on a device                 |
| INV-ECO-31  | P, S — equipping a cosmetic changes only `MascotRenderer` output     | P3 art, P5 widget               |
| INV-GRD-09  | U, P — production inputs declare autocorrect and spellcheck off      | P3 component gate               |
| INV-PATH-10 | S, E — the canvas after a section-complete return                    | P3                              |
| INV-PATH-11 | S — exactly one pinned header at every scroll offset                 | P3                              |
| INV-PATH-12 | P, E — the guidebook route id equals the pinned header's unit id     | P3                              |
| INV-PATH-24 | U, C — every pack-declarable node type has a `PathNode` variant      | P3 (art is its entry criterion) |
| INV-PER-09  | P, E — zero files remain under the recording directory               | P5 (ASR)                        |
| INV-PER-10  | D — the on-device backup manifest                                    | P5 checklist                    |

### The 11 §14 PACK/AUD engine parts P1 does own

The plan says "engine parts" and does not enumerate them, so each is written down in
`docs/owned/journey.json` with the reason it is engine and not a P2 pack gate:
`INV-AUD-01`, `INV-PACK-01`, `-02`, `-03`, `-04`, `-05`, `-18`, `-19`, `-27`, `-35`, `-56`.

## numRuns per property

The floor is `PROPERTY_RUNS = 10_000` in `packages/testkit/src/config.ts`, and
`property-gates.test.ts` fails if any `numRuns` anywhere in the tree is below it. Measured
on the merged tree: **218 property call sites, 0 below the floor**, declaring **2,180,000
cases** before the zone loops multiply them. (Four more live inside
`property-gates.test.ts` itself, one of them deliberately below the floor: they are the
fixtures that prove the gate goes red, and counting them would be counting the ruler.)

| Module               | Properties | Declared cases |
| -------------------- | ---------- | -------------- |
| `core/src/session`   | 39         | 390,000        |
| `core/src/grading`   | 38         | 380,000        |
| `core/src/path`      | 25         | 250,000        |
| `core/src/day`       | 24         | 240,000        |
| `core/src/ceremony`  | 21         | 210,000        |
| `core/src/packs`     | 20         | 200,000        |
| `core/src/data`      | 17         | 170,000        |
| `core/src/scheduler` | 16         | 160,000        |
| `core/src/economy`   | 7          | 70,000         |
| `core/src/security`  | 4          | 40,000         |
| `core/src/db`        | 2          | 20,000         |
| `core/src/streak`    | 2          | 20,000         |
| `packages/schema`    | 3          | 30,000         |
| **total**            | **218**    | **2,180,000**  |

A property that loops the four-zone matrix runs `PROPERTY_RUNS_PER_ZONE` **in each** zone,
so its real case count is four times the declared one. The table above is the declared
figure, which is the one `property-gates.test.ts` enforces.

**The journey itself runs no fast-check property.** A 30-day two-course trace cannot run
10,000 times in any budget anybody would accept, so the "kill at a random instant" the gate
asks for is pseudo-random and **seeded** (`DEFAULT_SEED`, xorshift32): one trace, fully
reproducible, and a failure quotes the seed rather than a shrunk counterexample. The
property-shaped coverage of the same modules lives in the lanes, in the table above.

## The falsifier corpus

`pnpm test:falsify` is `vitest run --project core -t falsifier`. It selects
`packages/core/src/journey/falsifier-corpus.test.ts` **and 56 other files**: measured on
the merged tree, the run is `Test Files 1 failed | 56 passed | 35 skipped (92)`,
`Tests 1 failed | 244 passed | 736 skipped (981)`, 2.94 s. (An earlier draft of this page
said this gate was "the only thing in the tree whose test names carry the script's filter
term". That was wrong by a factor of 57; 60 test files in the repo carry `falsifier` in a
test name.)

Measured on the merged tree:

|                                                             |                                                                                                   |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Committed `__falsifiers__/*.json`                           | **176**                                                                                           |
| Invariant ids they cover                                    | **175**                                                                                           |
| Module directories holding them                             | **9** (`ceremony`, `data`, `day`, `grading`, `packs`, `path`, `scheduler`, `security`, `session`) |
| Directories read by a selected test **in their own module** | **9 of 9**                                                                                        |
| Fixtures using the executable `{check, cases}` contract     | **0** — see the warning below                                                                     |
| Owned ids **without** a committed input                     | **42**                                                                                            |

The consumption figure is per directory, and the spread is the point — a check that
reports the same number everywhere is not checking anything (it did, once; see _Refuted_):

| Directory    | Readers in the module | Of those, selected by the filter |
| ------------ | --------------------- | -------------------------------- |
| `ceremony/`  | 7                     | 7                                |
| `data/`      | 1                     | 1                                |
| `day/`       | 5                     | 5                                |
| `grading/`   | 2                     | 1                                |
| `packs/`     | 1                     | 1                                |
| `path/`      | 12                    | 11                               |
| `scheduler/` | 2                     | 2                                |
| `security/`  | 1                     | 1                                |
| `session/`   | 1                     | 1                                |

**A warning this page owes the reader.** Zero of the 176 fixtures declare the optional
`{check: {module, export}, cases}` contract, so the gate's test _"every falsifier input
that offers the executable contract runs and agrees with its module"_ currently executes
**zero cases**. It is green because there is nothing to run. The contract's own failure
paths are exercised against fixtures in the self-test (a disagreeing module, a renamed
export, a module that will not import, an expected throw that did not happen), so the
executor is not untested — but it is unused, and the only thing standing between a
committed fixture and a JSON file nobody runs is the consumption check above. Moving the
lanes onto the contract is the P2 cleanup already listed under _Deferred_.

### What the gate checks, and what it deliberately does not

Eight lanes wrote their corpora in parallel and chose **four different payload shapes**:
`{id, falsifier, source, input, mustNotBe, usedBy}` in `day/`, `{id, case, kind, input,
expect}` in `session/`, `{invariant, why, shape, expect}` in `path/`, `{invariant, what,
measured, …}` in `scheduler/`. A gate that rejected all four in favour of a fifth would be
a format war, not a check. So the payload is not prescribed. What is:

- **identity** — the file parses, names its own invariant, and that id agrees with the file
  name (case-insensitively; one lane filed twelve otherwise-correct fixtures as
  `inv-sch-01.json`, and capitalisation is not an invariant);
- **a reason** — a sentence saying what the input falsifies, under any of the four keys the
  lanes actually used;
- **consumption** — the directory is read by a test **in the module that owns it**
  (`day/` for `day/__falsifiers__`, never the whole package), **and** that test has a name
  carrying the filter term. Without the second half the script selects nothing and exits
  green while 176 committed inputs are executed only by accident under `pnpm test`. That
  is the failure `docs/ci.md` names, one level up. This gate's own test file is excluded
  from counting as a reader, because it mentions the directory name and matches the filter;
- **execution here** for any fixture that opts into the `{check: {module, export}, cases}`
  contract: imported, called, compared structurally. **No lane has used it yet** — each
  kept its own runner — so this clause runs zero cases today and the consumption check is
  what holds the corpus.

### The 42 owned ids with no committed input

This is the gate's one red clause that is a real gap rather than a bookkeeping fix.

- **36 belong to `p1-foundation-economy-schema`** — the 32 `INV-ECO` ids it owns, plus
  `INV-PER-03`, `INV-PER-07`, `INV-PER-11` and `INV-PACK-35`. That lane committed **no
  `__falsifiers__` directory at all**; it is the only one of the eight that did not. Its
  tests are there and green; its falsifying inputs are not on disk.
- **1 belongs to `p1-packs-data-security`** — `INV-DAT-03`. The `data/` corpus has 12
  files and not this one.
- **5 are P0's** — `INV-CER-01`, `INV-DAY-01`, `INV-PER-06`, `INV-PLAT-01`, `INV-PLAT-02`.
  P0 shipped their tests and no corpus. The last two are build gates, and a "falsifying
  input" for _"Expo packages are installed only via `npx expo install`"_ is a repo state,
  not a JSON document. The gate was left strict rather than given an exemption nobody
  asked for; it is recorded here instead.

## Mutation

`stryker.config.json` now mutates every engine module under `packages/core/src` except
tests, barrels and `journey/**` (the gate's own harness, which is test infrastructure that
happens to live in `.ts` files). That is **115 files and 9,802 mutants**.

**The plan's gate clause is not met, and this job does not pretend otherwise.**
`.github/workflows/mutation.yml` keeps `continue-on-error: true`: it REPORTS a score, it
does not gate on one. `thresholds.break: 70` is derived from `packages/core/src/day/`
alone, which measured 71.28% — 1.3 points of headroom, on a tenth of the engine, with
`rollover.ts` at 61.85% and two files at 44%. Turning that into a break threshold would
make the first nightly a coin flip on 8,834 mutants nobody has run, and a red build whose
number nobody has seen teaches people to lower the threshold. Both the config's
`thresholds_comment` and the workflow header say this in full; the commit that records a
whole-engine score is the one that removes `continue-on-error`.

Two things the workflow does do. It **counts the files in scope before running** — a
`mutate` glob that matches nothing scores 100% and goes green — and it derives that count
from `stryker.config.json`'s own globs rather than from a `find` command holding a second
copy of them, floors it at 100 against a real 115 (the floor was `-ge 3`, which a
regression dropping 112 of 115 files would have passed), and fails if the `!` globs stop
excluding anything or if a test file lands inside the scope. And it writes the score, the
threshold and the mutant states into the run summary, because _"the mutation job is
green"_ is not a measurement.

`actionlint .github/workflows/mutation.yml` exits 0.

### The recorded score

|                                                             |                                                                                                                  |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Threshold (`thresholds.break`), derived from `day/` only    | **70%** — **not gating**; the nightly reports                                                                    |
| **`packages/core/src/day/` on the merged tree, 2026-09-11** | **71.28%** — 655 killed, 35 timeout, 218 survived, 60 no-coverage, over **968 mutants in 13 files**, 12 min 19 s |
| P0 baseline, 2026-09-11, `day` + `ceremony` + `db`          | 79.07% — 101 killed, 1 timeout, 21 survived, 6 no-coverage, over 129 mutants                                     |
| The whole merged engine                                     | **NOT PROVEN** — 115 files, **9,802 mutants**; see below                                                         |

Per file, the module the journey exercises hardest:

| File              | Score      | Killed  | Timeout | Survived | No coverage |
| ----------------- | ---------- | ------- | ------- | -------- | ----------- |
| `streak.ts`       | 92.31%     | 11      | 1       | 1        | 0           |
| `dispositions.ts` | 87.04%     | 32      | 15      | 7        | 0           |
| `freeze.ts`       | 85.57%     | 83      | 0       | 10       | 4           |
| `unlived.ts`      | 84.62%     | 10      | 1       | 1        | 1           |
| `civil.ts`        | 82.05%     | 59      | 5       | 11       | 3           |
| `session.ts`      | 74.70%     | 62      | 0       | 19       | 2           |
| `predicates.ts`   | 73.96%     | 71      | 0       | 15       | 10          |
| `recovery.ts`     | 68.00%     | 119     | 0       | 41       | 15          |
| `zone.ts`         | 66.67%     | 36      | 10      | 20       | 3           |
| `totals.ts`       | 64.29%     | 9       | 0       | 5        | 0           |
| `rollover.ts`     | 61.85%     | 151     | 3       | 75       | 20          |
| `config.ts`       | 44.44%     | 4       | 0       | 5        | 0           |
| `state.ts`        | 44.44%     | 8       | 0       | 8        | 2           |
| **all**           | **71.28%** | **655** | **35**  | **218**  | **60**      |

`rollover.ts` at 61.85% with 75 survivors is the number to look at: it is the most
consequential file in the day engine and the one the journey replays thirty times, and a
quarter of its mutants live through the suite. `config.ts` and `state.ts` at 44% are
constants and record constructors, where most mutants are equivalent — the low score there
says less.

**Why the whole engine is NOT PROVEN rather than scored.** Three measured obstacles, in
the order they were hit:

1. **Stryker's regex mutator emits an invalid escape.** `weapon-regex` negates predefined
   classes (`\d`→`\D`, `\s`→`\S`) and applies the same rule to `\v`, producing `\V`, which
   is an invalid escape under the `u` flag. `packages/core/src/security/sanitise.ts:98`
   carries `/[\t\n\r\f\v]+/gu`, and because every mutant is instrumented inline, rollup
   fails to parse the whole file: the initial dry run died with `SyntaxError: Invalid
regular expression: /[\t\n\r\f\V]+/gu: Invalid escape` and **no score was produced at
   all**. The `Regex` mutator is now excluded, with that measurement in the config.
2. **Stryker refuses a tree whose initial test run is red.** The two cross-lane economy
   failures below abort it before any mutant runs. They had to be skipped _in the local
   rehearsal tree only_ for any figure to exist.
3. **The dry run alone blows the 5-minute default, and a cold full run is hours.** The
   suite is 27 s on its own, but the dry run collects per-test coverage over 1,125 tests,
   218 of which are fast-check properties at 10,000 cases. Measured: the full-engine dry
   run was still going at 5:03 and Stryker aborted with `Initial test run timed out!`.
   `dryRunTimeoutMinutes` is now 30. Even past that, 9,802 mutants over a suite whose
   day-module _subset_ takes 12 minutes for 968 is a multi-hour job — which is why
   `incremental` mode is on and the nightly caches its report between runs, and why the
   job's `timeout-minutes` is 300 rather than 90.

The scoped run above is therefore a **complete, unmodified measurement of one module**,
not an extrapolation — and it is not evidence about the other 8,834 mutants. The
whole-engine figure is the nightly's to produce on a tree whose suite is green, and until
it exists this gate clause reads **NOT MET**, not "green".

## Blockers — what stops this phase's gate going green

Three failures on the merged tree. **One of them was this task's own** and is fixed; the
other two belong to other lanes and are one line each.

1. **`INV-CER-01` is claimed twice** — the ceremony lane, or the P0 baseline.
   `docs/invariants-owned.json` (the P0 baseline) and `docs/owned/ceremony.json` both list
   it, and `pnpm test:coverage-map` fails on a duplicate claim: _"ownership: INV-CER-01 is
   claimed by 2 files"_. The ceremony lane owns the invariant and its tests now, so the P0
   baseline is the right place to drop it. The same collision fails `phase-roster.test.ts`.
2. **`[INV-ECO-24]` trips on the day lane** — a refutation for `p1-day-freeze-recovery`,
   not a defect in the gate. The economy lane asserts that no shipped string says _"Super,
   Max, No ads, unlimited hearts, refill or a price"_;
   `packages/core/src/day/freeze.ts` carries the freeze channel name `timed_refill`, and
   the gate's `refill` pattern matches it. The gate is right to look; either its pattern
   excludes the identifier, or the channel gets a different name. Measured message:
   `expected [ Array(1) ] to deeply equal []`.
3. **`[INV-ECO-01] was this task's own offender, now fixed.** An earlier draft of this
page blamed the day lane for it. It was not: the second copy of the goal ladder lived in
a string literal in `packages/core/src/journey/driver.ts`—`ctx.cannot('economy', 'the named daily-goal tiers (10/20/30/50 XP)')` — and the gate
   strips comments but keeps literals, correctly. The literal no longer carries the ladder
   and the gate passes. Misattributing a self-inflicted failure to another lane is the
   worst failure mode a phase-gate report has, which is why it is written out here rather
   than quietly deleted.

(1) and (2) are the class the plan's §Safeguards calls out — _"PRs that break main merge
cleanly"_ — and they are only visible when all eight lanes are in one tree, which is what
this task exists to do. (3) is the class a refuter catches and a self-report does not.

## Refuted — what a reviewer found in this gate, and what it cost

The first version of this page was rejected. The findings are recorded here because a
phase gate that hides its own defect list is the thing it exists to prevent.

### The falsifier gate's load-bearing half was measuring nothing

`consumersFor` computed the scan root as `absolute.slice(0, absolute.indexOf('/src') + 4)`,
which for `packages/core/src/day/__falsifiers__` is `packages/core/src/` — **the whole
package**. It then counted any test file under it whose source mentions `__falsifiers__`,
and `falsifier-corpus.test.ts` — this gate's own test, which is about those directories and
whose test names carry the filter term — is such a file. So every corpus directory in
`packages/core` was reported read and selectable, by the checker itself.

The refuter proved it rather than argued it: a fixture dropped into
`packages/core/src/db/__falsifiers__`, a directory no test in the repo reads, reported
`consumers: 33 | selectable: 31` — identical to every real corpus, which is the signature
of a check that does not discriminate. _"9 of 9 directories read"_ was a measurement of
nothing, and with the executable contract unused (zero fixtures), the whole gate reduced to
a filename census: a JSON file with an id and a twelve-character sentence satisfied it.

Fixed by scoping the scan to the module that owns the corpus and excluding this gate's own
file by name. Evidence that the fix discriminates, all on the merged tree:

- the per-directory spread in _The falsifier corpus_ above: 1, 1, 1, 1, 2, 2, 5, 7, 12
  readers, not one constant;
- the refuter's own probe repeated after the fix — `packages/core/src/db/__falsifiers__`
  with one fixture and no reader now **fails** the gate:
  `nothing in the tree reads these directories, so the inputs in them are never executed.
A fixture no test loads is a JSON file, not a falsifier.: expected [ Array(1) ] to deeply
equal []`. (Fixture removed after the probe.)
- a fixture tree on disk in the self-test, one directory per outcome: read-and-selectable,
  read-but-not-selectable, read by nobody, and read only by this gate. The old self-test
  exercised `testNamesIn`, a string helper, and never `consumersFor` at all.

### Three id-carrying journey tests passed over an empty ledger

Run on this branch's own worktree — cut from `origin/main`, where the lanes do not exist —
`runJourney` early-returns an empty ledger and 7 of the 14 journey tests still passed,
including `[INV-DAY-09]` (`[].every(…)` is `true`), `[INV-REC-01]` (a loop over zero
repairs) and the independent-reference cross-check (`[] === []`). Those names are what
`owningTests()` reads as coverage claims, so three invariant ids were claimed by tests that
could not fail. They now assert the trace has its 31 dates, and `REC-01` that the one
repair happened, before asserting anything about it. The suite was red overall only because
a different test (`ran all thirty local days`) failed — which is luck, not a gate.

Measured before and after, on that same branch worktree: `Tests 11 failed | 127 passed
(138)` → `Tests 14 failed | 129 passed (143)`. The three added failures are exactly those
three tests.

### Four accuracy corrections

| Claimed                                                           | Measured                                                                                               |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `INV-ECO-01`'s offender is the day lane                           | It was `packages/core/src/journey/driver.ts`, this task's own file. Fixed here.                        |
| 1,125 tests in 107 files, 27.5 s, 8 failing (3 per gate)          | 1,125 in 106 files, 37.2 s, **4** failing, one per gate — and 1,130 in 106 after this task's new tests |
| This gate is the only file whose test names carry the filter term | 60 files do; `pnpm test:falsify` selects 57 of them and runs 245 tests                                 |
| The Stryker threshold is a gate                                   | It is derived from `day/` alone; the nightly reports, and the clause is NOT MET                        |

### What the same review confirmed

Recorded so the page is not only its corrections: all nine branches merge with **zero
conflicts**; every number in the end-state ledger table reproduces exactly, independently,
on a tree rebuilt from these shas; this branch changes no `package.json`,
`pnpm-lock.yaml`, `pnpm-workspace.yaml`, `pyproject.toml` or `uv.lock`; `packages/core`
imports nothing from react-native or expo; `actionlint .github/workflows/mutation.yml`
exits 0; and the id arithmetic holds — 424 ids in `docs/invariants.md`, a 217-id union
across `docs/invariants-owned.json` and the 11 `docs/owned/*.json`, 0 missing, 0
undeclared, exactly one duplicate.

## The whole suite

`pnpm test` on the merged tree at these nine shas: **1,130 tests in 106 files,
3 failing**, twice — 32.27 s on an idle machine and 59.45 s with the rest of this session
running beside it, which is what a local wall-clock figure is worth — `[INV-ECO-24]`, the falsifier gate's _"every owned invariant id has a
committed falsifier input"_ (the 42 missing inputs), and the roster gate's _"every id the
phase roster requires is claimed by exactly one ownership file"_ (the `INV-CER-01`
duplicate). Exactly one failure per blocker; every other test in every lane passes.

An earlier draft of this page reported _"1,125 tests in 107 files, 27.5 s, 8 failing …
three from the falsifier gate and three from the roster gate"_. A refuter reproduced the
same merge and measured 1,125 tests in 106 files, 37.2 s, 4 failing — one failure per gate,
not three. The "two consequences" each did not exist. Over-stating failures is the safer
direction to be wrong in, but the decomposition a founder reads was wrong, so: the numbers
above are re-measured, the five extra tests are this task's new fixture-tree self-tests,
and `[INV-ECO-01]` is gone because it was fixed rather than because it stopped being
counted.

## Dependencies added

**None by this task.** `pnpm-lock.yaml`, `package.json` and `pnpm-workspace.yaml` are
untouched by `p1/journey-and-gate`; the phase's only dependency change was the designated
deps task (`ts-fsrs`, the bundle-safe ed25519 verifier, `tools/soundbank`), which landed
before this branch started.

## Disk

```
df -h ~
Filesystem      Size    Used   Avail Capacity iused ifree %iused  Mounted on
/dev/disk3s5   460Gi   382Gi    28Gi    94%    4.5M  294M    2%   /System/Volumes/Data
```

**28 GB free at 94%**, against the plan's ≥ 80 GB target, unchanged since P0 apart from one
scratch integration worktree and a Stryker temp directory. The deletion candidate list in
plan §Risks 1 is still waiting on founder approval; nothing was deleted.

## Deferred to P2, and why

| Deferred                        | Why                                                                                                                                                                                                                |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| The 13 roster ids above         | Every one needs a screen, a native surface or a device. They are declared in `docs/owned/journey.json` with reasons and move to P3/P4/P5.                                                                          |
| The 42 missing falsifier inputs | Owned by the lanes that own the ids, chiefly `p1-foundation-economy-schema`. Not fixable from this task's file lane.                                                                                               |
| One falsifier format            | Four lanes, four payload shapes. The gate stopped prescribing one; unifying them (and moving every lane onto the executable `check` contract, so the runner and not the lane executes the corpus) is a P2 cleanup. |
| Stryker's regex mutants         | Off until `weapon-regex` stops emitting `\V` under the `u` flag, or `sanitise.ts` writes its class differently.                                                                                                    |
| A CI run behind any of this     | Nothing has been pushed. Every figure here is local. The integrate task's push is what turns these into evidence with a URL.                                                                                       |

## Open items carried into P2

1. **Nothing here has a CI URL.** The plan's §The build workflow, step 3 says only CI
   produces artefacts and a screenshot without a CI URL does not count. The same standard
   applies to these numbers: they are local, reproducible, and unverified by the runner.
2. **The two cross-lane collisions and the duplicate claim** must be resolved before the
   phase gate can be green, and before Stryker can score an unmodified tree.
3. **The economy/schema lane owes a falsifier corpus** — 36 of the 42 missing ids are its,
   and it is the only lane of the eight with no `__falsifiers__` directory.
4. **The journey does not yet run against a real SQLite progress database.** It drives the
   pure engine; `packages/schema`'s golden-DB corpus and `session-commit.ts` are exercised
   by that lane's own tests. Running the same 30 days through `createNodeDb` + `migrate`
   would close the gap between "the engine agrees with itself" and "the engine agrees with
   what is on disk", and is the natural P2 extension.
5. **`maxRolloverDeferralSeconds` is a literal in the journey**, deliberately: a gate that
   reads the bound from the thing it is bounding cannot catch the bound moving. If the
   ruling changes, that literal must change with it, and the journey will say so.
6. **No whole-engine mutation score exists.** Until one does, `thresholds.break` is a
   derivation from `day/` and the nightly reports instead of gating. The first green
   merged tree makes the run possible; the commit that records the number is the one that
   takes `continue-on-error` off. Until then the plan's P1 gate clause _"Stryker score ≥
   threshold nightly"_ is **NOT MET**.
7. **The executable falsifier contract has no users.** Zero of 176 fixtures declare
   `{check, cases}`, so the gate's execution clause runs zero cases and the corpus is held
   up by the consumption check alone. Moving one lane onto the contract per P2 module is
   the cheapest way to make _"committed falsifier inputs"_ mean _"executed falsifier
   inputs"_.
