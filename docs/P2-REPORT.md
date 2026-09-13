GATE: RED

# P2 — Spanish pack v0: round 5

Checkpoint: 2026-09-13 UTC. Integrated source:
`fca9a57bb0203fc52084c97f09aec5d582bc8d6e`.
P0/P1 are green; P3-P8 have not started. The mobile entry point remains a database
persistence smoke test. Historical reports are preserved as `P2-REPORT-round1.md`,
`P2-REPORT-round2.md` and `P2-REPORT-round3.md`; round-4 evidence is recorded in
`P2-TAKEOVER.md` and `content/es/review/history/p2-round4/`.

## Current gate finding

The first round-5 generated population is RED. A manual actual-output audit found
exercise `928d15b151d72b50`, source `d0ba32e53702070e`, unit 3 / lesson 15:
`Yo ____ una lengua.` accepts `hablo` and offers `Habla`, `Hablaba` as wrong options.
`Yo hablaba una lengua` is grammatical without a tense or translation cue. The guard
incorrectly treated incomplete corpus person attestations as exhaustive proof.
Evidence: `/private/tmp/p2r5-g7-cloze-counterexample.json` and
`/private/tmp/p2r5-g7-output-audit.json`. Mechanical checks passing did not establish
that every option was wrong. The complete validator and sample findings below belong to this same attempt.
Repairs remain isolated; no second full build is claimed here.

## Integrated verification

All six tasks used isolated worktrees, with the sole deps/contracts task first and
alone. No dependency changed. Each code integration was rebased and tested sequentially.
Final main-tree checks passed lint, typecheck, 1,317 JavaScript tests (7 skipped),
invariant ownership, Ruff, and 1,169 Python tests (8 skipped, one optional live SimAlign
agreement measurement deselected after a network stall). Evidence:
`/private/tmp/p2r5-integrate-docs.log` with exit 0. An earlier local Python run passed
assertions but aborted at native-library teardown; its unchanged retry exited 0.

Core CI passed on the integrated source:
https://github.com/Blueturboguy07/freelingo/actions/runs/34734954579

Native CI passed all four jobs on the same source:
https://github.com/Blueturboguy07/freelingo/actions/runs/34734954572
Both downloaded artifacts contain one passing `p0-db-path` JUnit case and one inspected
Diagnostics screenshot, with zero failures/errors/skips. iOS used iPhone 17 / iOS 26.1 /
Xcode 26.2; Android used API 34 / x86_64 / google_apis. This proves existing fresh-install
database/cache smoke behavior, not P3 UI or a restart-persistence flow. Preserved at
`e2e/artifacts/fca9a57bb0203fc52084c97f09aec5d582bc8d6e/{ios,android}/`, with the detailed
native audit alongside them.

Pack CI completed RED:
https://github.com/Blueturboguy07/freelingo/actions/runs/34734954606
Its lint/test job passed 1,172 Python tests (6 skipped); the separate audio guard passed
35 tests (1 skipped, 1,142 deselected). G0–G9 succeeded and uploaded candidate artifact
10311725249 (82,848,236 compressed bytes), then validate-es failed with exit 4.
The CI candidate contains 5,763 exercises, 1,229 clips / 6,572,672 audio bytes and an
8,863,744-byte SQLite database. Its source SHA and run attempt were verified.

CI validation: **11/17 green, 6,517 blocking findings, 316 warnings**. Failed checks:
V2 71, V4 1,342, V6 27, V7 1,948, V9 3,128, V11 1. These counts describe findings,
not unique defective exercises. The unsigned candidate warning is expected before the
final signing stage; signing and the real final-loader gate were not reached.
Local validation was 12/17 green / 4,569 blocking / 316 warnings: V7 passed locally
because it saw the current generated manifest. CI checked out a stale 23-clip manifest
while all 1,229 current clips existed in the artifact. The transport defect accounts
for 1,929 missing-string joins and 19 old orphan entries. A held repair transfers and
verifies the exact current manifest with the candidate before validation.

## Local first-build measurements

These use preserved real G0-G3 inputs and a fresh G4-G9 rebuild; they corroborate the
implementation and do not replace a CI-built, signed final artifact.

| Measurement | Actual result |
| --- | --- |
| G4 selection | 1,584 slots: 1,084 corpus selections and 500 gaps; 12 reviewed corpus pairs quarantined |
| G5 | 10,269 raw candidates; 3,919 rejected; all 500 gaps filled; 60 old shifted rows rejected as stale ledger |
| G6 | 6,350 candidates / 6,356 answer surfaces checked; 106 rejects; zero slots without a survivor |
| G6 engines | LanguageTool 6.6 Spanish grammar/spellcheck and agent rubric; perplexity absent, explicitly `grammar_only` |
| G7 | 5,763 exercises; real SimAlign; 2,450 actual item keys each have at least two distinct punitive forms |
| Source joins | 3,366 corpus exercises, 1,340 authored, 1,057 explicit derived; zero orphan or duplicate exercise IDs |
| G8 | 1,229 Kokoro clips; 6,570,744 actual clip bytes |
| G9 | 8,863,744-byte SQLite database; 5,763 item IDs; unsigned local pack |
| Full validators | Local exit 4: 12/17 green, 4,569 blocking, 316 warnings |
| Frozen CI H1 sample | 101 wrong / 300 = 33.67%; 17 awkward = 5.67%; all accent scores null |

Build evidence: `/private/tmp/p2r5-local-build.log` and stage exit files, all 0.
Output audit: `/private/tmp/p2r5-g7-output-audit.json`, explicitly marked with the
blocking manual finding. The prior generated tail is preserved under
`/private/tmp/p2r5-prior-build-tail/`.

## Review and remaining gate evidence

The fresh immutable CI sample has **101 wrong / 300 (33.67%)**, 17 awkward (5.67%)
and 182 OK (60.67%). **PROVISIONAL (unreviewed by a paid native speaker)**.
All 300 exact IDs/content fingerprints join. The fixed seed is 20260913; sample SHA256
`f114eb4965a37dedd43141a6914e8074f0a1ba5a27e5cc48758bb07e29fab613`.
Three Codex agents inspected all rows and reconciled shape/answer-set judgments; no
new-source author reviewed its own authored row. All audio remained unlistened and all
accent scores null. `content/es/review/scores-method.md` records the method, criterion,
actual-grader witnesses and preserved original/adjudicated scores. Round-4's different
sample and 17% recorded rate remain historical and are not a progress comparison.

The same first attempt also exposed authored-source joins omitted from V4, historical
filled gaps retaining warning severity, and V9 counting format siblings as new sentence
selections. V2's hash ordering was also the actual G9 runtime order; the held repair
shares prerequisite ordering between packaging and validation, without moving exercises
between lessons. A read-only probe with corrected joins/order has zero V2/V9 blockers
but exposes 51 V3 recycling blockers and nine V4 blockers (seven missing-target unit
findings and two punctuation findings). That probe is diagnostic, not a regenerated
pack or a second gate attempt. V11's cross-section u10→u11 decrease remains real
(10.1152→9.3045, delta −0.8107); the B17 boundary rule remains unchanged.

Held repair work includes conservative cloze guards, punctuation normalization, explicit
unit-register policy, source/selection/order joins, verified audio manifest transport,
and independently reviewed glossary evidence. Conversation proposals still require
independent contextual review and G6 proof for all roles. Alignment alone cannot prove
standalone meanings. No second full attempt has run; all first-attempt findings are
being addressed in one reviewed fix batch under the unchanged gate.

The P2 gate still requires all 17 validators green, V1-V4 at 100%, at most six wrong
items in the complete current 300-item review, exact audio/attribution evidence,
a presentation-only rebuild identity comparison, and a CI-produced final artifact
that validates, embeds its fresh report/review, signs against the committed public key
and opens through the real core loader with every referenced audio file present.
Paid native review remains a release prerequisite. Mutation remains non-gating under
B7; local G7 guard mutation probes are evidence for those guards, not a whole-engine
mutation score. No P3 UI or new native parity is claimed by this report.
