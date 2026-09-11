# Freelingo v1 — Invariants

**The "zero faults in the core use case" contract.** 424 invariants — 181 from the first pass plus 243 added by the **merge pass of 2026-09-11**, which folded all 499 hunted edge cases into `00-EDGE-CASES.md`. Every one is phrased so it can be executed, and every one names the edge cases it retires. Five first-pass invariants were **corrected in place** by that pass where the hunt proved them wrong (INV-DAY-03, INV-MOD-01, INV-SEC-01, INV-REC-01, INV-PACK-01); everything else above the merge-pass heading is unchanged.

## The core use case, stated plainly

> A learner opens Freelingo once a day, for five minutes, for a year — on one device, offline, across timezones, DST, an OS upgrade, two courses, a reinstall and a three-day absence — and **never loses a day of progress they earned, never gets credited a day they did not earn, and never sees a screen with no defined state.**

Everything below exists to make that sentence testable. An invariant that cannot fail is not an invariant; each row names a concrete falsifier.

## Test kinds

| Kind | Meaning | Harness |
|---|---|---|
| **P** | Property test over generated inputs | `fast-check` + an in-memory SQLite fixture; ≥10,000 cases per property in CI |
| **U** | Unit / golden test | Vitest against a seeded DB |
| **E** | End-to-end flow on a simulator + emulator pair | **Maestro** (Detox's ceiling is RN 0.84; SDK 57 ships 0.86) |
| **C** | Content-pack CI gate, runs before any human review | `coursekit validate` — V1–V12 plus the Freelingo additions below |
| **S** | Snapshot / visual regression | Maestro screenshot + external pixel differ |
| **D** | Device-only manual QA (haptics, mic, widget budget) — **cannot be automated**, must appear on the release checklist |

## Rules of engagement

1. **A failing invariant blocks the release.** Not a warning, not a TODO.
2. **Every clock-dependent property is tested against a virtual clock**, never `Date.now()`. A test that cannot move time 400 days forward, backward, across a date line and across a DST boundary in one run is not testing the day boundary.
3. **Every day-keyed property is tested with at least three real IANA zones** — `Asia/Tokyo` (+9), `America/Los_Angeles` (−7/−8, DST), `Pacific/Kiritimati` (+14, the date-line extreme) — plus `Australia/Lord_Howe` (30-minute DST) as the adversarial case.
4. **Two courses installed is the default fixture**, not the exceptional one. Every scoping bug in the hunt came from a single-course assumption.
5. **The session runtime must be driven headlessly.** If a property can only be checked by tapping a real screen, the state machine is in the wrong layer.

---

# 1 — Session engine

Falsifier for the whole section: kill the process at a uniformly random instant during a generated session and assert the post-relaunch state.

| id | Invariant | Kind | Covers |
|---|---|---|---|
| **INV-SESS-01** | For any session and any kill point, relaunch restores `(queue, index, answers, hearts, combo, usedInterstitialKeys, inputMode, hardMode, optionSeeds)` byte-identical to the last checkpoint, and the checkpoint is never older than one challenge boundary | P, E | EC-SES-01, EC-SES-17 |
| **INV-SESS-02** | `resume_offered ⟺ monotonic_age(session_row) > 24 h`. Never wall-clock-derived | P | EC-SES-02 |
| **INV-SESS-03** | `START OVER` produces a queue disjoint from the abandoned queue except for items that are FSRS-due, and writes **no** new attempt rows for items already answered | P | EC-SES-03, EC-SCH-03 |
| **INV-SESS-04** | `banner.*` is a persisted shell state. Killing between a verdict and CONTINUE restores the banner with CONTINUE armed, and the reward ledger is unchanged | P, E | EC-SES-04 |
| **INV-SESS-05** | The realised option order of any already-presented item is replayed verbatim on resume; re-randomisation applies only to unreached items and to a fresh session | P | EC-SES-05, EC-SES-16 |
| **INV-SESS-06** | The persisted session row contains all nine fields in INV-SESS-01. A schema with fewer fields fails the test by construction | U | EC-SES-06 |
| **INV-SESS-07** | `count(session_state WHERE course_id = c) ≤ 1` for every `c`, and switching courses never deletes a row | P, E | EC-SES-07, EC-SES-10 |
| **INV-SESS-08** | Cold-start restore sets `active_course_id` from the session row **before** resolving the node route; a persisted-active-course/session-course mismatch resolves to the session's course | P | EC-SES-08 |
| **INV-SESS-09** | At most one session is in flight globally. Requesting a second opens the guard sheet; the destructive branch commits attempts and mistakes before creating the new row | P, E | EC-SES-09 |
| **INV-SESS-10** | Session age is monotonic-derived: a backwards clock jump clamps age to 0 (silent resume); a forwards jump offers the choice and never auto-discards | P | EC-SES-11, EC-SES-12 |
| **INV-SESS-11** | `End session` and any abandonment commit every answered attempt and every mistake row to the scheduler, while discarding session XP and the node-ring advance | P, E | EC-SES-13 |
| **INV-SESS-12** | X on the first unanswered exercise writes **zero** rows of any kind | P, E | EC-SES-14 |
| **INV-SESS-13** | A generated session never contains the same item twice in adjacent positions, and its length is `min(target, available)` — padding draws only from the due pool | P | EC-SES-15 |

---

# 2 — Grading

| id | Invariant | Kind | Covers |
|---|---|---|---|
| **INV-GRD-01** | Tier-2 classification is total and ordered: whitespace-insertion → whitespace-omission → capitalisation/terminal punctuation → non-contrastive diacritics → single-edit typo. Each class maps to exactly one note string, and the pool contains **six** notes, not four | P, U | EC-GRD-01, EC-GRD-02, EC-GRD-06 |
| **INV-GRD-02** | The three typo guards (not a target-language word · not on the target lexeme · ≥5 chars) are **named config constants**, and flipping any one of them changes the verdict on the two recorded failures (`caso`/`casa`, `gatto`/`gato`). A build where the guards are inlined fails this test | P, U | EC-GRD-04, EC-GRD-05 |
| **INV-GRD-03** | A match against a non-preferred authored alternate is correct and emits `Another correct solution:` with the preferred rendering. Alternates are **authored in the pack**, never computed at runtime — a runtime alternate generator fails the test | U, C | EC-GRD-07 |
| **INV-GRD-04** | The attempt row carries **two** independent flags (`soft_corrected`, `wrong`). `correctFirstTry = !wrong`; `Perfect lesson! ⟺ count(wrong) = 0`; a soft-correct never creates a mistake row | P | EC-GRD-08, EC-GRD-12 |
| **INV-GRD-05** | A multi-gap item is correct iff every gap is correct; no partial credit anywhere | P | EC-GRD-09 |
| **INV-GRD-06** | `accuracy = correctFirstTry / scorable`, where `scorable` excludes skipped speaking/listening items, failed speak attempts, character traces and read/listen-and-respond. If `scorable = 0`, accuracy is **undefined** and the tile is omitted (single-tile layout) — never rendered as 0% | P | EC-GRD-10, EC-GRD-11, EC-CER-07 |
| **INV-GRD-07** | A match exercise with ≥1 wrong pair yields exactly **one** mistake row (the left-hand lexeme of the first wrong pair) and exactly one accuracy miss | P | EC-GRD-13 |
| **INV-GRD-08** | Read/listen-and-respond grading is monotone in length and required-lexeme presence, never costs a heart, and degrades LLM → keyword+length → unconditional accept without changing the session's shape | P | EC-GRD-15 |

---

# 3 — Combo, progress bar and interstitials

| id | Invariant | Kind | Covers |
|---|---|---|---|
| **INV-COM-01** | Combo increments by exactly 1 per **exercise**, never per pair, per gap or per stroke | P | EC-COM-01 |
| **INV-COM-02** | `session_start ⟹ combo = 0` for every flavour including Practice, Story, Radio, Hub and recovery lessons. Combo never appears in the account region | P | EC-COM-02 |
| **INV-COM-03** | Interstitials fire at 5, 10 and every 10 thereafter, never repeat copy within a session, and stop entirely once the pool of 7 is exhausted — they never fall back to the non-combo pool | P | EC-COM-03 |
| **INV-COM-04** | `barGold ⟺ combo ≥ 6`; the `N IN A ROW` label is visible iff `combo ≥ 2`. Both are pure functions of combo with no animation dependency | P, S | EC-COM-04 |
| **INV-COM-05** | A colour transition never cancels or rewinds an in-flight width tween, in either direction | S | EC-COM-05, EC-COM-06 |
| **INV-COM-06** | Progress-bar denominator is fixed at session start to the main-queue length. Mid-lesson recycles consume no segment; the final replay consumes the reserved last segment. The denominator is immutable for the session's life | P, S | EC-COM-07 |

---

# 4 — Mistake recycling

| id | Invariant | Kind | Covers |
|---|---|---|---|
| **INV-MIS-01** | Every mistake is recycled exactly twice — once mid-lesson, once at the end — and the session cannot reach `complete` with a pending mistake | P | EC-MIS-01 |
| **INV-MIS-02** | A wrong answer during the replay re-queues the item; the queue drains to empty in finite steps for any answer sequence (termination proof, not a spot check) | P | EC-MIS-02 |
| **INV-MIS-03** | Test flavours (`jump-here`, `section`, `placement`) produce **zero** recycles and **zero** mistake-queue entries | P | EC-MIS-03 |

---

# 5 — Scheduler (FSRS)

The one subsystem where a silent fault causes lasting harm rather than a missed reward.

| id | Invariant | Kind | Covers |
|---|---|---|---|
| **INV-SCH-01** | An early review (`elapsed < 0.6 × scheduled_interval`) updates retrievability and logs `review_kind='early'` but leaves `stability` and `due_at` **unchanged**. Property: for any sequence of 500 reviews at any cadence, `median(interval)` is non-decreasing over the learner's history | P | EC-SCH-01 |
| **INV-SCH-02** | `elapsed_since_last_review` is clamped to `≥ 0` before it reaches the scheduler, and any clamped event writes an anomaly row. Property: no clock sequence, however adversarial, can produce a `stability` increase larger than the honest-clock bound | P | EC-SCH-02 |
| **INV-SCH-03** | Attempt rows are written exactly once per answered exercise, keyed by `(session_id, exercise_index)`; replay of any commit is idempotent | P | EC-SCH-03 |
| **INV-SCH-04** | When `due_items > k × session_length` on course re-entry, the node popup surfaces a review session first **and the lesson node's generated contents are byte-identical to what they would have been otherwise** | P, E | EC-PTH-19 |
| **INV-SCH-05** | `Today's Review` and `Daily Refresh` draw from one pool with a shared per-`local_day` spent-marker. No item is served by both surfaces on the same day | P | EC-SCH-05 |
| **INV-SCH-06** | The endgame generator terminates: it returns a non-empty session while any item is due, returns the `Come back later…` state when none is, and **never** introduces an unseen item | P | EC-SCH-06 |

---

# 6 — The day boundary

Every property here runs against the virtual clock and the four-zone matrix.

| id | Invariant | Kind | Covers |
|---|---|---|---|
| **INV-DAY-01** | Streak = the size of the maximal contiguous run of distinct `local_day` values ending at today-or-yesterday. Computed from the set, never incremented imperatively | P | EC-STK-01, EC-STK-15 |
| **INV-DAY-02** | A `local_day` regression is honoured iff `completed_at_utc` is monotonically increasing **and** `tz_id`/offset changed; refused otherwise. Property: no pure clock manipulation (no zone change) can mint a day-keyed reward; no genuine westward date-line crossing is ever refused one | P | EC-STK-02, EC-STK-09 |
| **INV-DAY-03** | A civil date is `unlived` **only when the device's local clock jumped over it via a zone change** — never merely because the device was off or the app unopened. An unlived date is not a missed day, consumes no freeze, does not increment the streak, and renders as its own calendar cell; a date the local clock passed through while powered off is **lived and missed**, and is covered by a freeze or breaks the streak like any other. Falsifier: a three-date powered-off gap that returns `unlived` and preserves the streak | P, S | EC-STK-03, EC-STK-04, EC-STK-21 |
| **INV-DAY-04** | Every session row stores `tz_id` and `local_day` at **both** start and completion. When they differ, the credited day is the one not already satisfied, preferring the start day; a zone change alone never produces a regression | P | EC-STK-05 |
| **INV-DAY-05** | Day boundaries are derived by civil-date arithmetic in the zone, never by adding 86,400 s. Property: rollover over any 400-day span in any of the four zones consumes exactly one freeze per missed civil date — 23-hour and 25-hour days included | P | EC-STK-06, EC-STK-07, EC-STK-08 |
| **INV-DAY-06** | A break is a recorded fact (`broken_on`, `previous_streak`) and is never recomputed from a moving clock | P | EC-STK-10 |
| **INV-DAY-07** | A gap > `max_offline_days` (30) resolves to one freeze attempt and one break, regardless of gap size. Property: freeze consumption over any gap is `min(gap_days, freezes_owned, max_offline_days)` | P | EC-STK-11, EC-FRZ-04 |
| **INV-DAY-08** | The grace window credits **streak only**. XP, quests, the goal chest and Daily Most XP are keyed strictly to completion time. Property: total goal chests granted over any 400-day span = number of distinct `local_day`s whose XP crossed the goal — never more | P | EC-STK-12 |
| **INV-DAY-09** | `rolloverTo(localDay)` is idempotent, terminates for any input, and its deferral is bounded by `maxRolloverDeferralSeconds = 300`. Property: a session that never completes cannot starve rollover past that bound | P | EC-STK-14 |
| **INV-DAY-10** | Time-of-day and weekday achievement predicates evaluate against the `tz_id` + offset stored on the row, never against the current zone | P | EC-STK-16 |
| **INV-DAY-11** | Score, gems and lifetime XP are invariant under every clock and zone manipulation in the matrix | P | EC-STK-17 |
| **INV-DAY-12** | Quest progress is keyed to `local_day`; a zone change preserves progress and may lengthen the countdown, never shorten it below the true remaining time | P | EC-STK-20 |

---

# 7 — Freeze and recovery

| id | Invariant | Kind | Covers |
|---|---|---|---|
| **INV-FRZ-01** | The rollover walk consumes a freeze for a missed day **iff the freeze was owned before that day began**. Property: over any absence, `freezes_consumed = min(missed_days, freezes_owned_at_absence_start)` — never more, never fewer, regardless of when the app next ran | P | EC-FRZ-01, EC-FRZ-05 |
| **INV-FRZ-02** | A frozen day preserves the streak number and does not increment it; the calendar cell is a snowflake; the recovery challenge is not armed | P | EC-FRZ-02, EC-FRZ-03, EC-FRZ-12 |
| **INV-FRZ-03** | Freeze acquisition has exactly three channels plus the `one_time` subtype, each idempotent on its own grant key; the balance never exceeds the current cap | P | EC-FRZ-06 |
| **INV-FRZ-04** | Streak Society tier entry **grants** freezes (balance and cap both rise) and is idempotent on `society_tier_entered_at`; a clock-tamper replay mints nothing | P | EC-FRZ-07, EC-ECO-20 |
| **INV-REC-01** | **Two** recovery mechanics ship side by side and neither may double-pay. The 3-lesson recovery challenge has a window of **2 local days**; the monthly **Streak Repair** is capped at `streakRepairsPerMonth = 1`, is idempotent on `(year, month)`, **never stacks with a freeze on the same day**, and restores `streak = previous_streak` with **today left unsatisfied**. Property: over any 400-day span, repairs granted ≤ one per calendar month and no local day is both freeze-covered and repaired | P, U | EC-FRZ-08, EC-FRZ-11, EC-FRZ-13 |
| **INV-REC-02** | Recovery lessons pay full XP, advance quests and count toward the goal; completion sets `streak = previous_streak` **and marks today satisfied** | P, E | EC-FRZ-09 |
| **INV-REC-03** | Recovery progress survives an app kill exactly like an ordinary session | P, E | EC-FRZ-10 |

---

# 8 — Economy

| id | Invariant | Kind | Covers |
|---|---|---|---|
| **INV-ECO-01** | The minutes↔XP goal mapping exists exactly **once**, as a named table in the economy config, referenced by every consumer. Grep gate: no literal `10/20/30/40` or `10/20/30/50` tuple appears in application code | U, C | EC-ECO-01 |
| **INV-ECO-02** | The boost multiplier is read **at session start**, written to the session row, and committed as read **unless `commit_time > boost_expiry + boostGraceSeconds`**, in which case the session commits at 1× and S067 carries a one-line explanation of the smaller number. `boostGraceSeconds` is a named economy-config constant. Property: for any kill/resume/expiry interleaving, the multiplier applied equals the multiplier recorded, the ceremony's rendered number equals the committed number, and no parked session can bank a boost beyond the grace | P | EC-ECO-02 |
| **INV-ECO-03** | Boosts never stack in multiplier and never extend a running timer; grants during an active boost enter inventory, `size ≤ maxBoostInventory`; duration is per-grant | P | EC-ECO-03, EC-ECO-04 |
| **INV-ECO-04** | Gems, freezes, boosts, quests, goal, streak and achievements live in the `account` region; course XP, Score, path state, mistakes and FSRS rows live in `course_progress`. Schema gate: no table straddles the two | U | EC-ECO-05 |
| **INV-ECO-05** | The daily-goal chest is granted at most once per `local_day`, idempotently, and a mid-day goal change neither re-fires it nor un-meets the day | P | EC-ECO-09, EC-CER-06 |
| **INV-ECO-06** | Per-mode XP diminishing returns are keyed by `(local_day)` **globally**, not per course. Property: total XP from any one mode on any one day ≤ the ladder's cumulative bound, for any sequence of sessions across any number of courses | P | EC-ECO-06, EC-ECO-07, EC-ECO-08 |
| **INV-ECO-07** | `legendary_awarded_at` is set once per node, ever; a second legendary completion awards 0 and the popup exposes only the practice route | P, E | EC-PTH-04 |
| **INV-ECO-08** | A completed Daily Refresh level remains replayable and pays the practice award, never the level award | P | EC-PTH-15 |
| **INV-ECO-09** | A session-flavour matrix exists as data, with an explicit `{extends_streak, counts_toward_goal, awards_xp, advances_quests}` row for **every** flavour including placement, jump-here, section test, recovery and endgame. Gate: a flavour with no row fails the build | U, C | EC-ECO-15 |
| **INV-ECO-10** | Quest targets derive from a trailing 7-day median of daily XP, clamped `[10, 200]`; the monthly badge counts completed quests in the calendar month; a fully-cleared tab renders completed cards + countdown, never an empty state | P | EC-ECO-10, EC-ECO-11 |
| **INV-ECO-11** | The day's quests and the day's Daily Refresh set are pure functions of `(local_day, seed)` — identical across a kill, a relaunch and a course switch on the same day | P | EC-ECO-12, EC-PTH-14 |
| **INV-ECO-12** | No gem price exists on hearts, Legendary, streak recovery or any learning surface. Grep gate over the shipped config: the only priced items are cosmetics. Deprecated items (Timer Boost, Double-or-Nothing, Happy Hour, Early Bird, Weekend Amulet) exist as **types with no catalogue entry** | U, C | EC-ECO-14, EC-ECO-22 |
| **INV-ECO-13** | Two XP counters exist: `account.lifetime_xp` (feeds achievements, survives removal) and `course_progress.xp` (destroyed on removal). Word-count achievements use the **union** of content-hashed item ids, never a sum | P | EC-ECO-16, EC-ECO-17 |
| **INV-ECO-14** | Milestone set is `{7, 30, 100, 365, 1000}`; the streak goal has a defined resolution (rail, celebration, re-pick, silent reset) and every "you did it" string keys off the streak number, never the calendar date | U, S | EC-STK-18, EC-ECO-21 |
| **INV-ECO-15** | The XP advertised on a node/offer is a field of the offer read from the same config as the award. Property: `advertised == awarded` for every flavour, or the discrepancy is an explicit, named config value | P | EC-ECO-19, EC-HUB-06 |

---

# 9 — Ceremony

| id | Invariant | Kind | Covers |
|---|---|---|---|
| **INV-CER-01** | The entire reward commit is one exclusive transaction keyed by `session_id`, executed at S1a. Property: killing at any instant during the ceremony leaves the ledger either fully applied or fully unapplied, and replay awards nothing extra | P, E | EC-CER-01, EC-ECO-18 |
| **INV-CER-02** | The ceremony queue is an ordered predicate list evaluated **once**. Property: for any session state, the rendered chain is a subsequence of the canonical order, contains no duplicates, and the path model is mutated before the return screen renders | P, E | EC-PTH-11, EC-CER-04 |
| **INV-CER-03** | Every predicate declares its scope. Schema gate: each queue row carries `scope ∈ {account, course}`, and a course-scoped predicate reads only `course_progress[active]`. Falsifier: install a second course and assert the Score-unlock screen fires again while the streak count-up does not | P, E | EC-CER-03 |
| **INV-CER-04** | `streakExtendedThisSession` and `streakAlreadyExtendedToday` are mutually exclusive and jointly exhaustive for any session that completes on a day with a streak | P | EC-CER-05 |
| **INV-CER-05** | `Perfect lesson!` renders the single-COMBO-tile terminal layout and fires only for lesson flavours; Practice at 100% renders `Practice Complete!` + `AMAZING` | U, S | EC-CER-08, EC-CER-09 |
| **INV-CER-06** | A failed gated challenge renders the consolation screen with its awarded XP; a genuinely zero-award abandonment renders no ceremony | P | EC-CER-10 |
| **INV-CER-07** | At most one achievement screen per session, showing the highest tier crossed per achievement, with all crossed tiers' gems summed into the single chest. Personal Records update with no screen | P | EC-CER-11 |
| **INV-CER-08** | `score.ceilingReachedThisSession` fires exactly once in a course's lifetime; thereafter the Score-progress screen is permanently suppressed and the chip's tap target is repointed | P | EC-CER-12 |
| **INV-CER-09** | The reward screen is one component over a bundle `{gems?, freeze?, boost?}`; copy is selected by bundle contents. Gate: no second gems-only screen exists | U | EC-CER-13 |

---

# 10 — Path

| id | Invariant | Kind | Covers |
|---|---|---|---|
| **INV-PATH-01** | Node unlock is strictly linear within a unit: `unlocked(n) ⟺ complete(n−1)`. The only early path is a passed jump-here. A locked node always renders a popup | P, E | EC-PTH-01, EC-PTH-21 |
| **INV-PATH-02** | Node visual state is a pure function of `(sub_lessons_done, sub_lessons_total, legendary)`. No timer, no decay, no server input | P, S | EC-PTH-02, EC-PTH-07 |
| **INV-PATH-03** | A complete node's popup exposes Practice and (if eligible) Legendary, and never a sub-lesson counter or START | U, S | EC-PTH-03 |
| **INV-PATH-04** | Failing Legendary or a jump-here changes no persistent state except an attempt log; the retry is immediately available at zero cost | P, E | EC-PTH-05, EC-PTH-08 |
| **INV-PATH-05** | Unit trophy turns legendary iff every level in the unit is legendary | P | EC-PTH-06 |
| **INV-PATH-06** | A passed jump-here marks skipped items **unseen** in FSRS and raises `score_floor` to the target band's floor. Property: `displayed_score = max(score_earned, score_floor)`, `score_floor` is non-decreasing, and the CEFR chip and Score chip never disagree by more than one band | P | EC-PTH-09, EC-SCH-04 |
| **INV-PATH-07** | The demotion offer triggers on a defined failure signal and moves the learner without destroying progress | P, E | EC-PTH-10 |
| **INV-PATH-08** | Daily Refresh is locked iff the course is incomplete, and unlocks exactly once | P | EC-PTH-12, EC-PTH-13 |
| **INV-PATH-09** | An absence of any length changes no path state: no forced review, no relocking, same current node | P, E | EC-PTH-18 |

---

# 11 — Modality, accessibility, typography

| id | Invariant | Kind | Covers |
|---|---|---|---|
| **INV-MOD-01** | The speaking/listening suspension is a single account-scoped record storing **both a UTC instant and a monotonic deadline**. Property: no clock manipulation extends it beyond 60 real minutes; it survives a process kill; and on a **detected monotonic reset (reboot) it fails open and expires immediately** rather than persisting unbounded — a suspension that silently never lifts removes an exercise family, which is the worse failure. Falsifier: reboot mid-suspension and assert the family returns | P | EC-MOD-01, EC-MOD-12, EC-MOD-21 |
| **INV-MOD-02** | A modality skip draws a replacement so `len(session)` is unchanged, costs no heart, does not reset combo, and writes no mistake row | P | EC-MOD-02 |
| **INV-MOD-03** | Generation requires **both** gates open (preference ON **and** not suspended). Toggling a preference ON clears a running suspension; toggling OFF never starts one | P | EC-MOD-03 |
| **INV-MOD-04** | Gate state is a 1:1 function of cause: `preference-off`, `suspended`, `mic-denied`, `no-content` each map to a distinct copy + action pair. Gate: no two causes share a remedy string, and no gate action is ever a no-op | U, S | EC-MOD-04, EC-HUB-03 |
| **INV-MOD-05** | An all-speaking session with no mic converts remaining items in place to recognition variants, completes, and pays full XP. Property: **no permission or hardware state can end a session early** | P, E | EC-MOD-05, EC-MOD-06 |
| **INV-MOD-06** | A preference toggled mid-session never mutates the live queue | P | EC-MOD-09 |
| **INV-MOD-07** | `storyListeningMode.countsAsListenPractice = false`: story listening plays with the listening preference off, and contributes nothing to the Listen card or listen counters | P | EC-MOD-16 |
| **INV-A11Y-01** | With Animations OFF **and** Sound OFF, every state change that carries meaning still has a non-colour, non-motion carrier. Gate: the `N IN A ROW` label, the `HARD EXERCISE` pill and the `PREVIOUS MISTAKE` pill render under every combination of the two toggles plus OS Reduce Motion | S | EC-COM-08 |
| **INV-A11Y-02** | Animations OFF removes **transitions only**. Property: the set of reachable *states* is identical with animations on and off; screens still appear; the START bubble persists; navigation scrolls still happen | P, S | EC-CER-15, EC-A11Y-05, EC-I18N-03, EC-PLAT-12 |
| **INV-A11Y-03** | Every ceremony screen moves focus to its headline on entry, announces the XP tile once at its final value, never auto-advances, and puts CONTINUE last in reading order | E (accessibility audit) | EC-CER-16 |
| **INV-A11Y-04** | Every exercise type has a declared screen-reader contract and is completable with the screen reader on. Falsifier: a Maestro accessibility-tree walk that answers one instance of every type using only accessibility actions. Legendary mode **removes** hint actions from the tree rather than unstyling them | E | EC-A11Y-01, EC-A11Y-02, EC-A11Y-03 |
| **INV-A11Y-05** | OS permission state → copy is a total function with five inputs and four strings; only `never-asked` may trigger a system prompt, and never mid-lesson. iOS mic + speech-recognition grants are ANDed into one capability | P, U | EC-MOD-07, EC-MOD-08 |
| **INV-A11Y-06** | With a screen reader active, the generator emits zero non-completable item types (tracing, and any future gesture-graded type) and substitutes 1:1 at **generation** time | P | EC-A11Y-04 |
| **INV-TYP-01** | At OS font scale 2.0 every interactive control remains hittable and fully labelled: heights become min-heights, labels wrap to ≤2 lines before truncating, **the 4 px lip stays exactly 4 px**, nothing shrinks below 12 px, and `scaleX` appears nowhere | S (scale matrix ×3) | EC-TYP-01, EC-TYP-05 |
| **INV-TYP-02** | At every scale × every supported width, the page never scrolls horizontally, CHECK stays pinned and reachable, and an anchored popup never covers its own anchor | S | EC-TYP-02, EC-TYP-03, EC-TYP-06 |
| **INV-TYP-03** | Ruby never clips, never overlaps the line above, and is never dropped; if it cannot fit, the display string falls back to the all-kana accepted variant | S | EC-TYP-04 |
| **INV-TYP-04** | Foreground/background pairs are token pairs, never runtime luminance guesses; every shipped unit colour has a declared text token that meets contrast | U, S | EC-I18N-02 |
| **INV-I18N-01** | LTR is pinned at startup. Gate: launching under `ar` and `he` system locales produces pixel-identical layout to `en` | S | EC-I18N-01 |
| **INV-I18N-02** | The graded answer string is built from tap order and is invariant under layout direction. Property: the same tap sequence grades identically with `I18nManager.isRTL` forced true and false | P | EC-GRD-14 |

---

# 12 — Sound and haptics

| id | Invariant | Kind | Covers |
|---|---|---|---|
| **INV-SND-01** | Cue suppression is per **class**, not per frame: at most one cue per class per frame, and the combo-gold shimmer is a different class from the answer sting. Falsifier: an audio-graph assertion at combo 6 that both buses are active | U | EC-COM-09 |
| **INV-SND-02** | The Sound-effects toggle gates the effects bus only. TTS and the mic start/stop earcon always play | U | EC-A11Y-06 |
| **INV-SND-03** | No feedback path depends solely on haptics. Property: with haptics stubbed unavailable, every event still has a visual and (unless muted) an audio carrier | P | EC-A11Y-07 |
| **INV-SND-04** | Input is debounced to one action, one haptic, one sound; an interrupting verdict cancels the in-flight footer tween and re-enters from its current position without replaying the shake | U, S | EC-PLAT-11, EC-PLAT-13 |

---

# 13 — Persistence and data

| id | Invariant | Kind | Covers |
|---|---|---|---|
| **INV-PER-01** | On `SQLITE_CORRUPT` or a failed `integrity_check`, the app renames-never-deletes, starts a fresh DB, and lands on the Data screen. Falsifier: corrupt a byte range in a fixture DB and assert the file survives under `freelingo-corrupt-*` and the UI states what happened | U, E | EC-PER-01 |
| **INV-PER-02** | `rolloverTo()` has an integrity precondition. Property: with the DB in a failed-integrity state, no freeze is consumed and no streak is broken | P | EC-PER-02 |
| **INV-PER-03** | Schema DDL and the `PRAGMA user_version` bump occur in one exclusive transaction. Property: killing at any instant during a migration leaves `user_version` consistent with the actual schema, or routes to INV-PER-01 | P | EC-PER-03 |
| **INV-PER-04** | Write order at commit is attempts+mistakes → rewards. On `SQLITE_FULL` the ceremony is suppressed. Property: **the ceremony never displays a reward that is not in the DB** | P | EC-CER-02 |
| **INV-PER-05** | `availableDiskSpace` is checked at session start; below threshold the resume guarantee is downgraded **visibly**, and a failed boundary write sets a flag rather than failing silently | P, E | EC-PER-04 |
| **INV-PER-06** | Release gate: the DB path is persistent on the actual target platform. The assertion names the platform and excludes tvOS explicitly | E | EC-PER-11, EC-PER-13 |
| **INV-PER-07** | Every scheduler and reward write uses `withExclusiveTransactionAsync`. Grep gate: `withTransactionAsync` appears in no scheduler or economy module | U, C | EC-PER-12 |
| **INV-DAT-01** | Export writes to a temp path, computes a checksum into the manifest, and reaches the share sheet only on a verified-complete write; a failed export leaves no artefact | P, E | EC-PER-05 |
| **INV-DAT-02** | Import is replace-only, refuses a downgrade, takes a pre-import backup, shows both `last_day` values plus sessions-since-install, and keeps the backup 24 h behind one-tap undo. Import is reachable from onboarding | P, E | EC-PER-06, EC-PER-10 |
| **INV-DAT-03** | `session_state` is excluded from the archive, and the manifest says so | U | EC-PER-07 |
| **INV-DAT-04** | Historical rows are never re-stamped on import. Imported gap days count as **missed** (not `unlived`), and the confirm dialog states the freeze cost before it is paid | P, E | EC-PER-08 |

---

# 14 — Content packs

Runs as a CI gate **before any human review**, standing in for Duolingo's human "select and edit" step on exactly these properties.

| id | Invariant | Kind | Covers |
|---|---|---|---|
| **INV-PACK-01** | Pack state is a **six**-value enum `{not-downloaded, partial, installed, corrupt, unverified, withdrawn}` (see INV-PACK-18) and every surface renders every value. A `withdrawn` pack keeps its course read-only with all account-scoped totals intact | P, E | EC-CRS-06, EC-CRS-07, EC-PER-09 |
| **INV-PACK-02** | Item ids are content-hashed and additive-only within a major version. On a major bump, unresolvable FSRS rows are **quarantined, never deleted**, stop counting toward Score and words-learned, and are counted in the update notice | P, C | EC-PTH-16, EC-PACK-04 |
| **INV-PACK-03** | The node-type registry is pack-driven. Property: a pack declaring no stories produces a path with no book nodes, section progress with no stories counter, and a hub with no stories row — with no empty states anywhere | P | EC-PTH-17, EC-PTH-20 |
| **INV-PACK-04** | `partial ≠ corrupt`. A partial pack keeps the path and lessons fully usable with per-item audio fallback and offers RESUME; only `corrupt` shows the unavailable state | P, E | EC-PACK-01, EC-HUB-04 |
| **INV-PACK-05** | A missing asset degrades one item; it never aborts a session. Property: for any subset of assets deleted mid-session, the session still completes and the streak day is still earned | P | EC-SES-18, EC-PACK-02, EC-PLAT-10 |
| **INV-PACK-06** | **V1–V4** (ledger: no lemma before its unit, ≤1 new item per exercise, ≥N recycles within K lessons, tag soundness + coverage) pass at 100%. Japanese runs the ledger on Mode-A segmentation | C | EC-PACK-06, EC-PACK-07, EC-SCH-07 |
| **INV-PACK-07** | Every item that can be *missed* has ≥2 authored exercise forms; non-punitive types are excluded from the mistake queue by construction | C | EC-MIS-04, EC-PACK-05 |
| **INV-PACK-08** | **V6**: every accepted answer is in the unit's declared register, and for Japanese every script variant (kanji+okurigana, all-kana, katakana) is enumerated as a set. An omission is an unrecoverable wrong answer, so the set is a hard gate | C | EC-GRD-16 |
| **INV-PACK-09** | Story structure gate: exactly one `[DATA]`, one `[HEADER]`, one `[MATCH]`; `[MATCH]` is last; every MATCH pair occurred in the story. Pair count ≠ 5 is a **warning**, not a failure; an unknown block compiles to an inline `ERROR` element without aborting the parse | C | EC-STO-01, EC-STO-02, EC-STO-03, EC-STO-12 |
| **INV-PACK-10** | Generated content that fails a filter axis is **discarded and resampled**, never patched. Gate: no repair path exists in the generator | C | EC-STO-18 |
| **INV-PACK-11** | Packs live outside the backed-up directory, verified by an actual backup-manifest assertion on device — not by trusting "cache is typically excluded" | D | EC-PACK-03 |
| **INV-PACK-12** | A missing per-language data source fails the build **loudly** with the missing input named; no silent fallback to a differently-shaped file is possible | C | EC-PACK-08 |
| **INV-PACK-13** | **V10**: every shipped sentence, voice file and derived list carries a resolved licence compatible with AGPL redistribution. Gate: `corpora_shippable` is an allow-list; anything unclassified fails; NC and ND sources are excluded at ingest, not at package time | C | EC-PACK-09, EC-PACK-10, EC-PACK-11, EC-PACK-12, EC-PACK-13 |
| **INV-PACK-14** | **V8** records which engines actually ran per language (`grammar_engine`, `spellcheck_engine`) and degrades to the named fallback. A validator that reports "0 errors" when no engine ran fails this gate | C | EC-PACK-14 |
| **INV-PACK-15** | The audio manifest carries codec, bitrate and total bytes, and the pack build asserts the shipped size against the declared budget for **all three** pipelines (lessons, stories, radio) | C | EC-PACK-15, EC-PACK-16 |
| **INV-PACK-16** | Every Japanese script surface has a declared data source with a compatible licence (stroke order, furigana, readings). Gate: a surface with no source fails the build | C | EC-PACK-19 |
| **INV-AUD-01** | Audio availability is resolved at **session generation**, not at render. Property: for any (pack, system-voice) availability combination, the generated session contains zero items whose audio cannot be produced, and its length is unchanged | P | EC-MOD-10, EC-STO-06 |
| **INV-AUD-02** | An unavailable audio control **greys with a reason**; it is never hidden and never a silent no-op | S | EC-MOD-11 |
| **INV-AUD-03** | Karaoke highlighting is enabled iff the line is playing its own aligned asset. Any fallback path disables highlighting without changing playback or progress | P | EC-STO-07, EC-STO-08 |
| **INV-AUD-04** | Text and audio cannot drift: editing a line invalidates its keypoints and marks it stale; a voice change re-bakes every line by that character. Gate: publish blocks on any stale line | C | EC-STO-13, EC-STO-14 |

---

# 15 — Stories and Radio runtime

| id | Invariant | Kind | Covers |
|---|---|---|---|
| **INV-STO-01** | The progress denominator is mode-dependent and computed from visible parts; the bar is monotone non-decreasing and never jumps in any mode | P | EC-STO-04 |
| **INV-STO-02** | A comprehension element always starts a new part when the current part is populated | P | EC-STO-05 |
| **INV-STO-03** | Hints are suppressed for any span hidden by the current challenge, and a tap inside a challenge registers as an answer, not a hint | P | EC-STO-09, EC-STO-10 |
| **INV-STO-04** | Legendary suppresses hints across the whole element stream, not only during challenges | P | EC-STO-11 |
| **INV-STO-05** | Multi-select gating is parameterised: Continue is enabled iff exactly `n` are selected, where `n` comes from the item. Grep gate: no literal `2` in the selection logic | P, U | EC-STO-15 |
| **INV-STO-06** | Radio exercise anchors snap to segment boundaries; the recommender never surfaces an episode above the learner's position by default | P | EC-STO-16, EC-STO-17 |

---

# 16 — Practice Hub

| id | Invariant | Kind | Covers |
|---|---|---|---|
| **INV-HUB-01** | The hub is strictly active-course and **says so**: a course chip in the header, and a footer row naming any other course's outstanding mistakes that switches course on tap. Property: no due item from a non-active course is ever silently unreachable | P, E | EC-HUB-01 |
| **INV-HUB-02** | The mistake queue is bounded at 60 rows with the stated eviction and 30-day ageing; every eviction is logged; the badge clamps at `60+` | P | EC-MIS-05 |
| **INV-HUB-03** | A session with fewer due items than the target runs at the true count and prorates XP rather than padding with non-mistake items | P | EC-MIS-06 |
| **INV-HUB-04** | An empty mode renders its empty state and cannot launch a session | P, E | EC-MIS-07, EC-HUB-05 |
| **INV-HUB-05** | `Switch session` cycles a fixed `local_day`-seeded list of ≤4 candidates, wrapping, stable across kill/relaunch/course-switch; completing one removes it | P | EC-HUB-02 |

---

# 17 — Widget

| id | Invariant | Kind | Covers |
|---|---|---|---|
| **INV-WID-01** | The widget reads **only** the shared snapshot. Grep gate: the widget target links no SQLite symbol. The snapshot carries `{streak, last_completed_local_day, freezes_owned, day_boundary_utc, tz_id, active_course_id, goal_met}` — enough to *derive* `FROZEN` and `LOST` without an app run | U, E | EC-WID-01 |
| **INV-WID-02** | The widget deep link carries the course id and resolves deterministically without reading live state | U, E | EC-CRS-02 |
| **INV-WID-03** | Remaining time is computed **at draw** from the current device zone. Property: for any (entry-render-time, zone-change, throttle-delay) triple, the rendered remaining time is within one minute of the truth or the widget renders a non-time state — it is never confidently wrong | P | EC-WID-02, EC-WID-03, EC-WID-04 |
| **INV-WID-04** | Forced reloads are debounced to rendered-state transitions, ≤1 per 15 minutes; the daily total stays under the measured budget | P, D | EC-WID-05, EC-WID-06 |
| **INV-WID-05** | A zero-history device renders `COLD`, never `0 day streak` | S | EC-WID-07 |
| **INV-WID-06** | The widget state machine is **total**: every (goal_met, minutes_to_boundary, freeze_state, streak) tuple maps to exactly one state, and every state has a timeline entry that can reach it. Falsifier: enumerate the product space and assert no gap | P | EC-WID-08 |
| **INV-WID-07** | At maximum system font scale the streak number is never truncated or scaled below its floor; surrounding words truncate first | S | EC-WID-09 |

---

# 18 — Notifications

| id | Invariant | Kind | Covers |
|---|---|---|---|
| **INV-NOT-01** | The daily reminder is a wall-clock calendar trigger; the streak-danger nudge is an absolute instant recomputed on rollover, on session completion **and** on the OS timezone-change broadcast. Property: after any zone or DST change, the reminder fires at the chosen wall-clock time and the nudge fires at the correct instant before local midnight | P, E | EC-NOT-01, EC-NOT-07 |
| **INV-NOT-02** | The danger nudge is pre-armed at most one day ahead and is cancelled on completion. Property: no notification can claim a streak is at risk when the streak is already broken — where the OS forbids a fire-time re-check, the notification is not scheduled at all | P | EC-NOT-02, EC-NOT-08 |
| **INV-NOT-03** | A goal-met day draws only from goal-met-eligible templates and never uses danger language; a freeze-covered day never congratulates | P | EC-NOT-03, EC-WID-10 |
| **INV-NOT-04** | Template eligibility is evaluated per course; the winning template carries `course_id`; the tap target switches course before routing. Property: the deep link never lands on a course whose data the body described | P, E | EC-CRS-01 |
| **INV-NOT-05** | Recency is a continuous penalty `score − 0.017 × 0.5^(days/15)`, never a hard exclusion. Property: a template is always eligible, only ever down-weighted | P | EC-NOT-04 |
| **INV-NOT-06** | Pending local notifications never exceed the platform ceiling (~64 on iOS); the scheduler sizes against the platform, not the SDK docs | P, D | EC-NOT-06 |

---

# 19 — Security and hostile input

| id | Invariant | Kind | Covers |
|---|---|---|---|
| **INV-SEC-01** | **Every** user-text field — typed answers, the tier-3 wrong-answer diff, report notes, Roleplay and read-and-respond input — is bidi-stripped, format-character-stripped, NFC-normalised and length-capped **at storage time**, not at render. Property: for any input string the stored value contains no character in the bidi-control or `Cf` ranges, grading is invariant under inserted zero-width characters, and the rendered order of surrounding UI is unchanged | P | EC-SEC-01, EC-SEC-05, EC-SEC-06 |
| **INV-SEC-02** | `execAsync` is never called with interpolated input. Grep gate on the whole codebase | U, C | EC-SEC-02 |
| **INV-SEC-03** | BYOK calls go through `fetch` with the complete header set including `anthropic-workspace-id` when present, are excluded from the web target, and fail **soft** to a canned local explanation — never a spinner | P, U | EC-SEC-03, EC-SEC-04 |

---

# 20 — Platform and build

| id | Invariant | Kind | Covers |
|---|---|---|---|
| **INV-PLAT-01** | Dependency versions come from `npx expo install`. CI gate: the lockfile's Reanimated/worklets pair matches the SDK's bundled pair | C | EC-PLAT-01 |
| **INV-PLAT-02** | No hand-edited native code exists. CI gate: `expo prebuild --clean` followed by a build produces a byte-identical native tree to the committed state (or no native tree is committed at all) | C | EC-PLAT-02 |
| **INV-PLAT-03** | The e2e suite runs green on Maestro against a simulator + emulator pair on every PR | C, E | EC-PLAT-03 |
| **INV-PLAT-04** | Speech recognition feature-detects before use (`getSupportedLocales()`), sets the no-beep option on Android, and degrades to typed/skippable rather than failing | P, D | EC-MOD-13, EC-MOD-15 |
| **INV-PLAT-05** | The audio session mode is set **per surface** and restored afterwards. Property: entering and leaving every audio surface in any order leaves the session category in its documented default, and no surface both requires lock-screen control and mixing | P, D | EC-MOD-14, EC-STO-19 |
| **INV-PLAT-06** | Widget targets build from Glance composables only, and all target build numbers match the app's. CI gate on both | C | EC-WID-11, EC-WID-12 |
| **INV-PLAT-07** | `POST_NOTIFICATIONS`, `SCHEDULE_EXACT_ALARM` and `RECEIVE_BOOT_COMPLETED` are all declared, and reminders survive a reboot. Falsifier: reboot the emulator and assert the next reminder still fires | E | EC-NOT-05 |
| **INV-PLAT-08** | Release builds complete inside the tier's build timeout; day-to-day native builds run locally | C | EC-PLAT-05 |
| **INV-LLM-01** | The Explain-My-Answer gate is a three-condition AND (no on-device model **and** no BYOK key **and** no baked explanation ⇒ do not render). A mid-session eviction greys the control with a reason rather than removing it | P, U | EC-PLAT-07 |
| **INV-LLM-02** | Every on-device prompt is budgeted against the platform's input ceiling (~4,000 tokens on ML Kit GenAI) and truncates deterministically at a declared boundary, never mid-item | P | EC-PLAT-08 |

---

# 21 — Course management

| id | Invariant | Kind | Covers |
|---|---|---|---|
| **INV-CRS-01** | Removing a course deletes only `course_progress[course_id]` rows. Property: streak, gems, freezes, goal, quests, achievements and `lifetime_xp` are bit-identical before and after; re-adding restores nothing; the dialog states both facts beforehand | P, E | EC-CRS-03, EC-CRS-04 |
| **INV-CRS-02** | Destructive course actions are blocked for 24 h after a data import | P, E | EC-CRS-05 |

---

# Coverage summary

Totals as of the **merge pass 2026-09-11**, which added 243 invariants and 269 cases. Counts are by covering-invariant subsystem, so a case sits with the invariant that retires it rather than with its catalogue letter.

| Subsystem | Invariants | Edge cases addressed |
|---|---|---|
| Session engine | 28 | 31 |
| Grading | 30 | 36 |
| Combo / progress | 12 | 13 |
| Mistake recycling | 8 | 8 |
| Scheduler | 13 | 12 |
| Day boundary | 16 | 25 |
| Freeze / recovery | 12 | 20 |
| Economy | 33 | 47 |
| Ceremony | 18 | 24 |
| Path | 26 | 31 |
| Modality / a11y / typography | 60 | 79 |
| Sound / haptics | 7 | 8 |
| Persistence / data | 21 | 24 |
| Content packs / audio | 64 | 87 |
| Stories / Radio runtime | 10 | 13 |
| Practice Hub | 13 | 14 |
| Widget | 10 | 13 |
| Notifications | 17 | 20 |
| Security | 5 | 9 |
| Platform / build | 17 | 21 |
| Course management | 4 | 5 |
| **Total** | **424** | **540 of 552** |

The 12 uncovered cases are listed in `00-EDGE-CASES.md` §V. They are founder rulings, scope decisions or unmeasurables, not gaps in this contract.

---

# The six invariants to build first

If only six exist on day one, make them these. Each is load-bearing for a whole class of silent faults, and each is cheap.

1. **INV-DAY-01 + INV-DAY-05** — the streak computed from a set of civil dates, derived by civil-date arithmetic. Every timezone, DST and travel case collapses into this one function, and it is the function a beta tester will attack first.
2. **INV-CER-01** — one exclusive transaction keyed by `session_id`. Without it, every kill during a ceremony is a coin flip on the learner's rewards.
3. **INV-SESS-01** — the resume guarantee, with all nine fields. It is the difference between "the app lost my lesson" and "the app is a local database that happens to have a UI".
4. **INV-SCH-01** — the early-review guard. It is the only invariant whose failure is *invisible* to the learner and *fatal* to the product's core claim.
5. **INV-GRD-06** — the accuracy denominator. It is what makes "speaking is skippable" true rather than merely advertised.
6. **INV-PACK-13** — the licence allow-list. It is the only invariant whose failure cannot be fixed after release.

# What this contract does not cover

- **Pixel parity.** `INV-TYP-*` and the `S` kind assert that layout does not *break*; they do not assert it matches Duolingo. That needs a reference-screenshot corpus and a differ, and the corpus is 236 frames of one arm on one day.
- **Content quality.** V1–V12 are mechanical. The measured wrong-item rate comes from the paid native-reviewer sample (H1, ~300 items/language, release blocks above 2%) and no property test substitutes for it.
- ~~**The ~386 hunted edge cases not present in the supplied list**~~ — **closed 2026-09-11.** All 499 hunted cases are now merged into `00-EDGE-CASES.md`, and the 243 invariants they required are appended below under *Added in merge pass 2026-09-11*. The skeleton absorbed them without restructuring, as designed.
- **Anything requiring a signed-in Duolingo account.** The typo-forgiveness guard (EC-GRD-05), the real XP formula, the Legendary mistake allowance, jump-here question counts, widget hour thresholds and the DuoRadio player chrome are all unresolved for the same reason: the entire corpus is a guest session.

---

# Added in merge pass 2026-09-11

**243 invariants** retiring the 346 cases added when all 499 hunted edge cases were merged into `00-EDGE-CASES.md`. Ids continue each subsystem's existing scheme; no invariant above this line was renumbered. Five originals **were corrected in place** by founder ruling and are noted where relevant: INV-DAY-03 (`unlived` is a zone jump, never a powered-off phone), INV-MOD-01 (fail open on a monotonic reset), INV-SEC-01 (every user-text field), INV-REC-01 (repair and challenge coexist), INV-PACK-01 (six-value pack enum). The same rules of engagement apply: virtual clock, four-zone matrix, two courses as the default fixture, headless session runtime.

## Session engine

| id | Invariant | Kind | Covers |
|---|---|---|---|
| **INV-SESS-14** | Every route out of the lesson player — X, Android system back, hardware back, iOS interactive pop, slide-down dismiss — resolves through one quit contract. Falsifier: a back gesture at any index with progress > 0 that reaches the path without the sheet, or without committing attempt rows | P, E | EC-SES-19 |
| **INV-SESS-15** | The checkpoint includes ungraded in-flight input and an opaque per-challenge `partial_state`. Property: a kill at a uniformly random instant — mid-typing, after stroke *k*, after *m* matched pairs — restores exactly that state, and no heart already paid is charged twice | P, E | EC-SES-20 |
| **INV-SESS-16** | A resumed session contains zero items from a currently gated family and preserves its index. Falsifier: park a lesson with listening items queued, disable listening, resume, and reach a gate screen inside the queue | P, E | EC-SES-21 |
| **INV-SESS-17** | `session_state` is keyed `(course_id, session_kind, node_ref)` with ≤1 row per key; at most one **graded** session is in flight globally; story and radio positions live in their own progress rows. Falsifier: opening a lesson evicts a parked story | P, E | EC-SES-22 |
| **INV-SESS-18** | On resume the mistakes queue is re-filtered against live mistake rows, and the reserved final segment is consumed exactly once. Falsifier: retire a parked session's mistake in the hub, resume, and see it replayed | P | EC-SES-23 |
| **INV-SESS-19** | `hardMode` is false at every session start for every flavour, and every item graded under the hard guard renders the pill. Falsifier: a step-up in session 3 changes the typo verdict in session 4 | P | EC-SES-24 |
| **INV-SESS-20** | A hard item never mutates the persisted `inputMode`, and the first non-hard production item after a step-up opens in the stored mode. On a non-Latin pack, `inputMode` after a step-up equals the pre-step-up mode and a zero-in-script typed attempt writes `inputMode=bank` | P | EC-SES-25 |
| **INV-SESS-21** | RESUME is offered iff every queued item id resolves in the installed pack **and** maps to the session's node. Falsifier: install a pack that dissolves that node and assert the player never renders a blank exercise | P, E | EC-SES-26 |
| **INV-SESS-22** | Every transition out of the path lands in a declared shell state, and leaving `tips` writes zero rows of any kind. Falsifier: X from the tips state persists a `session_state` row | P, U | EC-SES-27 |
| **INV-SESS-23** | A session with zero graded attempts writes no session row and no day-keyed reward. Falsifier: ten `Can't speak now` taps in Perfect Pronunciation extend the streak | P, E | EC-SES-28 |
| **INV-SESS-24** | After an audio interruption CHECK stays disabled until the clip completes again, and the typed buffer and caret are byte-identical. Falsifier: a gradeable listening item whose audio never reached its end | P, E | EC-SES-29 |
| **INV-SESS-25** | Every player surface (lesson, story, radio, hub) routes its close control through the shared quit contract, persisting the same state a kill would and awarding 0 XP while committing answered-item attempts | P, E | EC-SES-30 |
| **INV-SESS-26** | No session shorter than the configured floor is offered, and base session XP is non-decreasing in gradeable items served. Falsifier: a 4-item and a 14-item session both commit 10 base XP | P | EC-SES-31 |
| **INV-SESS-27** | The foreground boot sequence runs as one awaited chain — rollover → FSRS recompute → snapshot+reload → notification re-arm — publishing no intermediate snapshot. Falsifier: a post-gap fixture observes a widget snapshot or armed nudge carrying pre-rollover streak state | P, E | EC-SES-32 |

## Grading

| id | Invariant | Kind | Covers |
|---|---|---|---|
| **INV-GRD-09** | Every target-language production input declares autocorrect off, spellcheck off, autocapitalize none and smart punctuation off, and tier-1 folds curly quotes to straight idempotently. Falsifier: a rendered field with `autoCorrect` unset, or a curly apostrophe graded hard wrong | U, P | EC-GRD-17 |
| **INV-GRD-10** | An open-response answer equal to, or a subsequence of, the prompt never passes, whatever its length or lexeme coverage, and the rejection writes no mistake row and costs no heart | P | EC-GRD-19 |
| **INV-GRD-11** | For every verdict class × every `Motivational messages` state the banner carries a non-empty headline from the verdict pool. Falsifier: a rendered banner with an empty headline under the toggle | P, S | EC-GRD-20 |
| **INV-GRD-12** | The banner utility row renders exactly the snooze, report and EMA slots, the string `Discuss` appears nowhere, and a snoozed item appears in zero sessions for the rest of that `local_day` while its `due_at` and `stability` are unchanged | U, C, P | EC-GRD-21 |
| **INV-GRD-13** | Tier 1 applies the **active pack's** `orthographic_equivalences` before compare. Falsifier: a shared or hard-coded equivalence map, or `heisst` failing while `ano` passes against `año` | P, U | EC-GRD-23 |
| **INV-GRD-14** | An answer with zero target-script characters against a script-only accepted set produces no verdict, no attempt row, no heart and no combo change, and exposes a word-bank escape | P, E | EC-GRD-25 |
| **INV-GRD-15** | The three typo guards resolve per pack, and for every shipped pack at least one single-edit slip is soft-corrected. Falsifier: a pack in which `You have a typo.` is unreachable for every item fails the build | P, C | EC-GRD-26 |
| **INV-GRD-16** | For a `spaceless` pack, any answer differing from an accepted form only in whitespace grades tier-1 correct with **no** note, and the whitespace channels are unreachable | P | EC-GRD-27 |
| **INV-GRD-17** | An answer whose reading equals an accepted form but whose surface does not is tier 2 on **every** occurrence, with zero mistake rows and no stateful escalation | P | EC-GRD-28 |
| **INV-GRD-18** | For a pack with `diacritics_contrastive`, the tier-2 diacritic class is empty and unreachable through any normalisation path | P, U | EC-GRD-29 |
| **INV-GRD-19** | `ja` tier-1 normalisation is one pure, documented, idempotent function; the dash-fold set is a named constant. Falsifier: `ｺｰﾋｰ`, `コ―ヒ―` and `コーヒー` do not collapse to one string, `珈琲` does, or a length-losing answer reaches tier 2 | P, U | EC-GRD-30 |
| **INV-GRD-20** | An answer matching an accepted answer's lexemes but not the unit's declared register emits verdict class `register` with its own headline, never the wrong-word headline | P, U | EC-GRD-31 |
| **INV-GRD-21** | For a pack declaring `register_slot`, a reply failing the register detector still grades correct and emits exactly one advisory note across all three grading paths, with zero mistake rows and no heart loss | P | EC-GRD-32 |
| **INV-GRD-22** | Read-and-respond length and keyword gates are pack-declared, and the keyword test accepts every taught inflection of a required lexeme. Falsifier: `行きました` failing a `行く` gate on the fallback path | P, C | EC-GRD-33 |
| **INV-GRD-23** | Word-bank grading is a function of tapped tile ids alone, with a pack-declared join delimiter. Falsifier: the verdict changes when the rendered gap changes, or U+0020 enters a `ja` answer string | P | EC-GRD-34 |
| **INV-GRD-24** | The multi-character select type is order-sensitive, CHECK-gated, and costs at most one heart and one mistake row per item, never on an intermediate tap | P, E | EC-GRD-35 |
| **INV-GRD-25** | An intra-language orthography match updates only the reading item's scheduler row. Falsifier: matching `学校` with `がっこう` advances the meaning item's due date or strength meter | P | EC-GRD-37 |
| **INV-GRD-26** | Listening answers in a `no_word_delimiter` pack are compared as baked readings with no runtime NLP, and a build gate rejects two same-reading taught lexemes in one unit | P, C | EC-GRD-38 |
| **INV-GRD-27** | The alternate-solution note fires iff the matched surface ranks below an already-introduced surface. Falsifier: a Section-1 kana answer displaying a kanji the learner has never been taught | P | EC-GRD-39 |
| **INV-GRD-28** | For `no_word_boundaries` packs, no highlight range partially overlaps a ruby span and the wrong-word headline is unreachable. Grep gate: no Japanese tokenizer is linked into the app | P, C | EC-GRD-40 |
| **INV-GRD-29** | The punctuation-equivalence class is read from the unit declaration, never a global regex. Falsifier: `はいと言いました` accepted in a quotation-teaching unit | P, U | EC-GRD-42 |

## Combo, progress bar and interstitials

| id | Invariant | Kind | Covers |
|---|---|---|---|
| **INV-COM-07** | With `motivationalMessages` false, zero combo interstitials render for any combo sequence while combo state advances identically, and the difficulty step-up card renders in every run | P, S | EC-COM-10 |
| **INV-COM-08** | All interstitial producers emit into one queue whose render is a duplicate-free subsequence of `combo → step-up → mistake-review`. Falsifier: two interstitials in one frame, or mistake-review preceding step-up | P | EC-COM-11 |
| **INV-COM-09** | A soft-corrected answer that crosses a combo milestone renders the tier-2 note as the banner headline and still emits exactly one milestone interstitial | P, S | EC-COM-12 |
| **INV-COM-10** | For any sequence of modality skips the progress numerator equals correct answers and the denominator is constant, and no skip writes a mistake row | P | EC-COM-13 |
| **INV-COM-11** | Combo depends only on the ordered sequence of graded answers in the session. Falsifier: an interstitial or a main→mistakes queue transition that resets, freezes or fails to increment it | P | EC-COM-14 |
| **INV-COM-12** | Session flavour maps to at most one step-up escalation per session. Falsifier: a mixed lesson firing both pills, or the less-sound copy outside an audio-only flavour | P, U | EC-COM-15 |

## Mistake recycling

| id | Invariant | Kind | Covers |
|---|---|---|---|
| **INV-MIS-04** | A mistake retires only after two correct encounters in sessions **other than** the one that created it, from any surface, and any wrong answer resets the count. Falsifier: a single-miss lesson self-corrected on both replays that leaves the Mistakes card empty | P | EC-MIS-09 |
| **INV-MIS-05** | Every mistake row references an id present in the ledger, and one wrong answer creates at most one row. Falsifier: a Japanese miss inflating the hub count threefold against Spanish | P | EC-MIS-10 |
| **INV-MIS-06** | For every runtime eligibility state the recycle ladder terminates with a served item, and the session never reaches `complete` with a pending mistake | P | EC-MIS-11 |
| **INV-MIS-07** | Every recycle target comes from the type's declared map and preserves the missed item's id for FSRS; Trace is never a target | P, C | EC-MIS-12 |
| **INV-MIS-08** | Weak-item rows never enter the mistake queue and never change the accuracy denominator, yet always reach the hub as a recognition item. Falsifier: eleven rejected strokes leave the grapheme unscheduled | P | EC-MIS-13 |

## Modality and audio availability

| id | Invariant | Kind | Covers |
|---|---|---|---|
| **INV-MOD-08** | An output-route change pauses and re-offers playback, leaves the item ungraded and unattempted with replay controls live, and **never** writes the suspension record | P, E | EC-MOD-17 |
| **INV-MOD-09** | An attempt with sub-floor amplitude or an empty transcript produces `review_kind = no_audio`, leaving accuracy and the failure counter unchanged; after the third, the remaining queue contains zero production-speaking items | P | EC-MOD-20 |
| **INV-MOD-10** | A simulated audio-session or route error never maps to permission-denied copy and never arms the suspension. Falsifier: a suspension armed after two transient failures the learner never chose | P, U | EC-MOD-23 |
| **INV-MOD-11** | Toggling any modality preference never changes the set, order or count of path nodes; an authored story's element stream and `getVisibleStoryLength` are byte-identical with listening on and off; and every gated node's popup exposes a working re-enable | P, S | EC-MOD-25 |
| **INV-MOD-12** | The gate-cause function is total over `{preference-off, suspended, mic-denied, no-content, no-recogniser-for-locale}` with distinct copy and no no-op action, and a device with no recogniser for the pack locale still reaches full unit completion. Grep gate: `androidTriggerOfflineModelDownload` is reachable only from its Settings row | P, U, C | EC-MOD-26 |
| **INV-MOD-13** | Every speaking item ships a **pre-tokenised** expected transcript in the pack, in the unit `ledger_unit` declares (INV-PACK-40); the grader computes token F1 against those stored tokens at the declared threshold, and falls back to character-level similarity when recogniser output cannot be aligned. Grep gate: the bundle links **no** tokenizer or morphological analyser. Falsifier: an item whose stored token array is absent or derived at runtime, or a kana transcript of a kanji reference scoring below acceptance | P, C | EC-MOD-27 |
| **INV-MOD-14** | Numeral and counter-reading folding runs before scoring, so `3本`, `三本` and `さんぼん` are one token on typed and spoken paths alike | P, U | EC-MOD-28 |
| **INV-AUD-05** | An audio-bearing item with zero learner interaction for the idle threshold exposes the inline listening gate, and no first attempt on such an item yields a wrong verdict before a replay event is recorded | P, E | EC-MOD-19 |
| **INV-AUD-06** | Voice availability is probed at pack activation and cached per BCP-47 tag; no speak call is ever issued carrying target-language text on a non-matching voice | P, U | EC-MOD-22 |
| **INV-AUD-07** | Highlight lag never exceeds one keypoint interval on any aligned line. Falsifier: a 1.4 s seven-keypoint line whose highlight advances in fewer than six steps or lands >120 ms late | P, D | EC-STO-25 |
| **INV-AUD-08** | Every packed clip measures within a declared tolerance of the target loudness, and the re-bake key includes the synthesis **engine** as well as the voice | C | EC-PACK-52 |

## Path

| id | Invariant | Kind | Covers |
|---|---|---|---|
| **INV-PATH-10** | After a section-complete return the rendered canvas contains only the new section's nodes, with its first node inside the declared scroll band. Falsifier: a return leaving the previous section's nodes scrollable above | S, E | EC-PTH-23 |
| **INV-PATH-11** | At every scroll offset of a multi-unit section exactly one header is rendered pinned. Falsifier: a fling-scroll screenshot series showing two stacked headers, or none, during a range crossing | S | EC-PTH-24 |
| **INV-PATH-12** | The guidebook route id equals the **pinned** header's unit id at every scroll position, access is a pure function of unit index vs current index, dismissal restores the entry offset, and the whole surface writes zero scheduler rows. Falsifier: open an unreached unit's guidebook, tap every speaker, assert the FSRS table is byte-identical | P, E | EC-PTH-25 |
| **INV-PATH-13** | A jump-here node exists iff its target unit is locked, and the rendered offsets of every node below are byte-identical before and after its removal | P, S | EC-PTH-26 |
| **INV-PATH-14** | Over any generated session history the demotion offer fires at most once per node and at most once per 7 local days. Falsifier: a simulated 20-session day of ordinary variance producing two prompts | P | EC-PTH-29 |
| **INV-PATH-15** | From every reachable path state and every goal tier, a streak-extending session no longer than that tier's exercise budget is reachable in ≤2 taps, or the blocking node exposes a defer control. Falsifier: a Casual learner whose only unplayed node is a 15-exercise Unit Review | P, E | EC-PTH-33 |
| **INV-PATH-16** | The unit-legendary predicate folds only over node types that declare a LEGENDARY offer, against a pack-declared denominator. Falsifier: a unit whose chest or story node makes the trophy unreachable | P, C | EC-PTH-34 |
| **INV-PATH-17** | Every value of the session-flavour enum is reachable from at least one shipped entry point, and `sectionTest` resolves to the section-boundary variant of the JUMP HERE node (S019) rather than a node type of its own. Falsifier: enumerate the flavour enum against launchable entry points and find one with none, or a second component rendering a section test | U, C, E | EC-PTH-35 |
| **INV-PATH-18** | Every node type declares a completed-popup shape whose buttons map only to flavours that node can launch. Falsifier: a story node offering the practice flavour, or a node type falling through to the lesson popup | U, S | EC-PTH-36 |
| **INV-PATH-19** | Every generated node has a completion path on the device that generated it. Falsifier: build a path with the LLM capability stubbed absent and find a Roleplay node, or a changed node count per unit | P, E | EC-PTH-37 |
| **INV-PATH-20** | The section fraction counts only units with every node complete, and `unitCompleted` fires only on an incomplete→complete transition. Falsifier: a section rendering 100% with an unearned trophy | P | EC-PTH-38 |
| **INV-PATH-21** | Completion predicates fire only on a state transition, and the post-ceremony viewport equals the launching viewport. Falsifier: re-practise a node in a finished Section 1 and observe a section-complete screen or a jump to the current section | P, E | EC-PTH-39 |
| **INV-PATH-22** | Every section-level Score reading is a clamp of the single course Score into that section's band, and is non-decreasing. Falsifier: a pack update that adds items lowers a section's displayed number | P | EC-PTH-40 |
| **INV-PATH-23** | No placed node points backwards, and a Unit Rewind pays at most once per unit per `local_day` regardless of entry point. Falsifier: run the hub recommendation then tap the path entry the same day and observe a second XP commit | P, E | EC-PTH-41 |
| **INV-PATH-24** | Every node type any shipped pack can declare has a `PathNode` variant with locked/active/complete art and declared geometry. Falsifier: enumerate pack-declared node types against the component registry and find `letters` missing | U, C | EC-PTH-42 |
| **INV-PATH-25** | The legendary offer never fires on a script node, and unit-trophy eligibility ignores letters levels. Falsifier: complete every non-letters level of a `ja` unit and the trophy stays grey | P, E | EC-PTH-43 |
| **INV-PATH-26** | After any placement or passed jump-here, the set of unintroduced `script_unit`s appearing in a served item is **empty**, and every letters node remains reachable and required. Falsifier: a Section-2 jump producing a path with zero grapheme rows seeded | P, E | EC-PTH-44 |

## Ceremony

| id | Invariant | Kind | Covers |
|---|---|---|---|
| **INV-CER-10** | `legendaryTakeoverEligible` is false after two consecutive declines on a course until a section boundary or an accepted run, while the popup LEGENDARY button stays enabled. Falsifier: a ten-node decline run rendering ten takeovers | P, E | EC-CER-17 |
| **INV-CER-11** | `exposure_fraction` strictly increases over any session with ≥1 graded item while `mastery_score` is non-decreasing forever. Falsifier: a 30-session casual-run fixture in which the Score screen fires on <90% of sessions | P | EC-CER-18 |
| **INV-CER-12** | A back press on each screen of the canonical chain leaves the rendered screen and the reward ledger unchanged. Falsifier: a back press that re-renders the chest screen or reaches the path before the final CONTINUE | E | EC-CER-19 |
| **INV-CER-13** | The committed ledger after `Skip all` is byte-identical to the ledger after tapping through, and every one-time screen still renders. Falsifier: a skipped chain that swallows the streak-milestone screen | P, E | EC-CER-21 |
| **INV-CER-14** | The S5 predicate renders the picker at most once per streak run and becomes permanently false after two un-picked presentations via a `DECLINED` sentinel distinct from null. Falsifier: a 30-session trace rendering the picker a third time, or any ceremony screen whose only control is disabled with no dismiss path | P, E | EC-CER-22 |
| **INV-CER-15** | The resolved S1b layout renders exactly **two** tiles at every supported width and font scale, and no `CeremonyTile` variant declares a time or COMMITTED slot | S, U | EC-CER-23 |
| **INV-CER-16** | Every Score-chain screen's primary CTA resolves to the `macaw` token. Falsifier: an S3 CONTINUE rendered with the `owl` green token | S | EC-CER-24 |
| **INV-CER-17** | A Score tick-over and a CEFR band crossing together contribute exactly one entry at the Score slot, and over any session sequence the count of band beats equals the number of band boundaries crossed | P, S | EC-CER-28 |

## The day boundary

| id | Invariant | Kind | Covers |
|---|---|---|---|
| **INV-DAY-13** | Weekday-keyed achievement and quest predicates are computed over the set of **lived** local days, are idempotent under a duplicated civil date and unchanged by an unlived one. Falsifier: a date-line fixture that resets or double-awards Weekend Warrior | P | EC-STK-22 |
| **INV-DAY-14** | For any first-ever session whose local day precedes the build date, no day-keyed reward is granted until a sane clock is observed, and the subsequent rollover consumes at most one freeze. Falsifier: a 1970 install that mints a goal chest then walks 20,000 civil days | P | EC-STK-23 |
| **INV-DAY-15** | The credited day is written **once** at the S1a commit as `credited_local_day` under the `session_id` idempotency key, derived from monotonic elapsed plus the start civil date; every later rollover reproduces it. Property: the credited day and applied boost multiplier are invariant under any wall-clock perturbation injected mid-session | P | EC-STK-24 |
| **INV-DAY-16** | Over any 400-day virtual-clock trace in the four-zone matrix, monthly settlements equal the count of distinct `YYYY-MM` values in the processed local-day set. Falsifier: a date-line hop over the 1st that skips or doubles a settlement | P | EC-STK-25 |
| **INV-DAY-17** | `local_day` is identical for every `tz_id` string sharing one offset, `Etc/GMT-5` and `UTC` included, and `tz_source` is recorded. Falsifier: a stored day that shifts when the identifier changes while the offset does not | P | EC-STK-26 |

## Freeze and recovery

| id | Invariant | Kind | Covers |
|---|---|---|---|
| **INV-FRZ-05** | Each civil day's rollover decision is one exclusive transaction over `(freeze decrement, day disposition, last_processed_day)`, with the ledger keyed by the day it covers so replay is a no-op. Falsifier: injecting a kill after every write in a three-day walk yields a double-decrement | P | EC-FRZ-14 |
| **INV-FRZ-06** | Every grant clamps to `cap − held`, and a zero-effect grant produces no ceremony screen and no copy. Falsifier: a day-1 fixture at 2/2 writing a third freeze, raising the cap, or rendering freeze-gift copy with no balance change | P, S | EC-FRZ-17 |
| **INV-REC-04** | The recovery window is two **local days** from `broken_on`, and expiry leaves no resumable challenge row and no restored streak. Falsifier: complete one of three lessons, advance three local days, and still find the challenge live | P, E | EC-FRZ-15 |
| **INV-REC-05** | Recovery eligibility is a function of session **start** time only, and lesson XP plus attempt rows commit identically whether the challenge succeeds, lapses or is abandoned. Falsifier: a lesson started inside the window refused credit at completion | P | EC-FRZ-16 |
| **INV-REC-06** | Recovery is armed iff the break is inside the recency window and the count of missed days **not covered by a freeze** is inside the cap. Falsifier: a three-date gap with two freezes spent that declines the offer | P | EC-FRZ-18 |
| **INV-REC-07** | A restore repaints exactly the uncovered broken dates as `recovered`, increments the streak by at most one lived day, and fires at most one milestone screen. Falsifier: any restore path that vaults the number past a milestone without landing on it | P, S | EC-FRZ-19 |

## Economy

| id | Invariant | Kind | Covers |
|---|---|---|---|
| **INV-ECO-16** | Total XP from failed legendary attempts on one node in one `local_day` never exceeds the single checkpoint award, and no challenge progress is retained between attempts. Falsifier: ten checkpoint-abandon runs yielding ten awards | P | EC-PTH-27 |
| **INV-ECO-17** | The flavour matrix carries a `mistake_allowance` column for every flavour — jump-here 5, section test 4, Legendary a named constant — rendered as **pips**, and no test surface instantiates the hearts resource. Grep + property gate: no test renders the heart glyph, the refill modal or a purchase sheet; the pip counter is destroyed at test end; the header meter reads infinity throughout | P, U, C | EC-PTH-28 |
| **INV-ECO-18** | Boosts granted from Daily Refresh over any 400-day clock-tampered span equal the number of distinct `local_day`s on which the final level was completed, and legendary state on a Daily Refresh level clears with the set | P | EC-PTH-30 |
| **INV-ECO-19** | The session-flavour matrix is keyed `(flavour, outcome)`, and every gated flavour's failed row declares `extends_streak = false` plus a non-empty consequence string and route. Falsifier: a failed jump-here returning silently to the path on an otherwise empty day | U, C | EC-PTH-32 |
| **INV-ECO-20** | Every committed session row carries a non-null `active_ms` written in the same exclusive transaction as XP, it never advances while backgrounded or modal, and every minutes-shaped string reads it. Falsifier: a weekly-report figure derived from wall-clock session spans | P, U | EC-ECO-23 |
| **INV-ECO-21** | `goalMet ⟺ earnedXP >= goalXP` for every tier and flavour, and no progress-indicator string carries a minutes unit. Falsifier: a flat-10-XP Practice session leaving a 10 XP goal unmet, or a bar reading `5/5 min` | P, U | EC-ECO-24 |
| **INV-ECO-22** | Monthly badge rows are keyed by the `YYYY-MM` of `max_local_day_seen`, the target is derived once at month start, and a rollover archives the prior tier and arms a summary. Falsifier: a clock or zone move across a month boundary that mints, destroys or silently discards badge progress | P | EC-ECO-25 |
| **INV-ECO-23** | Over any 30-day simulated history the number of personal-record celebrations is ≤ `ceil(days/7)` and zero of them appear in the ceremony chain. Falsifier: twelve consecutive record days producing twelve cards | P | EC-ECO-27 |
| **INV-ECO-24** | Grep gate over the shipped bundle: `Super`, `Max`, `No ads`, `unlimited hearts`, refill and price strings appear nowhere, and the heart chip routes to the honest sheet | U, C | EC-ECO-29 |
| **INV-ECO-25** | Every achievement names a counter that exists in the schema and is incremented by at least one reachable event. Grep gate: `crown` and `skill` appear in no achievement config. Falsifier: a grid row whose source column resolves to a mechanic the path lacks | U, C | EC-ECO-30 |
| **INV-ECO-26** | The achievement grid contains no permanently unearnable row: an achievement whose every incrementing surface is disabled in the shipped config is **not rendered**. Falsifier: Challenger rendered at 0/40 with no timed-challenge surface enabled | P, U | EC-ECO-31 |
| **INV-ECO-27** | Exactly two word counters exist, `words_learned ≤ words_introduced` always, every word-shaped surface reads one of them, and both count only `countable: true` ledger items. Falsifier: a third ad-hoc count computed at render, or a `ja`-only and an `es`-only fixture with equal taught vocabulary reporting different Scholar tiers | P, U | EC-ECO-32 |
| **INV-ECO-28** | Every rendered achievement has a non-empty ascending threshold ladder whose first tier is reachable under the installed packs. Falsifier: a badge with a null denominator, or a structurally-zero counter still rendered | U, P | EC-ECO-33 |
| **INV-ECO-29** | Strategist fires only on a guidebook-open followed by a completed session in the same unit within the same local day. Falsifier: the badge earned by opening the guidebook alone | P | EC-ECO-34 |
| **INV-ECO-30** | The flavour matrix carries an explicit `boost_applies` value for every flavour including Daily Refresh sub-flavours, the multiplier applied equals the configured one exactly when flagged, and the XP tile colour agrees with the applied multiplier. Falsifier: a purple tile on a story replay | P, U | EC-ECO-35 |
| **INV-ECO-31** | Equipping a cosmetic changes only `MascotRenderer` parrot output plus the snapshot field, leaving cast and story avatar assets byte-identical, and a missing variant renders the neutral pose | P, S | EC-ECO-36 |
| **INV-ECO-32** | Story and radio XP come from one four-key config table per format, and the advertised number equals the committed number for every entry point. Falsifier: a scalar `sessionXP(story)` literal, or six story replays paying first-completion XP | P, U | EC-ECO-37 |
| **INV-ECO-33** | A lesson whose scorable set contains no punitive item never increments Sharpshooter. Falsifier: re-running one kana Letters node 100 times unlocks tier 5 while accuracy is formally undefined | P | EC-ECO-40 |

## Scheduler

| id | Invariant | Kind | Covers |
|---|---|---|---|
| **INV-SCH-07** | An item with an open report is generated zero times within 7 local days and accrues zero elapsed over the window. Falsifier: the reported item returning the same afternoon, or reading as a lapse on dismissal | P | EC-SCH-08 |
| **INV-SCH-08** | For any disable-then-enable interval the due set on re-enable equals the due set at disable time advanced by **zero** elapsed for held items. Falsifier: three days with listening off producing a several-hundred-item backlog | P | EC-SCH-09 |
| **INV-SCH-09** | Displayed Score is non-decreasing over any 400-day sequence of reviews, absences, zone changes and clock moves. Falsifier: three days offline lowering the Score chip or the Score fraction | P | EC-SCH-10 |
| **INV-SCH-10** | Over any local day, first-exposure items never exceed `max_new_items_per_local_day`, and no lexeme reaches a production type within `min_hours_between_introduction_and_production` of its introduction. Falsifier: a recognition-then-production pair inside one sitting | P | EC-SCH-11 |
| **INV-SCH-11** | FSRS rows are keyed `(item, surface)`, and no item renders or credits a surface with no prior introduction beat | P | EC-SCH-12 |
| **INV-SCH-12** | No ruby-on encounter changes a grapheme item's `stability` or `due_at`. Falsifier: twelve ruby-on encounters of `学校` taking `学` to full strength | P | EC-SCH-13 |

## Practice Hub

| id | Invariant | Kind | Covers |
|---|---|---|---|
| **INV-HUB-06** | No hub flavour's XP-per-exercise exceeds the path lesson rate, and a node untouched for ≥3 local days is promoted into the hero slot. Falsifier: a simulated 30-day hub-only run that advances streak, quests and gems while path position and Score never move | P | EC-ECO-28 |
| **INV-HUB-07** | Words ordering under `Recently learned` is invariant under elapsed time, and the comeback surface fires exactly once per gap of ≥3 local days. Falsifier: a four-day-gap fixture whose Words list reorders, or presents faded bars with no action | P, S | EC-HUB-07 |
| **INV-HUB-08** | The offered Unit Rewind unit maximises aggregate overdue-ness over completed units, excluding the current one and any offered within 7 local days. Falsifier: the freshly finished unit offered while an older, more overdue unit exists | P | EC-HUB-08 |
| **INV-HUB-09** | The hero resolves to a launchable session or the cold-state card for **every** reachable eligibility vector. Falsifier: any vector of preferences, mistake count and consumed slices producing an empty hero or a START that launches nothing | P, E | EC-HUB-09 |
| **INV-HUB-10** | The hub rendered after an in-tab course switch is identical to a cold entry with that course active. Falsifier: a Maestro run capturing one frame carrying the previous course's mistake count or hero | E, S | EC-HUB-10 |
| **INV-HUB-11** | Every Words row renders all four fields with non-empty content for every item kind, and the row count equals the introduced ledger items of every class for the active course. Falsifier: a kana-only course with a blank gloss column, or two weeks of Japanese producing a list with no particle row | P, S | EC-HUB-11 |
| **INV-HUB-12** | Words sort options are pack-declared data (label + comparator), and the `ja` comparator is gojūon over `reading_form`. Falsifier: a codepoint-order comparator reachable for a `ja` pack | U, P | EC-HUB-12 |
| **INV-HUB-13** | The tab set is identical for every installed pack while the hub row set is pack-driven. Falsifier: a tab that appears or vanishes on course switch, which also breaks widget and notification deep links | S, E | EC-HUB-13 |

## Stories and Radio runtime

| id | Invariant | Kind | Covers |
|---|---|---|---|
| **INV-STO-07** | Entering a graded session pauses Radio, persists its position and releases the lock-screen session; Radio never auto-resumes | P, E | EC-STO-20 |
| **INV-STO-08** | Backgrounded playback never stalls on a question card and never awards completion credit: XP equals the plain replay tier unless challenges were answered, FSRS writes equal the answered-challenge count, each anchor fires at most once per run regardless of scrub position, and the listening-mode entry point renders iff `baked_audio_complete` is set. Falsifier: a locked-screen playthrough minting episode XP, or scrubbing back past an answered anchor for a second attempt row | P, E | EC-STO-21, EC-STO-24 |
| **INV-STO-09** | Ruby spans render identically in legendary and normal runs of the same story. Falsifier: snapshot a kanji line in both modes and find the ruby differs | S | EC-STO-26 |
| **INV-STO-10** | Every Listen-and-Select tile is exactly one pack-flagged Mode-C content token, never a particle or suffix, and a tap credits the Mode-A morphemes it spans. Falsifier: a grid built over `国家公務員` yielding one tile with three FSRS updates, or a grid of `は ます の` | P, C | EC-STO-27 |

## Course management

| id | Invariant | Kind | Covers |
|---|---|---|---|
| **INV-CRS-03** | `Reset progress` deletes exactly the removal row set while the pack and every account-region counter stay bit-identical, and no `session_state` row survives. Falsifier: a reset that drops the pack or changes gems | P, E | EC-CRS-08 |
| **INV-CRS-04** | The status bar has the same chip count and x-positions for every installed course regardless of Score state. Falsifier: a flag-switch screenshot pair in which the flame or gem chip moves | S | EC-CRS-09 |

## Persistence and data

| id | Invariant | Kind | Covers |
|---|---|---|---|
| **INV-PER-08** | With free space below the backup requirement, schema and `user_version` are unchanged after launch, and the blocking screen still exposes export and audio removal. Falsifier: any DDL executed without a verified backup file on disk | P, E | EC-PER-14 |
| **INV-PER-09** | After any speaking item completes, is skipped, or is killed mid-record, **zero** files remain under the recording directory, and recordings appear in the export and delete-all enumerations | P, E | EC-PER-17 |
| **INV-PER-10** | Device gate: the on-device backup manifest lists only the checkpointed DB file and stays inside the platform quota. Falsifier: a manifest containing a pack file or a `-wal` sibling | D | EC-PER-18 |
| **INV-PER-11** | Display preferences live in a `course_display` region keyed by `course_id`, so two courses can hold different furigana values simultaneously. Falsifier: a single global row, which also breaks INV-ECO-04's two-region schema gate | U | EC-I18N-11 |
| **INV-DAT-05** | After importing an archive with a future `max_local_day_seen`, the next completed session on an honest clock still increments the streak and opens its chests. Falsifier: any day-keyed reward suppressed by an imported value | P, E | EC-PER-15 |
| **INV-DAT-06** | Immediately after an import, no pending notification or widget entry derives from pre-import state. Falsifier: a danger nudge naming the pre-import streak, or the old flame still rendered, within the next 7 days | P, E | EC-PER-16 |
| **INV-DAT-07** | Deleting the `-wal` from a fixture DB is detected as an **incomplete restore** rather than opened silently, and every export/backup path checkpoints first. Falsifier: the app continuing normally after losing uncheckpointed sessions | P, E | EC-PER-19 |
| **INV-DAT-08** | Import never opens a `content://` URI directly and fails before the pre-import backup when space is short. Falsifier: an import that errors opaquely halfway on a cloud-picked archive | P, E | EC-PER-21 |
| **INV-DAT-09** | Import never writes any economy-config field and never resolves a pack id absent from this build, and the manifest is parsed without opening the dump. Falsifier: an archive whose config raises the running app's freeze cap | P, U | EC-PER-22 |
| **INV-DAT-10** | For any syntactically valid archive with arbitrary field values, post-import state is within declared ranges, `max_local_day_seen ≤ today`, achievements are recomputed from counters, and the next session still grants its goal chest | P, E | EC-SEC-07 |

## Content packs

| id | Invariant | Kind | Covers |
|---|---|---|---|
| **INV-PACK-17** | Every sentence, voice and derived list whose licence requires attribution is reachable from the rendered credits surface (S152), itself reachable from the report sheet (S045) and About (S137). Gate: an attribution-requiring asset with no reachable credit fails the build | C, E | EC-PACK-56 |
| **INV-PACK-18** | A pack's signature is verified **before install**, and an invalid signature maps to the distinct `unverified` state with its own copy and re-download action — never `corrupt`. The pack enum is six-valued and every surface renders all six | P, E, C | EC-PACK-57 |
| **INV-PACK-19** | Every exercise-type string the node-type registry can emit has a declared state machine, heart cost and grading rule. Falsifier: `Build the character` reaching generation with no radical-decomposition source declared | U, C | EC-GRD-41 |
| **INV-PACK-20** | No minimal-pair item ships for a pack without `has_pitch_accent`, and the validator fails any speaking pair whose members share a kana reading. Falsifier: two baked clips for one pair that are acoustically identical | C | EC-MOD-29 |
| **INV-PACK-21** | For any radio node whose assets are missing, every downstream node's unlock state is identical to the intact-pack case, and Repair re-fetches only the missing files | P, E | EC-STO-22 |
| **INV-PACK-22** | MATCH validation compares Mode-A lemma ids against each line's precomputed segmentation and rejects any surface not yet introduced. Falsifier: `食べます` rejected as absent, or a bare `か` passing because it is a substring | C | EC-STO-28 |
| **INV-PACK-23** | Every selectable, hidden and hint range in a story resolves to a morpheme boundary, no range partially overlaps a ruby span, and ruby intersecting a hidden range is hidden with it | C | EC-STO-29 |
| **INV-PACK-24** | Deleting pack files while audio plays releases the player first and leaves the pack in `not-downloaded`, with no surface rendering the corrupt state. Falsifier: a hub showing the unavailable string after a voluntary delete | P, E | EC-PACK-20 |
| **INV-PACK-25** | CI gate: every gradable item ships a baked explanation string. Falsifier: validating a pack with any item missing one, or an e2e run on a no-model no-key device rendering a two-icon banner | C, E | EC-PACK-21 |
| **INV-PACK-26** | For a pack with `cefr_claim: null`, every CEFR-bearing surface renders its declared substitute and none renders an empty or templated-null band. Falsifier: any rendered string containing `CEFR` under such a pack | P, S | EC-PACK-22 |
| **INV-PACK-27** | An evicted installed pack resolves to `not-downloaded` on switch, and no fetch starts on a metered connection without an explicit confirm. Falsifier: a cellular fixture that auto-resumes a 38 MB download, or opens a lesson whose audio is absent | P, E | EC-PACK-23 |
| **INV-PACK-28** | A truncated asset is detected at first play and repaired by a single-file fetch. Falsifier: an item graded against a short or silent clip, or a whole-pack re-download triggered by one bad file | P, C | EC-PACK-24 |
| **INV-PACK-29** | A pack with no `romanization` manifest key fails the build, and every romanised string round-trips through the declared table. Falsifier: `si` and `shi` authored in one pack | C | EC-PACK-25 |
| **INV-PACK-30** | No isolated-character pronunciation item has subject は, へ or を, and every sentence-level reading matches a whole-sentence analysis rather than concatenated chart readings | C | EC-PACK-26 |
| **INV-PACK-31** | The audio manifest declares a `characters` section covering every taught kana, digraph and kanji reading with a per-clip reviewed flag. Falsifier: delete one kana clip and the baked-audio-complete flag is still granted | C | EC-PACK-27 |
| **INV-PACK-32** | Every match item declares `match_kind`, and all pairs in a grid share it. Falsifier: a grid mixing a kanji-kana pair with an English-Japanese pair passing the build | C | EC-PACK-28 |
| **INV-PACK-33** | V6 reads register from the **line kind**: answer spans and CHARACTER lines are checked against the unit's register, and PROSE lines against the story's **declared narrator register** (default masu) — no line kind is unchecked. Cast lines carry `receptive_only`, so no PROSE or CHARACTER verb enters the production lexicon at A1. Falsifier: a story with an undeclared narrator register passing the build, or a plain-form PROSE line passing under the masu default | C | EC-PACK-29 |
| **INV-PACK-34** | A taught-character ledger exists, and every story character is either taught or inside a forced-furigana span. Falsifier: placing `食べる` before its kanji's unit passes the build unmarked | C | EC-PACK-30 |
| **INV-PACK-35** | Across a major-version migration no completed node becomes incomplete and account-scoped state is bit-identical. Falsifier: migrate a fixture with 40 completed nodes and find node completion, streak, gems or achievements changed | P, C | EC-PACK-32 |
| **INV-PACK-36** | Every generated kana variant round-trips through the analyser to the same Mode-A morpheme sequence as the kanji form. Falsifier: `私は学生です` generating `わたしわがくせいです` | C | EC-PACK-33 |
| **INV-PACK-37** | No `ja` word-bank item admits a second KenLM-plausible order absent from its accepted set. Falsifier: an idiomatic reordering grading tier 3 | C | EC-PACK-34 |
| **INV-PACK-38** | A grapheme is a first-class ledger class with its own budget, and at every path position the union of glyphs in a node's items is a subset of the `script_unit`s introduced at or before it, unless ruby-forced and recognition-only. Falsifier: `学生` in unit 3 passing V1 with both glyphs untaught | C | EC-PACK-35 |
| **INV-PACK-39** | No `ja` clip ships whose ASR round-trip disagrees with the item's stored reading. Falsifier: `三本` baking as `さんほん` and passing the audit | C | EC-PACK-36 |
| **INV-PACK-40** | Every pack declares `ledger_unit` (Mode-A morpheme for `ja`, lemma otherwise) exactly once in its manifest, and **every** token-counting consumer reads it — `length_filter`, the new-item budget, V1/V2 and the stored speaking tokens. Each pack also declares its own window and budget, and the validator reports mean content-words-per-sentence per pack. Falsifier: a pack with no `ledger_unit`, a consumer with its own inlined notion of a token, or one shared window yielding a `ja` lesson that teaches three content words inside its budget | C | EC-PACK-37 |
| **INV-PACK-41** | Changing only a presentation field (ruby, audio hash, stroke path, illustration, accepted alternates, distractors) leaves every item id and FSRS row intact across a rebuild. Falsifier: a ruby re-solve of `今日` orphaning its strength meter and re-showing `NEW WORD` | P, C | EC-PACK-38 |
| **INV-PACK-42** | A script item with no confusable distractor is a build **failure**, not a warning. Falsifier: a `shi` item shipping with か, も, ぬ | C | EC-PACK-39 |
| **INV-PACK-43** | Every `ja` bank item declares its tile segmentation in the manifest, defaults to Mode C, and its tiles concatenate exactly to the accepted answer. Falsifier: an item splitting `飲みます` without an explicit override | C | EC-PACK-40 |
| **INV-PACK-44** | Each `ja` item carries a preferred variant keyed by exercise type, and the listening preferred variant contains no kanji. Falsifier: a build gate passing such an item | C | EC-PACK-41 |
| **INV-PACK-45** | Every `Type the word ending` item carries a reading-level split and either suppresses stem ruby or is excluded. Falsifier: `来ます` authored with visible `き` ruby over `来` | C | EC-PACK-42 |
| **INV-PACK-46** | The build exits non-zero naming every surface form with unresolved per-kanji furigana, and no code path derives ruby from a whole-morpheme `reading_form`. Falsifier: an unresolvable compound shipping with bare or mis-centred ruby | C | EC-PACK-43 |
| **INV-PACK-47** | Every Mode-A hint range projects onto exactly one Mode-C display token, and the projection is total over the pack. Falsifier: a CI sweep finding any hint range whose start or end falls inside a display token | C | EC-PACK-44 |
| **INV-PACK-48** | Every irregular counter reading is a distinct content-hashed ledger item. Falsifier: a lesson introducing 一本/三本/六本/八本 plus other new items passing the budget vacuously | C | EC-PACK-45 |
| **INV-PACK-49** | V6 requires the numeral cross-product on any item containing a number, and no runtime numeral rewriting exists. Falsifier: `3本` rejected for `三本`, `3ぼん` accepted, or a numeral map found in the app bundle | C, P | EC-PACK-46 |
| **INV-PACK-50** | The generator never routes a grammar-concept or `script_unit` item into a lexeme-quoting prompt type, and neither ever wears the `NEW WORD` pill | P, C | EC-PACK-47 |
| **INV-PACK-51** | No two distinct ledger items share a `(normalized_form, reading_form, POS)` key, and no two tiles in one item share a rendered label. Falsifier: `辛い` collapsing to one Words row, or a two-`本` bank with no disambiguating ruby | C | EC-PACK-48 |
| **INV-PACK-52** | Every `ja` sentence carries a kana `tts_reading`, and no `ja` fallback path speaks the display string. Grep gate over `Speech.speak` call sites | C, U | EC-PACK-49 |
| **INV-PACK-53** | Every `ja` listening sentence ships a second baked slow asset, counted in the declared audio budget. Falsifier: the turtle control playing a rate-shifted clip, or the build passing with one missing | C | EC-PACK-50 |
| **INV-PACK-54** | The build fails naming any pack codepoint absent from the bundled font subset, and the tofu report row carries codepoints plus resolved family. Falsifier: strip one kanji from the subset and the build still exits zero | C | EC-PACK-51 |
| **INV-PACK-55** | Every pack detail screen renders the engine fields recorded by INV-PACK-14 beside its wrong-item rate. Falsifier: a card showing a bare percentage with no grammar-engine, spellcheck-engine or alignment-validation line | S, C | EC-PACK-54 |
| **INV-PACK-56** | Completion copy, the section list and the Score ceiling are all functions of the pack manifest. Falsifier: a three-section beta rendering eight section cards, or completion copy contradicting a Score chip reading `29 / 160` | P, S | EC-PACK-55 |

## Widget

| id | Invariant | Kind | Covers |
|---|---|---|---|
| **INV-WID-08** | No widget state and no scheduled notification asserts streak risk on a `local_day` where `streak_extended_today` is true, whatever the XP. Falsifier: a 13 XP lesson against a 40 XP goal rendering NUDGE or DANGER, or arming a danger nudge | P, E | EC-WID-13 |
| **INV-WID-09** | The deep link is a pure function of the snapshot (including `has_resumable_session`) and honours the declared priority order, and **no** deep-link entry point creates, mutates or deletes a `session_state` row. Falsifier: a widget tap that silently clears a parked lesson, or starts a graded session without the guard sheet | U, E | EC-WID-14 |
| **INV-WID-10** | The widget state function is total over a missing, uninitialised or stale-stamped snapshot and maps it to the neutral `UNKNOWN` placeholder with no numeral; every cold foreground recomputes and rewrites the snapshot from the DB. Falsifier: an empty App Group container rendering `COLD` or a zero streak on a 212-day account, or a widget stuck in DANGER on a satisfied day | P, E | EC-WID-15 |

## Notifications

| id | Invariant | Kind | Covers |
|---|---|---|---|
| **INV-NOT-07** | No local notification is presented while `session_in_progress` is set, and the flag always clears within its declared bound (`maxRolloverDeferralSeconds = 300`). Falsifier: starting a lesson two minutes before the reminder instant and seeing a banner over the player | P, E | EC-NOT-09 |
| **INV-NOT-08** | After any sequence of reminder-time edits the pending set equals exactly one rolling schedule at the final time, with no entry in the past. Falsifier: twenty rapid edits producing duplicate pending entries | P | EC-NOT-10 |
| **INV-NOT-09** | No two pending notifications have fire instants within 10 minutes of each other, for any reminder-time × ladder-step pair. Falsifier: enumerate the product space and find both armed | P | EC-NOT-11 |
| **INV-NOT-10** | After any toggle sequence the delivered tray and the pending set both match the final toggle state exactly. Falsifier: a delivered danger nudge surviving the off toggle, or two schedules after ten toggles | P, E | EC-NOT-12 |
| **INV-NOT-11** | Grep + property gate: no scheduled notification body contains a rendered countdown or hour figure, and every danger notification carries a non-zero expiration | U, C, P | EC-NOT-13 |
| **INV-NOT-12** | With exact-alarm capability stubbed false, the scheduler enqueues **zero** danger nudges and exactly one inexact daily reminder, and Settings renders the exact-alarm row. Falsifier: a danger nudge scheduled on a device that cannot fire it on time | P, E | EC-NOT-14 |
| **INV-NOT-13** | With the permission callback stubbed to never fire, onboarding completes and the reminder row reaches the OPEN SETTINGS state within three foregrounds. Falsifier: CONTINUE disabled or spinning while permission is undetermined | E | EC-NOT-15 |
| **INV-NOT-14** | Template selection is a total order yielding exactly one winner per discretionary slot, never schedules both members of a declared mutually-exclusive pair on one local day, and cancels any notification whose motivating state a foreground resolved | P | EC-NOT-16 |
| **INV-NOT-15** | Notification-row state is a total function of `(app permission, channel importance, stored toggle)` with a distinct rendering for channel-blocked, and the scheduler enqueues nothing into a blocked channel. Falsifier: an ON toggle for a channel the OS is silently dropping | P, U | EC-NOT-17 |
| **INV-NOT-16** | Over a 30-day simulated trace no template repeats within 7 days, the goal-met pool never drops below six, and the fixed-time slot draws from more than the ladder families. Falsifier: a day-3-onward trace collapsing to two alternating strings | P | EC-NOT-18 |
| **INV-NOT-17** | CI property: every template in the pool is selected by at least one reachable `(learner-state, slot)` pair over an enumerated state sweep. Falsifier: `revive` selectable in zero states because slot 2 is suppressed whenever the streak is 0 | C, P | EC-NOT-19 |

## Accessibility, sound and haptics

| id | Invariant | Kind | Covers |
|---|---|---|---|
| **INV-A11Y-07** | With a screen reader active the combo announcements at 2, 6 and each milestone still fire when `Motivational messages` is OFF, and the bar exposes a `progressbar` role with `n of m` plus `n in a row`. Falsifier: turning that preference off loses every non-visual combo signal | E | EC-COM-17 |
| **INV-A11Y-08** | Every graded verdict state and the combo-gold transition renders a non-hue carrier under every combination of Reduce Motion, Sound off and an OS grayscale filter. Falsifier: a wrong picture-select card whose only difference from correct is fill colour | S | EC-A11Y-08 |
| **INV-A11Y-10** | With the screen-reader flag stubbed true, the timed challenge runs at the configured multiple of base duration, the untimed alternative is reachable in one tap from the pre-session card, and the timer pauses on background and on long announcements | P, E | EC-A11Y-10 |
| **INV-A11Y-11** | Any content mutated outside the focused element during an exercise emits an announcement containing the new text, and CHECK announces its enabled change. Falsifier: an accessibility-tree walk of `Complete the chat` where selecting an option produces no announcement | E | EC-A11Y-11 |
| **INV-A11Y-12** | With a screen reader flagged active, no recognition session starts while an announcement is in flight and none auto-starts on focus or screen entry. Falsifier: captured audio whose first second contains the synthesised prompt | P, E | EC-A11Y-12 |
| **INV-A11Y-13** | The accessibility-tree order of the path equals curriculum node order for every offset pattern, and contains zero unlabelled images. Falsifier: node *n+1* read before node *n* on the serpentine | E | EC-A11Y-14 |
| **INV-A11Y-14** | Every `Button3D` exposes exactly one accessibility element carrying label plus disabled state and a precondition hint, and under the OS high-contrast flag every disabled label-on-fill pair meets 3:1 from **declared tokens**. Falsifier: the inner visual view appearing as a second focusable node, focus moving on a lip transition, or the shipped pair surviving the flag at ~1.6:1 | E, S | EC-A11Y-15 |
| **INV-A11Y-15** | With a screen reader on, no degradation is explained only by an auto-dismissing toast. Falsifier: a Maestro accessibility run where the replacement exercise appears with no announced reason | E | EC-A11Y-16 |
| **INV-A11Y-16** | With Animations off and Reduce Motion on, a trace item still conveys full stroke order and stroke count. Falsifier: render under both toggles and find fewer than *N* ordinal markers, or no accept colour change | S, E | EC-A11Y-17 |
| **INV-SND-05** | For any burst of pair completions at most one answer-class cue plays per 120 ms, its pitch equals the pitch for the combo value at that instant, and haptics coalesce to one Success per exercise while a wrong pair keeps its immediate Error haptic | U, D | EC-COM-18 |
| **INV-SND-06** | The settings schema exposes an independent haptics key with no read of the sound-effects key, and with sound, animation and haptics all stubbed off every verdict still emits banner headline text. Falsifier: disabling Sound effects suppresses the correct-answer haptic | U, P | EC-A11Y-09 |
| **INV-SND-07** | One trace item emits exactly one success notification and one correct chime regardless of stroke count, with per-stroke ticks under the existing suppression window. Falsifier: a 12-stroke trace emitting twelve correct-answer stings in four seconds | U, D | EC-A11Y-18 |

## Typography and layout

| id | Invariant | Kind | Covers |
|---|---|---|---|
| **INV-TYP-06** | A window resize injected at any point of any exercise preserves option order, typed text and selected tiles, keeps the page free of horizontal scroll, and keeps the pair grid at two columns. Falsifier: a split-screen entry that orphans a word-bank placeholder or re-shuffles options | P, S | EC-TYP-07 |
| **INV-TYP-07** | At every font scale × supported width a match exercise renders 5 rows with both columns simultaneously present and no horizontal scroll. Falsifier: a single-column reflow or fewer than 5 pairs at AX5 | S | EC-TYP-08 |
| **INV-TYP-08** | At any font scale the feedback banner never exceeds 60% of viewport height, and the submitted answer stays on screen and in the accessibility tree. Falsifier: a full-viewport banner at AX5 hiding the learner's own answer | S | EC-TYP-09 |
| **INV-TYP-09** | The week strip renders exactly 7 day cells within viewport width at every font scale and exposes a full-week `accessibilityLabel`. Falsifier: a 5-column render or a clipped seventh circle at AX5 | S | EC-TYP-10 |
| **INV-TYP-10** | At every supported width and scale the lesson header is one row of fixed height and the progress track renders at or above its floor. Falsifier: a two-line header shifting the challenge area between items | S | EC-TYP-11 |
| **INV-TYP-11** | Each pill grows with font scale and appears in the accessibility tree with its label. Falsifier: an image-backed HARD EXERCISE badge fixed at scale 2.0, or absent from the tree | S, E | EC-TYP-12 |
| **INV-TYP-12** | Tile positions are identical before and after every tap at every font scale, and the bank stays inside the viewport. Falsifier: a grid that reflows when a tile is consumed at scale 2.0 | S | EC-TYP-13 |
| **INV-TYP-13** | At every scale a hint tooltip stays fully on screen and overlaps neither the answer strip nor CHECK, and legendary items expose no dotted underline. Falsifier: a clipped tooltip on the last line at scale 2.0 | S | EC-TYP-14 |
| **INV-TYP-14** | With Bold Text on, body and label weights stay two ladder steps apart and every uppercase label fits its CTA without horizontal scaling. Falsifier: CONTINUE overflowing its 582×50 button | S | EC-TYP-15 |
| **INV-TYP-15** | For any viewport at or above the reference width, measured node x-offsets and content widths equal the 614 px capture. Falsifier: an offset that varies with viewport width | S | EC-TYP-16 |
| **INV-TYP-16** | Over any generated course no two adjacent units share a colour, and the sequence is a pure function of the pack palette order. Falsifier: a course whose modulo cycle length aligns with a section boundary | P, S | EC-TYP-17 |
| **INV-TYP-17** | Line pitch in a `ja` pack is uniform across ruby-bearing and kana-only lines, the bubble tail anchor is stable, and tapping or removing any tile changes no row height and no CHECK Y position. Falsifier: a bubble mixing both line kinds showing unequal pitch | S | EC-TYP-18 |
| **INV-TYP-18** | `ruby_visible` is a total function of exercise type and span role. Falsifier: a `Select the correct characters` item rendering ruby over its own answer, or a `ja` legendary run rendering with ruby stripped | P, S | EC-TYP-19 |
| **INV-TYP-19** | No rendered CJK glyph run carries non-zero tracking or an uppercase transform, while Latin runs in the same label keep both. Falsifier: a snapshot showing 0.8 px gaps between every kana | S | EC-TYP-20 |
| **INV-TYP-20** | Every codepoint in a pack resolves to a **bundled** family, and uppercase transform and Latin tracking are never applied to kana. Falsifier: render the pack's glyph set and find any fallback to an OS family | S, C | EC-TYP-21 |
| **INV-TYP-21** | No rendered `ja` line begins with a forbidden-start character or ends with a forbidden-end character, on either platform. Falsifier: a fixture sentence whose natural break strands `。` at a line start | S | EC-TYP-22 |
| **INV-TYP-22** | The TIP table renders its pack-declared column count with ruby, without clipping or overlap, at every font scale. Falsifier: a three-column counter tip forced into two columns, or ruby overflowing the body line box | S | EC-TYP-23 |
| **INV-TYP-23** | The introduction chip string is a total function of the introduced item's class, and no item renders a chip contradicting its class. Falsifier: a counter or particle introduction labelled `NEW WORD` | P, S | EC-TYP-24 |

## Internationalisation and input

| id | Invariant | Kind | Covers |
|---|---|---|---|
| **INV-I18N-03** | For every typed-production item, the set of characters in its accepted answers minus the active keyboard layout is empty, or the accent bar is mounted with exactly those characters. Falsifier: an `es` item containing `ñ` presented under an `en-US` layout with no accent bar | P, S | EC-GRD-18 |
| **INV-I18N-04** | Under `ar-EG` and `fa-IR` every rendered chrome digit is Latin and every pack string is byte-identical to its pack value, the widget process included. Falsifier: Eastern Arabic digits in TOTAL XP, or a normalised answer differing from the authored string | P, S | EC-I18N-04 |
| **INV-I18N-05** | While a composition is live, no CHECK, close or tile-pop handler receives the event. Falsifier: typing romaji through a synthetic IME and pressing Return once grades the item | P, E | EC-I18N-06 |
| **INV-I18N-06** | For a pack with `requires_ime` the rendered keymap contains zero single-digit bindings and no card renders a numeric badge; Return is gated on `isComposing === false`. Falsifier: pressing `3` during candidate selection inserts bank tile 3 | U, E | EC-I18N-07 |
| **INV-I18N-07** | Hepburn and kunrei spellings of one word produce identical kana, and the grader receives no Latin characters. Falsifier: a grader unit test in which a romaji string reaches tier 1 | P, U | EC-I18N-08 |
| **INV-I18N-08** | With no target-script input source the generator emits zero typed-production items for that pack, no ungradeable text field renders, and keyboard mode never persists across a session boundary. Falsifier: a Japanese typed item appearing on an English-keyboard-only device | P, E | EC-I18N-09 |
| **INV-I18N-09** | Every target-language run carries a language tag taken from the **pack**, never the device locale, across bank, Words list and widget. Screenshot gate: the divergent glyphs 直 令 骨 今 次 海 rendered on an `en-US` Android device diff clean against the KanjiVG outline | S, U | EC-I18N-10 |
| **INV-I18N-10** | After an interface-language change no surface still renders the previous language, pending notifications and the widget snapshot are rewritten, and a missing pack L1 track never silently falls back to untranslated target text | P, E | EC-I18N-12 |

## Security, platform and on-device models

| id | Invariant | Kind | Covers |
|---|---|---|---|
| **INV-SEC-04** | Over a corpus of injection strings the grader never returns pass for an answer failing the deterministic length or required-lexeme gate, and any non-schema model response yields the deterministic verdict. Falsifier: an override instruction flipping a deterministic fail to a pass | P | EC-SEC-05 |
| **INV-SEC-05** | Every stored `item_report` row is reachable, withdrawable and export-gated from the settings tree. Falsifier: write a report and find no settings screen lists it | U, E | EC-SEC-08 |
| **INV-SEC-06** | The settings tree is declared as data with exactly the four S129 groups (Account, Courses, Data, About), and a snapshot asserts no Privacy, Support, subscription or billing row renders. Falsifier: a fifth group, or an empty Privacy screen re-added for symmetry | U, S | EC-SEC-09 |
| **INV-PLAT-09** | For any audio-session interruption injected at any point of a recording, the item returns to idle, the consecutive-ASR-failure counter is unchanged, and the pre-mic audio mode is restored. Falsifier: an interruption that increments the failure counter or leaves the category set to record | P, D | EC-MOD-18 |
| **INV-PLAT-10** | Keyboard shortcuts are focus-scoped and Return is edge-triggered with a declared debounce. Falsifier: two synthesised Returns inside the window advancing two steps, or a digit press with a focused text input selecting an option | P, U | EC-PLAT-14 |
| **INV-LLM-03** | EMA renders four non-empty parts for every banner verdict class including soft-correct, and does not render when no answer string was submitted. Falsifier: a soft-correct EMA saying `you were right`, or omitting a slot | P, U | EC-GRD-22 |
| **INV-LLM-04** | With the on-device model stubbed to never resolve, every LLM affordance reaches a terminal state within the declared timeout constant. Falsifier: a spinner still on screen after it elapses, or a Roleplay conversation opened that cannot reply | P, E | EC-PLAT-15 |
| **INV-LLM-05** | For any item with baked text the rendered explanation equals that text byte-for-byte regardless of model availability, and a model-generated explanation is stable across taps via an item-id cache. Falsifier: two different strings for the same item id in one session | P, U | EC-PLAT-16 |
| **INV-LLM-06** | Reachability is evaluated at **tap time**, not render, so the control's presence never flickers; with a key, no network and no baked text, the tap resolves within a bounded time to the authored note plus provenance. Falsifier: a spinner, an empty sheet, or a queued request | P, E | EC-PLAT-17 |
| **INV-LLM-07** | No `ja` model reply renders without passing the pack's suffix gate, and no tokenizer is linked into the app. Falsifier: stub the model to return a plain-form sentence in a masu unit and the reply renders instead of the baked explanation | P, C | EC-PLAT-18 |
